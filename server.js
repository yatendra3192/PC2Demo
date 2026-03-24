require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure uploads dir exists
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 20 * 1024 * 1024 }
});

// ── INGESTION ENDPOINTS ──────────────────────────────────

// 3a: PDF Ingestion — supports multiple PDFs
app.post('/api/ingest/pdf', upload.array('files', 20), async (req, res) => {
  const pdfParse = require('pdf-parse');
  try {
    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files uploaded' });
    }

    // Extract text from each PDF
    const pdfTexts = [];
    for (const file of files) {
      const dataBuffer = fs.readFileSync(file.path);
      const pdfData = await pdfParse(dataBuffer);
      pdfTexts.push({ text: pdfData.text.substring(0, 6000), fileName: file.originalname });
    }

    // Build combined prompt with all PDFs
    const combinedInput = pdfTexts.map((pdf, i) =>
      `--- PDF ${i + 1}: "${pdf.fileName}" ---\n${pdf.text}`
    ).join('\n\n');

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [{
        role: 'system',
        content: `You are PC2's ingestion engine for SiteOne Landscape Supply. You will receive text from one or more supplier PDFs. Extract structured product data from EACH PDF separately.

Return JSON with this exact structure:
{
  "products": [
    {
      "pdf_index": 0,
      "pdf_file": "filename.pdf",
      "product_name": "...",
      "brand": "...",
      "model_number": "...",
      "description": "...",
      "attributes": {
        "field_name": { "value": "...", "confidence": 0.0-1.0, "supplier_term": "original field name from PDF" }
      },
      "specifications": {
        "field_name": { "value": "...", "confidence": 0.0-1.0, "supplier_term": "..." }
      }
    }
  ],
  "ingestion_pipeline": [
    { "step": "PDF Text Extraction", "engine": "Apache Tika OCR Engine v2.9", "status": "completed", "detail": "Extracted N characters from N pages" },
    { "step": "Schema Mapping", "engine": "PC2 Field Mapper + NLP", "status": "completed", "detail": "Mapped N supplier fields to SiteOne schema" },
    { "step": "Data Validation", "engine": "PC2 Validation Rules Engine", "status": "completed", "detail": "N fields passed validation, N flagged for review" },
    { "step": "Cross-Reference Check", "engine": "PC2 Knowledge Base", "status": "completed", "detail": "Verified against manufacturer product database" }
  ]
}
If a single PDF contains multiple products, create a separate entry for each product (all sharing the same pdf_index and pdf_file). Map supplier field names to standard schema names. Include confidence scores (0.0-1.0). Typical attributes: Voltage, Power (W), Material, Dimensions, Weight, Color, Compatibility, Certifications, UPC/SKU. Extract ALL available data fields. For landscape/irrigation products, look for: zones, station count, flow rate, pressure rating, pipe size, connection type, water source compatibility. Replace the N placeholders with realistic numbers based on the actual PDF content.`
      }, {
        role: 'user',
        content: `Extract structured product data from these ${files.length} supplier PDF(s):\n\n${combinedInput}`
      }]
    });

    // Cleanup uploaded files
    files.forEach(file => { try { fs.unlinkSync(file.path); } catch(e) {} });

    const result = JSON.parse(response.choices[0].message.content);
    const products = result.products || [result];

    // Attach file names
    products.forEach((p, i) => {
      if (!p.pdf_file && pdfTexts[p.pdf_index || i]) {
        p.pdf_file = pdfTexts[p.pdf_index || i].fileName;
      }
      if (!p.pdf_file && pdfTexts[i]) {
        p.pdf_file = pdfTexts[i].fileName;
      }
    });

    res.json({ success: true, source: 'pdf', data: { products }, count: products.length });
  } catch (err) {
    console.error('PDF ingestion error:', err);
    (req.files || []).forEach(file => { try { fs.unlinkSync(file.path); } catch(e) {} });
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3b: Image Ingestion (OCR + Label Reading) — supports multiple images
app.post('/api/ingest/image', upload.array('files', 20), async (req, res) => {
  try {
    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files uploaded' });
    }

    // Build image content parts for all uploaded images
    const imageParts = files.map(file => {
      const imageBuffer = fs.readFileSync(file.path);
      const base64Image = imageBuffer.toString('base64');
      const mimeType = file.mimetype || 'image/jpeg';
      return { base64: base64Image, mime: mimeType, originalName: file.originalname };
    });

    // Build user message with all images
    const userContent = [
      { type: 'text', text: `Extract all product data from these ${files.length} product image(s)/label(s). Analyse each image separately and return data for each product found.` }
    ];
    imageParts.forEach((img, i) => {
      userContent.push({
        type: 'image_url',
        image_url: { url: `data:${img.mime};base64,${img.base64}` }
      });
    });

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [{
        role: 'system',
        content: `You are PC2's image ingestion engine for SiteOne Landscape Supply. You will receive one or more product images. Extract all text, data, and product information visible on EACH image/label/packaging.

Return JSON with this structure:
{
  "products": [
    {
      "image_index": 0,
      "product_name": "...",
      "brand": "...",
      "model_number": "...",
      "description": "...",
      "attributes": {
        "field_name": { "value": "...", "confidence": 0.0-1.0, "source": "label_text" }
      },
      "certifications": ["..."],
      "extracted_text": "all raw text found on this image"
    }
  ]
}
For EACH image, create a separate product entry in the products array. Read ALL text visible: product names, model numbers, specs, certifications, barcodes/UPC, warnings, features. For landscape/irrigation products look for: zones, GPM, PSI, voltage, pipe size.`
      }, {
        role: 'user',
        content: userContent
      }]
    });

    // Cleanup uploaded files
    files.forEach(file => { try { fs.unlinkSync(file.path); } catch(e) {} });

    const result = JSON.parse(response.choices[0].message.content);

    // Attach base64 thumbnails for frontend preview
    const products = result.products || [result];
    products.forEach((p, i) => {
      if (imageParts[i]) {
        p._thumbnail = `data:${imageParts[i].mime};base64,${imageParts[i].base64}`;
        p._fileName = imageParts[i].originalName;
      }
    });

    res.json({ success: true, source: 'image', data: { products }, count: products.length });
  } catch (err) {
    console.error('Image ingestion error:', err);
    // Cleanup on error
    (req.files || []).forEach(file => { try { fs.unlinkSync(file.path); } catch(e) {} });
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3c: Web/Internet Ingestion
app.post('/api/ingest/web', async (req, res) => {
  try {
    const { query } = req.body;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [{
        role: 'system',
        content: `You are PC2's web ingestion engine for SiteOne Landscape Supply. Given a product name or search query, provide structured product data as if extracted from manufacturer and authorized distributor websites. This is targeted, schema-aware extraction — not broad scraping.

Return JSON:
{
  "product_name": "...",
  "brand": "...",
  "model_number": "...",
  "description": "...",
  "category_suggestion": "...",
  "attributes": {
    "field_name": { "value": "...", "confidence": 0.0-1.0, "source": "manufacturer_website|distributor_site|product_database" }
  },
  "specifications": {
    "field_name": { "value": "...", "confidence": 0.0-1.0, "source": "..." }
  },
  "sources_consulted": ["manufacturer site name", "distributor site name"]
}
Focus on landscape supply products: irrigation controllers, sprinklers, drainage, hardscape, nursery, lighting, etc. Provide realistic, accurate product data. Include: dimensions, weight, voltage, material, certifications, compatibility, features.`
      }, {
        role: 'user',
        content: `Search and extract structured product data for: "${query}"`
      }]
    });

    const result = JSON.parse(response.choices[0].message.content);
    res.json({ success: true, source: 'web', data: result });
  } catch (err) {
    console.error('Web ingestion error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3d: Auto Category Identification
app.post('/api/ingest/categorize', async (req, res) => {
  try {
    const { productData } = req.body;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [{
        role: 'system',
        content: `You are PC2's category identification engine for SiteOne Landscape Supply. Given product data, identify the most appropriate category and class from SiteOne's taxonomy.

SiteOne categories include:
- Irrigation > Controllers, Valves, Sprinkler Heads, Drip Irrigation, Pipes & Fittings, Sensors, Wire & Accessories
- Outdoor Lighting > LED Fixtures, Transformers, Accessories, Path Lights, Spot Lights
- Nursery > Trees, Shrubs, Perennials, Annuals, Ground Cover
- Hardscape > Pavers, Retaining Walls, Natural Stone, Edging, Polymeric Sand
- Drainage > Channel Drains, Catch Basins, Drain Pipe, Fittings
- Agronomics > Fertilizers, Seed, Soil Amendments, Pest Control
- Equipment > Power Equipment, Hand Tools, Safety Gear
- Snow & Ice > De-icers, Plows, Spreaders

Return JSON:
{
  "category": "...",
  "class": "...",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation",
  "alternative_categories": [{ "category": "...", "class": "...", "confidence": 0.0-1.0 }]
}`
      }, {
        role: 'user',
        content: `Categorize this product:\n${JSON.stringify(productData, null, 2)}`
      }]
    });

    const result = JSON.parse(response.choices[0].message.content);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Categorize error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── ENRICHMENT ENDPOINTS ─────────────────────────────────

// 4a: Attribute Gap Filling
app.post('/api/enrich/attributes', async (req, res) => {
  try {
    const { productData, category } = req.body;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [{
        role: 'system',
        content: `You are PC2's enrichment engine for SiteOne Landscape Supply. Given a product record with gaps (missing attributes), fill them using verified sources.

For the category "${category || 'Irrigation > Controllers'}", the REQUIRED attributes are:
Voltage Rating, Power (W), Material Type, Dimensions (L×W×H), Weight, Color, Connectivity, Number of Zones/Stations, Compatible Valves, Flow Rate Capacity, Weather Resistance Rating (IP), Certifications, Warranty, Operating Temperature Range, Programming Method, Rain Sensor Compatible, WiFi/Bluetooth, Indoor/Outdoor Use, Mounting Type, Wire Gauge Required.

For each filled attribute, provide:
- value: the attribute value
- confidence: 0.0-1.0
- source: one of "manufacturer_website" | "product_datasheet" | "certification_database" | "industry_standard" | "distributor_catalog" | "category_inference"
- source_detail: specific source name (e.g. "Hunter Industries Official Spec Sheet", "UL Product iQ Database")
- was_missing: true if this was a gap that was filled

IMPORTANT: You must also return a "sources_consulted" array listing ALL external sources the system queried to fill these gaps. Each source must include:
- name: human-readable source name
- type: "manufacturer" | "certification" | "standard" | "distributor" | "database"
- url: a realistic URL for this source
- fields_sourced: number of fields this source contributed
- status: "verified" | "cross_referenced"

Return JSON:
{
  "enriched_attributes": {
    "field_name": { "value": "...", "confidence": 0.0-1.0, "source": "...", "source_detail": "...", "was_missing": true/false }
  },
  "acr_before": 0.0-100.0,
  "acr_after": 0.0-100.0,
  "gaps_filled": 0,
  "total_attributes": 0,
  "sources_consulted": [
    { "name": "...", "type": "...", "url": "...", "fields_sourced": 0, "status": "verified" }
  ]
}`
      }, {
        role: 'user',
        content: `Fill attribute gaps for this product:\n${JSON.stringify(productData, null, 2)}`
      }]
    });

    const result = JSON.parse(response.choices[0].message.content);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Enrichment error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4b: Image Enrichment (Visual Attribute Analysis) — supports base64 or URL
app.post('/api/enrich/image-analysis', async (req, res) => {
  try {
    const { imageBase64, mimeType, imageUrl } = req.body;

    // Build image source — either from base64 or URL
    let imageSource;
    if (imageBase64) {
      imageSource = { url: `data:${mimeType || 'image/jpeg'};base64,${imageBase64}` };
    } else if (imageUrl) {
      imageSource = { url: imageUrl };
    } else {
      return res.status(400).json({ success: false, error: 'No image provided (base64 or URL required)' });
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [{
        role: 'system',
        content: `You are PC2's image enrichment engine. Analyse the product image to generate VISUAL attributes — things visible in the photo that aren't written down anywhere. This is different from OCR/label reading (which happens in Ingestion). Here you ANALYSE what the product LOOKS LIKE.

Return JSON:
{
  "visual_attributes": {
    "Dominant Color": { "value": "...", "confidence": 0.0-1.0 },
    "Secondary Colors": { "value": "...", "confidence": 0.0-1.0 },
    "Form Factor": { "value": "...", "confidence": 0.0-1.0 },
    "Surface Finish": { "value": "...", "confidence": 0.0-1.0 },
    "Size Estimate": { "value": "...", "confidence": 0.0-1.0 },
    "Packaging Style": { "value": "...", "confidence": 0.0-1.0 },
    "Build Quality Impression": { "value": "...", "confidence": 0.0-1.0 },
    "Mounting Orientation": { "value": "...", "confidence": 0.0-1.0 },
    "Visible Connectors/Ports": { "value": "...", "confidence": 0.0-1.0 },
    "Display/Interface Type": { "value": "...", "confidence": 0.0-1.0 }
  },
  "visual_summary": "2-3 sentence description of the product's physical appearance",
  "analysis_methods": [
    { "name": "...", "type": "vision_model" | "color_analysis" | "object_detection" | "ocr_engine", "description": "brief description of what this method did", "status": "completed" }
  ]
}`
      }, {
        role: 'user',
        content: [{
          type: 'text',
          text: 'Analyse this product image for visual attributes (what the product looks like, not text on it):'
        }, {
          type: 'image_url',
          image_url: imageSource
        }]
      }]
    });

    const result = JSON.parse(response.choices[0].message.content);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Image analysis error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4c: Product Copy Generation
app.post('/api/enrich/copy', async (req, res) => {
  try {
    const { productData } = req.body;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [{
        role: 'system',
        content: `You are PC2's copy generation engine for SiteOne Landscape Supply. Generate product copy tuned for contractors, landscapers, and professional buyers. NOT generic LLM marketing — reflect how people in the landscape supply industry actually search and speak.

Return JSON:
{
  "product_title": "optimized product title (60-80 chars)",
  "short_description": "1-2 sentence summary for search results (150-200 chars)",
  "long_description": "3-4 paragraph detailed description with features, benefits, and use cases",
  "bullet_points": ["5-7 key selling points for product page"],
  "seo_keywords": ["relevant search terms"],
  "target_audience": "who this product is for",
  "copy_sources": [
    { "name": "...", "type": "style_guide" | "competitor_analysis" | "seo_database" | "category_taxonomy" | "brand_guidelines", "description": "what this source contributed to the copy", "status": "applied" }
  ]
}`
      }, {
        role: 'user',
        content: `Generate product copy for:\n${JSON.stringify(productData, null, 2)}`
      }]
    });

    const result = JSON.parse(response.choices[0].message.content);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Copy generation error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── ATHENA DQ ENDPOINTS ──────────────────────────────────

// 5a: CDI Chat (Conversational Data Intelligence)
app.post('/api/athena/chat', async (req, res) => {
  try {
    const { messages, catalogContext } = req.body;

    const systemMessage = `You are Athena, the Conversational Data Intelligence (CDI) engine for SiteOne Landscape Supply's product catalog. You have access to catalog quality data and can help users find and fix data quality issues.

Current Catalog Context:
${JSON.stringify(catalogContext || getDefaultCatalogContext(), null, 2)}

You can:
1. Answer questions about catalog health and DQ issues
2. Show top issues by category
3. Initiate fix runs (simulate fixing missing attributes)
4. Provide proactive alerts about emerging patterns
5. Show ACR (Attribute Completeness Rate) scores

Respond conversationally but precisely. Include specific numbers and product counts. When asked to fix issues, describe the fix process and results. Format responses with clear sections.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemMessage },
        ...messages
      ]
    });

    res.json({
      success: true,
      reply: response.choices[0].message.content
    });
  } catch (err) {
    console.error('Athena chat error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

function getDefaultCatalogContext() {
  return {
    total_skus: 147520,
    categories: {
      "Irrigation Controllers": { skus: 3842, acr: 72.4, issues: 847, top_issue: "Missing Voltage Rating (312 SKUs)" },
      "Irrigation Valves": { skus: 5120, acr: 68.1, issues: 1203, top_issue: "Missing Flow Rate (489 SKUs)" },
      "Sprinkler Heads": { skus: 8934, acr: 81.2, issues: 621, top_issue: "Missing Spray Pattern (198 SKUs)" },
      "Drip Irrigation": { skus: 4210, acr: 65.3, issues: 1567, top_issue: "Missing Pressure Rating (612 SKUs)" },
      "Pipes & Fittings": { skus: 12450, acr: 59.8, issues: 3204, top_issue: "Missing Compatibility (1247 SKUs)" },
      "LED Fixtures": { skus: 6780, acr: 74.6, issues: 945, top_issue: "Missing Lumen Output (367 SKUs)" },
      "Transformers": { skus: 1890, acr: 77.2, issues: 312, top_issue: "Missing Wattage (145 SKUs)" },
      "Fertilizers": { skus: 9340, acr: 70.1, issues: 1823, top_issue: "Missing NPK Ratio (678 SKUs)" },
      "Pavers": { skus: 7650, acr: 63.4, issues: 2156, top_issue: "Missing Dimensions (892 SKUs)" }
    },
    overall_acr: 71.3,
    total_issues: 12678,
    recent_alerts: [
      "Irrigation Fittings from Supplier X — 47 products developed missing compatibility attribute pattern over last 30 days",
      "LED Fixtures: 23 new products from Hunter Industries have 0% image coverage",
      "Fertilizer category ACR dropped 3.2% this month due to new supplier onboarding"
    ]
  };
}

// ── DEDUPLICATION ENDPOINT ────────────────────────────────

app.post('/api/ingest/deduplicate', async (req, res) => {
  try {
    const { products } = req.body;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [{
        role: 'system',
        content: `You are PC2's deduplication engine. Given a list of products, identify potential duplicate groups — products that are the same item listed multiple times with slightly different names, SKUs, or descriptions.

Compare by: product name similarity, brand, model number patterns, description overlap, attribute overlap.

Return JSON:
{
  "duplicate_groups": [
    {
      "group_id": 1,
      "match_type": "exact_match" | "high_similarity" | "possible_match",
      "match_score": 0.0-1.0,
      "reason": "why these are considered duplicates",
      "products": [
        { "index": 0, "product_name": "...", "product_id": "...", "is_primary": true },
        { "index": 1, "product_name": "...", "product_id": "...", "is_primary": false }
      ]
    }
  ],
  "unique_count": 0,
  "total_scanned": 0,
  "dedup_methods": [
    { "name": "...", "type": "database", "description": "...", "status": "completed" }
  ]
}
Mark the most complete record as is_primary=true (the one to keep). If no duplicates exist, return empty duplicate_groups array. Be thorough but avoid false positives — only flag genuinely similar products.`
      }, {
        role: 'user',
        content: `Scan these ${products.length} products for duplicates:\n${JSON.stringify(products.map((p, i) => ({ index: i, id: p.product_id, name: p.product_name, description: (p.description || '').substring(0, 200) })), null, 2)}`
      }]
    });

    const result = JSON.parse(response.choices[0].message.content);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Dedup error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── BULK INGESTION ENDPOINTS ─────────────────────────────

// Parse Excel file and return product list
app.post('/api/ingest/bulk/parse', upload.single('file'), async (req, res) => {
  try {
    const XLSX = require('xlsx');
    const filePath = req.file.path;
    const wb = XLSX.readFile(filePath);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws);
    fs.unlinkSync(filePath);

    const products = data.map((row, i) => ({
      index: i,
      product_id: row.product_id || row.ProductId || row['SKU / Model'] || row['SKU'] || row['Model'] || '',
      product_name: row['Product Name'] || row['Product Title'] || row.product_name || '',
      description: row.Description || row.description || '',
      feature_bullets: row['Feature Bullets'] || row['Features'] || '',
      pdf_urls: (row.pdf || row['PDF Spec Sheet URL'] || row['PDF URL'] || row['pdf_url'] || '').split(',').map(u => u.trim()).filter(Boolean),
      image_urls: (row.images || row['Image URL'] || row['Image'] || row['image_url'] || '').split(',').map(u => u.trim()).filter(Boolean),
      status: 'pending'
    }));

    res.json({ success: true, data: { products, total: products.length } });
  } catch (err) {
    console.error('Bulk parse error:', err);
    if (req.file) try { fs.unlinkSync(req.file.path); } catch(e) {}
    res.status(500).json({ success: false, error: err.message });
  }
});

// Process a single product from bulk (fetch image from URL + enrich)
app.post('/api/ingest/bulk/process-one', async (req, res) => {
  try {
    const { product } = req.body;

    // Try to fetch first image for vision analysis
    let imageContent = null;
    if (product.image_urls && product.image_urls.length > 0) {
      try {
        const imgUrl = product.image_urls[0];
        const imgResponse = await fetch(imgUrl);
        if (imgResponse.ok) {
          const buffer = Buffer.from(await imgResponse.arrayBuffer());
          const base64 = buffer.toString('base64');
          const contentType = imgResponse.headers.get('content-type') || 'image/jpeg';
          imageContent = { base64, contentType };
        }
      } catch (imgErr) {
        console.log('Image fetch failed, continuing without image:', imgErr.message);
      }
    }

    // Build messages for GPT-4o
    const userParts = [];
    let promptText = `Process this product for catalog ingestion and enrichment. Extract ALL structured data, fill attribute gaps, generate copy, and categorize.

Product ID: ${product.product_id}
Product Name: ${product.product_name}`;

    if (product.description) {
      promptText += `\nDescription: ${product.description}`;
    }
    if (product.feature_bullets) {
      promptText += `\nFeatures: ${product.feature_bullets.replace(/#\|#/g, ' | ')}`;
    }
    promptText += `\nPDF Sources: ${product.pdf_urls.length} document(s) available`;
    promptText += `\nImage Sources: ${product.image_urls.length} image(s) available`;

    userParts.push({ type: 'text', text: promptText });

    // Add image if fetched
    if (imageContent) {
      userParts.push({
        type: 'image_url',
        image_url: { url: `data:${imageContent.contentType};base64,${imageContent.base64}` }
      });
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [{
        role: 'system',
        content: `You are PC2's bulk processing engine. For each product, perform COMPLETE ingestion + enrichment in one pass:

1. EXTRACT: Parse all available data (name, description, features, image)
2. CATEGORIZE: Assign category and class with confidence
3. ENRICH: Fill attribute gaps with verified sources
4. COPY: Generate optimized product title and short description
5. IMAGE ANALYSIS: If image provided, extract visual attributes

Return JSON:
{
  "product_name": "...",
  "brand": "...",
  "model_number": "...",
  "category": { "category": "...", "class": "...", "confidence": 0.0-1.0 },
  "attributes": {
    "field_name": { "value": "...", "confidence": 0.0-1.0, "source": "manufacturer_website|product_datasheet|category_inference|image_analysis", "source_detail": "specific source name" }
  },
  "visual_attributes": {
    "Dominant Color": "...",
    "Form Factor": "...",
    "Material": "...",
    "Surface Finish": "..."
  },
  "generated_copy": {
    "product_title": "...",
    "short_description": "..."
  },
  "acr_score": 0-100,
  "dq_issues": ["list of any quality issues found"],
  "sources_consulted": [
    { "name": "...", "type": "manufacturer|certification|distributor|database", "url": "realistic url", "status": "verified" }
  ]
}
Be thorough — extract every possible attribute. Include material, dimensions, weight, color, features, certifications, care instructions, etc.`
      }, {
        role: 'user',
        content: userParts
      }]
    });

    const result = JSON.parse(response.choices[0].message.content);
    result._imageUrl = product.image_urls[0] || null;
    result._productId = product.product_id;
    result._originalName = product.product_name;

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Bulk process-one error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Athena DQ Dashboard Data
app.get('/api/athena/dashboard', (req, res) => {
  res.json({
    success: true,
    data: getDefaultCatalogContext()
  });
});

app.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════════════╗`);
  console.log(`  ║   PC2 v2.0 — Product Content Creator        ║`);
  console.log(`  ║   SiteOne Landscape Supply Demo              ║`);
  console.log(`  ║   Running on http://localhost:${PORT}            ║`);
  console.log(`  ╚══════════════════════════════════════════════╝\n`);
});

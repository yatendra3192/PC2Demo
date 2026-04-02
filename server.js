require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// ── AI PROVIDER WRAPPER (OpenAI → Gemini fallback) ──────
const GEMINI_API_KEY = process.env.GOOGLE_AI_API_KEY;
const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

function convertToGeminiFormat(messages) {
  let systemText = '';
  const contents = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemText += (systemText ? '\n\n' : '') + msg.content;
      continue;
    }

    // Handle user messages — can be string or array (vision)
    const parts = [];
    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text') {
          parts.push({ text: part.text });
        } else if (part.type === 'image_url') {
          const url = part.image_url.url || part.image_url;
          if (url.startsWith('data:')) {
            // data:image/jpeg;base64,XXXX
            const match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
            }
          } else {
            // External URL — Gemini supports fileUri for some, but safer to describe it
            parts.push({ text: `[Image URL: ${url}]` });
          }
        }
      }
    }

    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts
    });
  }

  return { systemText, contents };
}

// Convert old chat.completions messages → new Responses API input format
function convertToResponsesInput(messages) {
  let instructions = '';
  const input = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      instructions += (instructions ? '\n\n' : '') + msg.content;
      continue;
    }

    // Build content parts for this message
    if (typeof msg.content === 'string') {
      input.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      // Vision / multi-part content → convert to new format
      const parts = [];
      for (const part of msg.content) {
        if (part.type === 'text') {
          parts.push({ type: 'input_text', text: part.text });
        } else if (part.type === 'image_url') {
          const url = part.image_url.url || part.image_url;
          parts.push({ type: 'input_image', image_url: url });
        }
      }
      input.push({ role: msg.role, content: parts });
    }
  }

  return { instructions, input };
}

async function callAI(params) {
  // Try OpenAI new Responses API (gpt-5.4) first
  try {
    const { instructions, input } = convertToResponsesInput(params.messages);

    const responsesParams = {
      model: 'gpt-4.1',
      input: input,
    };

    if (instructions) {
      responsesParams.instructions = instructions;
    }

    // JSON mode
    if (params.response_format && params.response_format.type === 'json_object') {
      responsesParams.text = { format: { type: 'json_object' } };
    }

    const response = await openai.responses.create(responsesParams);

    // Return in the old format so downstream code doesn't break
    return {
      choices: [{ message: { content: response.output_text || '{}' } }]
    };
  } catch (openaiErr) {
    console.log(`OpenAI failed (${openaiErr.message}), falling back to Gemini...`);
  }

  // Fallback to Gemini
  if (!GEMINI_API_KEY) {
    throw new Error('Both OpenAI and Gemini failed — no GOOGLE_AI_API_KEY configured');
  }

  const { systemText, contents } = convertToGeminiFormat(params.messages);

  const geminiBody = {
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 8192,
    }
  };

  // JSON mode
  if (params.response_format && params.response_format.type === 'json_object') {
    geminiBody.generationConfig.responseMimeType = 'application/json';
  }

  // System instruction
  if (systemText) {
    geminiBody.systemInstruction = { parts: [{ text: systemText }] };
  }

  const geminiRes = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(geminiBody)
  });

  if (!geminiRes.ok) {
    const errText = await geminiRes.text();
    throw new Error(`Gemini API error ${geminiRes.status}: ${errText}`);
  }

  const geminiData = await geminiRes.json();
  const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

  // Return in OpenAI-compatible format
  return {
    choices: [{ message: { content: text } }]
  };
}

// ── SAFE JSON PARSER (handles LLM quirks) ───────────────
function safeParseJSON(text) {
  try { return JSON.parse(text); }
  catch (e) {
    // Try to extract JSON from markdown code blocks
    const match = (text || '').match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) try { return JSON.parse(match[1]); } catch(e2) {}
    throw new Error('Invalid JSON from AI response: ' + (text || '').substring(0, 200));
  }
}

// ── CATEGORY TEMPLATES ──────────────────────────────────
const CATEGORY_TEMPLATES = {
  'Drip Irrigation': {
    required: ['Flow Rate', 'Spacing', 'Pressure Range', 'Tubing Diameter', 'Material', 'UV Resistant', 'Color', 'Connection Type', 'Emitter Type', 'Max Run Length'],
    optional: ['GPH per Emitter', 'Wall Thickness', 'Filter Required', 'Certifications', 'Operating Temperature']
  },
  'Spray Heads': {
    required: ['Pop-up Height', 'Arc', 'Radius', 'Nozzle Type', 'Inlet Size', 'Flow Rate', 'Pressure Range', 'Material', 'Pattern'],
    optional: ['Check Valve', 'Wiper Seal', 'Spring Retraction', 'Color', 'Certifications']
  },
  'Controllers': {
    required: ['Zones', 'Voltage', 'WiFi Enabled', 'Programming Method', 'Weather Resistance', 'Indoor/Outdoor', 'Mounting Type', 'Power Source'],
    optional: ['Rain Sensor Compatible', 'Bluetooth', 'Flow Sensing', 'Hot Swap Module', 'Display Type', 'Wire Gauge', 'Certifications']
  },
  'Valves': {
    required: ['Size', 'Voltage', 'Flow Rate', 'Pressure Range', 'Connection Type', 'Normally Open/Closed', 'Material'],
    optional: ['Manual Override', 'Flow Control', 'DC Latching', 'Certifications', 'Operating Temperature']
  },
  'Sensors': {
    required: ['Sensor Type', 'Compatibility', 'Mounting Style', 'Power Source', 'Signal Type', 'Weather Resistance'],
    optional: ['Wireless Range', 'Battery Life', 'Certifications', 'Operating Temperature']
  },
  'Filters': {
    required: ['Filter Type', 'Mesh Size', 'Flow Rate', 'Inlet/Outlet Size', 'Max Pressure', 'Material'],
    optional: ['Self-Cleaning', 'Flush Valve', 'Screen Material', 'Certifications']
  },
  'Accessories': {
    required: ['Accessory Type', 'Compatibility', 'Material', 'Size'],
    optional: ['Color', 'UV Resistant', 'Certifications']
  },
  'Nozzle Kits': {
    required: ['Nozzle Type', 'Arc Options', 'Radius Range', 'Pressure Range', 'Inlet Thread', 'Color Coding'],
    optional: ['Flow Rate', 'Pieces Included', 'Compatible Heads', 'Certifications']
  },
  'Sprinkler Heads': {
    required: ['Pop-up Height', 'Arc', 'Radius', 'Nozzle Type', 'Inlet Size', 'Flow Rate', 'Pressure Range', 'Material', 'Drive Type'],
    optional: ['Check Valve', 'Wiper Seal', 'Pattern', 'Color', 'Certifications']
  },
  'Pipes & Fittings': {
    required: ['Size', 'Material', 'Pressure Rating', 'Connection Type', 'Length'],
    optional: ['Schedule', 'Color', 'NSF Rated', 'Certifications']
  },
  'LED Fixtures': {
    required: ['Wattage', 'Lumen Output', 'Color Temperature', 'Voltage', 'Material', 'IP Rating', 'Beam Angle'],
    optional: ['Dimmable', 'Finish', 'Mounting Type', 'Certifications']
  },
  'Transformers': {
    required: ['Wattage', 'Input Voltage', 'Output Voltage', 'Material', 'Timer Type', 'Outdoor Rated'],
    optional: ['Number of Circuits', 'Photocell', 'Certifications']
  }
};

// Ensure uploads dir exists
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
if (!process.env.OPENAI_API_KEY) console.warn('WARNING: OPENAI_API_KEY not set — will rely on Gemini fallback');
if (!process.env.GOOGLE_AI_API_KEY) console.warn('WARNING: GOOGLE_AI_API_KEY not set — Gemini fallback disabled');

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

    const response = await callAI({
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
    files.forEach(file => { try { fs.unlinkSync(file.path); } catch(e) { console.warn('Cleanup failed:', e.message); } });

    const result = safeParseJSON(response.choices[0].message.content);
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
    (req.files || []).forEach(file => { try { fs.unlinkSync(file.path); } catch(e) { console.warn('Cleanup failed:', e.message); } });
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

    const response = await callAI({
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
    files.forEach(file => { try { fs.unlinkSync(file.path); } catch(e) { console.warn('Cleanup failed:', e.message); } });

    const result = safeParseJSON(response.choices[0].message.content);

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
    (req.files || []).forEach(file => { try { fs.unlinkSync(file.path); } catch(e) { console.warn('Cleanup failed:', e.message); } });
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3c: Web/Internet Ingestion
app.post('/api/ingest/web', async (req, res) => {
  try {
    const { query } = req.body;

    const response = await callAI({
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

    const result = safeParseJSON(response.choices[0].message.content);
    res.json({ success: true, source: 'web', data: result });
  } catch (err) {
    console.error('Web ingestion error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3d: Auto Category Identification (uses KB taxonomy)
app.post('/api/ingest/categorize', async (req, res) => {
  try {
    const { productData } = req.body;

    // Build taxonomy from KB
    let taxonomySample = '';
    try {
      const kb = loadKB();
      // Send a representative sample of categories (first 100 leaf paths)
      taxonomySample = kb.categories.slice(0, 100).map(c => `${c.path} [ID:${c.classId}]`).join('\n');
    } catch (e) {
      taxonomySample = 'Irrigation>Controllers>Residential, Irrigation>Valves>Inline, Irrigation>Drip Irrigation>Emitter Tubing, etc.';
    }

    const response = await callAI({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [{
        role: 'system',
        content: `You are PC2's category identification engine for SiteOne Landscape Supply. Given product data, identify the most appropriate category and class from SiteOne's Knowledge Base taxonomy.

Match to the EXACT class paths below. Use the closest match.

=== SiteOne KB Category Taxonomy (sample) ===
${taxonomySample}

Return JSON:
{
  "category": "full path e.g. Irrigation>Drip Irrigation>Emitter Tubing",
  "class": "leaf class name",
  "classId": class ID number,
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation",
  "alternative_categories": [{ "category": "...", "class": "...", "classId": 0, "confidence": 0.0-1.0 }]
}`
      }, {
        role: 'user',
        content: `Categorize this product:\n${JSON.stringify(productData, null, 2)}`
      }]
    });

    const result = safeParseJSON(response.choices[0].message.content);
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
    const { productData, category, classId } = req.body;

    // Look up real required attributes from KB based on category/classId
    let requiredAttrList = '';
    try {
      const kb = loadKB();
      let kbAttrs = [];
      if (classId) {
        kbAttrs = kb.attributes.filter(a => String(a.classId) === String(classId));
      }
      if (kbAttrs.length === 0 && category) {
        const catParts = category.split('>').map(s => s.trim());
        const matchCat = kb.categories.find(c => catParts.some(p => c.path.toLowerCase().includes(p.toLowerCase())));
        if (matchCat) kbAttrs = kb.attributes.filter(a => String(a.classId) === String(matchCat.classId));
      }
      if (kbAttrs.length > 0) {
        const mandatory = kbAttrs.filter(a => a.mandatory === 'Yes').map(a => a.name);
        requiredAttrList = mandatory.join(', ');
      }
    } catch (e) {}

    if (!requiredAttrList) {
      requiredAttrList = 'Material Type, Dimensions, Weight, Color, Certifications, Warranty, Operating Temperature Range';
    }

    const response = await callAI({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [{
        role: 'system',
        content: `You are PC2's enrichment engine for SiteOne Landscape Supply. Given a product record with gaps (missing attributes), fill them using verified sources.

For the category "${category || 'General'}", the REQUIRED attributes from the Knowledge Base are:
${requiredAttrList}

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

    const result = safeParseJSON(response.choices[0].message.content);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Enrichment error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4b-tag: Image Type Classification + Visual Analysis (batch)
app.post('/api/enrich/image-tag', async (req, res) => {
  try {
    const { imageUrls, productName } = req.body;
    if (!imageUrls || imageUrls.length === 0) {
      return res.status(400).json({ success: false, error: 'No image URLs provided' });
    }

    // Build vision content with all images
    const userContent = [
      { type: 'text', text: `Classify each product image by type and extract visual attributes.

Product: ${productName || 'Unknown'}

IMAGE TYPES (pick the best match for each image):
Lifestyle, Hero, Side View, Close-up, Room Set, Feature Callout, Dimension Diagram, Overhead View, Color Swatch, Back View, Packaging, In-Use, Assembly Instruction, Certification, Component, Comparison, Scale Reference

For each image, return:
- image_type: one of the types above
- confidence: 0.0-1.0
- visual_notes: brief description of what's visible

Also extract overall visual attributes from ALL images combined.

Return JSON:
{
  "images": [
    { "index": 0, "url": "...", "image_type": "...", "confidence": 0.0-1.0, "visual_notes": "..." }
  ],
  "visual_attributes": {
    "Dominant Color": { "value": "...", "confidence": 0.0-1.0 },
    "Form Factor": { "value": "...", "confidence": 0.0-1.0 },
    "Material": { "value": "...", "confidence": 0.0-1.0 },
    "Surface Finish": { "value": "...", "confidence": 0.0-1.0 }
  },
  "visual_summary": "2-3 sentence description"
}` }
    ];

    imageUrls.forEach((url, i) => {
      userContent.push({ type: 'image_url', image_url: { url } });
    });

    const response = await callAI({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [{
        role: 'system',
        content: 'You are a product image classification and visual analysis engine. Classify each image by its type and extract visual attributes.'
      }, {
        role: 'user',
        content: userContent
      }]
    });

    const result = safeParseJSON(response.choices[0].message.content);

    // Select first image of each priority type: Hero, Feature Callout, Dimension Diagram
    const TARGET_TYPES = ['Hero', 'Feature Callout', 'Dimension Diagram'];
    const selected = [];
    const images = result.images || [];
    TARGET_TYPES.forEach(targetType => {
      const match = images.find(img =>
        (img.image_type || '').toLowerCase() === targetType.toLowerCase() &&
        !selected.some(s => s.index === img.index)
      );
      if (match) {
        selected.push({ ...match, url: imageUrls[match.index !== undefined ? match.index : 0] || '' });
      }
    });
    // If we don't have 3, fill with remaining best-confidence unselected images
    if (selected.length < 3) {
      const remaining = images
        .filter(img => !selected.some(s => s.index === img.index))
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
      while (selected.length < 3 && remaining.length > 0) {
        const next = remaining.shift();
        selected.push({ ...next, url: imageUrls[next.index !== undefined ? next.index : 0] || '' });
      }
    }

    result.selected = selected;
    result.total_images = imageUrls.length;

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Image tag error:', err);
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

    const response = await callAI({
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

    const result = safeParseJSON(response.choices[0].message.content);
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

    const response = await callAI({
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

    const result = safeParseJSON(response.choices[0].message.content);
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

    const response = await callAI({
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

    const response = await callAI({
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

    const result = safeParseJSON(response.choices[0].message.content);
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
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }
    const filePath = req.file.path;

    // Validate MIME type — must be an Excel file
    const allowedMimeTypes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'application/octet-stream'
    ];
    const allowedExtensions = ['.xlsx', '.xls', '.csv'];
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!allowedMimeTypes.includes(req.file.mimetype) && !allowedExtensions.includes(ext)) {
      try { fs.unlinkSync(filePath); } catch(e) { console.warn('Cleanup failed:', e.message); }
      return res.status(400).json({ success: false, error: `Invalid file type "${req.file.mimetype}". Please upload an Excel file (.xlsx, .xls) or CSV.` });
    }

    const wb = XLSX.readFile(filePath);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws);
    fs.unlinkSync(filePath);

    // Validate that the spreadsheet has data and recognizable columns
    if (!data || data.length === 0) {
      return res.status(400).json({ success: false, error: 'The uploaded spreadsheet has no data rows. Please ensure the file contains at least one product row.' });
    }
    const columnNames = Object.keys(data[0]);
    const recognizedColumns = ['SKU', 'Product Name', 'Product Title', 'product_name'];
    const hasRecognizedColumn = columnNames.some(col => recognizedColumns.includes(col));
    if (!hasRecognizedColumn) {
      return res.status(400).json({
        success: false,
        error: `No recognizable columns found. Expected at least one of: ${recognizedColumns.join(', ')}. Found columns: ${columnNames.join(', ')}`
      });
    }

    const products = data.map((row, i) => ({
      index: i,
      product_id: row.product_id || row.ProductId || row['SKU / Model'] || row['SKU'] || row['Model'] || '',
      product_name: row['Product Name'] || row['Product Title'] || row.product_name || '',
      description: row.Description || row.description || '',
      feature_bullets: row['Feature Bullets'] || row['Features'] || '',
      pdf_urls: (row.pdf || row['PDF Spec Sheet URL'] || row['PDF URL'] || row['pdf_url'] || '').split(',').map(u => u.trim()).filter(Boolean),
      image_urls: (row.images || row['Image URL'] || row['Image'] || row['image_url'] || '').split(',').map(u => u.trim()).filter(Boolean),
      pdp_url: row['PDP Page Link'] || row['PDP URL'] || row['pdp_url'] || row['Product Page'] || '',
      status: 'pending'
    }));

    res.json({ success: true, data: { products, total: products.length } });
  } catch (err) {
    console.error('Bulk parse error:', err);
    if (req.file) try { fs.unlinkSync(req.file.path); } catch(e) { console.warn('Cleanup failed:', e.message); }
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

    const response = await callAI({
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

    const result = safeParseJSON(response.choices[0].message.content);
    result._imageUrl = (product.image_urls && product.image_urls[0]) || null;
    result._productId = product.product_id;
    result._originalName = product.product_name;

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Bulk process-one error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── BULK WIZARD ENDPOINTS ─────────────────────────────────

// 1c: Batch categorize all products in one GPT-4o call
app.post('/api/ingest/bulk/categorize-batch', async (req, res) => {
  try {
    const { products } = req.body;
    if (!products || products.length === 0) {
      return res.status(400).json({ success: false, error: 'No products provided' });
    }

    // Build real category taxonomy from KB
    let categoryTaxonomy = '';
    try {
      const kb = loadKB();
      // Group by top-level category
      const grouped = {};
      kb.categories.forEach(c => {
        const parts = c.path.split('>').map(s => s.trim());
        const top = parts[0] || 'Other';
        if (!grouped[top]) grouped[top] = [];
        grouped[top].push({ path: c.path, classId: c.classId });
      });
      // Build compact list (limit to keep prompt reasonable)
      const lines = [];
      Object.entries(grouped).forEach(([top, classes]) => {
        const classNames = classes.map(c => {
          const parts = c.path.split('>').map(s => s.trim());
          return `${parts.slice(1).join(' > ')} [ID:${c.classId}]`;
        });
        lines.push(`${top}:\n  ${classNames.join('\n  ')}`);
      });
      categoryTaxonomy = lines.join('\n');
    } catch (kbErr) {
      // Fallback to basic categories if KB not available
      categoryTaxonomy = `Irrigation: Controllers, Valves, Sprinkler Heads, Spray Heads, Drip Irrigation, Pipes & Fittings, Sensors, Nozzle Kits, Filters, Accessories
Outdoor Lighting: LED Fixtures, Transformers, Path Lights, Spot Lights
Nursery: Trees, Shrubs, Perennials, Annuals
Hardscape: Pavers, Retaining Walls, Natural Stone, Edging
Drainage: Channel Drains, Catch Basins, Drain Pipe
Agronomics: Fertilizers, Seed, Soil Amendments, Pest Control
Equipment: Power Equipment, Hand Tools, Safety Gear`;
    }

    const productList = products.map((p, i) => `${i + 1}. SKU: ${p.product_id} | Name: ${p.product_name} | Description: ${(p.description || '').substring(0, 200)}`).join('\n');

    const response = await callAI({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [{
        role: 'system',
        content: `You are PC2's batch category identification engine for SiteOne Landscape Supply. Given a list of products, identify the EXACT category class from SiteOne's Knowledge Base taxonomy below.

IMPORTANT: You MUST match products to one of the EXACT class paths and class IDs listed below. Do NOT invent categories — use the closest match from this taxonomy.

=== SiteOne Category Taxonomy (${(() => { try { return loadKB().stats.totalCategories; } catch(e) { return '500+'; } })() } classes) ===
${categoryTaxonomy}

Return JSON:
{
  "categories": [
    {
      "index": 0,
      "sku": "...",
      "product_name": "...",
      "category": "full path e.g. Irrigation>Drip Irrigation>Emitter Tubing",
      "class": "leaf class name",
      "classId": class ID number from taxonomy,
      "confidence": 0.0-1.0,
      "reasoning": "brief reason for this classification"
    }
  ]
}`
      }, {
        role: 'user',
        content: `Categorize these ${products.length} products into SiteOne's taxonomy:\n${productList}`
      }]
    });

    const result = safeParseJSON(response.choices[0].message.content);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Batch categorize error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 1d: Get templates for categories (KB lookup — zero API calls)
app.post('/api/ingest/bulk/get-templates', (req, res) => {
  try {
    const { products } = req.body;
    if (!products || products.length === 0) {
      return res.status(400).json({ success: false, error: 'No products provided' });
    }

    let kb;
    try { kb = loadKB(); } catch (e) { kb = null; }

    const templates = products.map(p => {
      const cls = p.class || '';
      const classId = p.classId || '';

      // Try KB lookup first — find attributes for this classId or matching class name
      let required = [];
      let optional = [];
      let kbSource = false;

      if (kb) {
        // Try by classId
        let kbAttrs = [];
        if (classId) {
          kbAttrs = kb.attributes.filter(a => String(a.classId) === String(classId));
        }
        // Fallback: try matching by class path
        if (kbAttrs.length === 0 && cls) {
          const matchingCat = kb.categories.find(c =>
            c.path.toLowerCase().includes(cls.toLowerCase())
          );
          if (matchingCat) {
            kbAttrs = kb.attributes.filter(a => String(a.classId) === String(matchingCat.classId));
          }
        }

        if (kbAttrs.length > 0) {
          required = kbAttrs.filter(a => a.mandatory === 'Yes').map(a => a.name);
          optional = kbAttrs.filter(a => a.mandatory !== 'Yes').map(a => a.name);
          kbSource = true;
        }
      }

      // Fallback to hardcoded CATEGORY_TEMPLATES if KB had no match
      if (!kbSource) {
        const template = CATEGORY_TEMPLATES[cls] || CATEGORY_TEMPLATES['Accessories'] || { required: [], optional: [] };
        required = template.required;
        optional = template.optional;
      }

      return {
        index: p.index,
        sku: p.sku || p.product_id,
        product_name: p.product_name,
        category: p.category,
        class: cls,
        classId: classId,
        source: kbSource ? 'Knowledge Base' : 'Default Template',
        template: {
          required,
          optional
        }
      };
    });

    res.json({ success: true, data: { templates } });
  } catch (err) {
    console.error('Get templates error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── EXTRACTION CACHE (saves LLM costs on re-runs) ────────
const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

function getCacheKey(product) {
  // Key by SKU — same SKU = same product
  const sku = String(product.product_id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return sku || null;
}

function readCache(key) {
  if (!key) return null;
  const file = path.join(CACHE_DIR, `${key}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(`Cache HIT for ${key}`);
    return data;
  } catch (e) { return null; }
}

function writeCache(key, data) {
  if (!key) return;
  try {
    fs.writeFileSync(path.join(CACHE_DIR, `${key}.json`), JSON.stringify(data, null, 2));
    console.log(`Cache WRITE for ${key}`);
  } catch (e) { console.warn('Cache write failed:', e.message); }
}

// 1e: Extract data for a single product (PDF + image + GPT-4o) — with cache
app.post('/api/ingest/bulk/extract-data', async (req, res) => {
  try {
    const { product, template } = req.body;
    if (!product) {
      return res.status(400).json({ success: false, error: 'No product provided' });
    }

    // Check cache first
    const cacheKey = getCacheKey(product);
    const cached = readCache(cacheKey);
    if (cached) {
      cached._productId = product.product_id;
      cached._imageUrl = (product.image_urls || [])[0] || null;
      cached._fromCache = true;
      return res.json({ success: true, data: cached });
    }

    const requiredAttrs = (template && template.required) || [];
    const optionalAttrs = (template && template.optional) || [];
    const allAttrs = [...requiredAttrs, ...optionalAttrs];

    // Try to fetch PDF text
    let pdfText = '';
    if (product.pdf_urls && product.pdf_urls.length > 0) {
      try {
        const pdfParse = require('pdf-parse');
        const pdfUrl = product.pdf_urls[0];
        const pdfResponse = await fetch(pdfUrl);
        if (pdfResponse.ok) {
          const buffer = Buffer.from(await pdfResponse.arrayBuffer());
          const pdfData = await pdfParse(buffer);
          pdfText = pdfData.text.substring(0, 6000);
        }
      } catch (pdfErr) {
        console.log('PDF fetch failed:', pdfErr.message);
      }
    }

    // Try to fetch image
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
        console.log('Image fetch failed:', imgErr.message);
      }
    }

    // Build prompt
    const userParts = [];
    let promptText = `Extract product attributes for this product. Map values to the template fields provided.

Product: ${product.product_name}
SKU: ${product.product_id}
Description: ${product.description || 'N/A'}

REQUIRED attributes to extract: ${requiredAttrs.join(', ')}
OPTIONAL attributes to extract: ${optionalAttrs.join(', ')}`;

    if (pdfText) {
      promptText += `\n\nPDF TEXT:\n${pdfText}`;
    }

    userParts.push({ type: 'text', text: promptText });

    if (imageContent) {
      userParts.push({
        type: 'image_url',
        image_url: { url: `data:${imageContent.contentType};base64,${imageContent.base64}` }
      });
    }

    const response = await callAI({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [{
        role: 'system',
        content: `You are PC2's data extraction engine. Extract attribute values from the provided sources (PDF text, image, description) and map them to the template fields.

IMPORTANT: Many attributes will be found in MULTIPLE sources. For example, "Color" might be visible in the product image AND stated in the PDF. Always list ALL sources where you found evidence for the attribute value.

Return JSON:
{
  "product_name": "...",
  "brand": "...",
  "model_number": "...",
  "attributes": {
    "Attribute Name": {
      "value": "extracted value or null if not found",
      "confidence": 0.0-1.0,
      "sources": ["pdf", "image", "description", "inferred"],
      "required": true/false
    }
  },
  "missing_attributes": ["list of required attributes that could not be found"],
  "extraction_summary": "brief summary of what was extracted and from where"
}

For the "sources" array, include EVERY source where the attribute was found or confirmed:
- "pdf" — value found in PDF text
- "image" — value visible in product image
- "description" — value found in product description text
- "inferred" — value inferred from other attributes or category knowledge
An attribute can have multiple sources, e.g. ["pdf", "image"] if confirmed in both.`
      }, {
        role: 'user',
        content: userParts
      }]
    });

    const result = safeParseJSON(response.choices[0].message.content);
    result._productId = product.product_id;
    result._imageUrl = (product.image_urls || [])[0] || null;

    // Save to cache for future re-runs
    writeCache(cacheKey, result);

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Extract data error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 1f: Gap fill from PDP page
app.post('/api/enrich/gap-fill', async (req, res) => {
  try {
    const { product, missingAttributes, pdpUrl, pdfUrls, imageUrls } = req.body;

    let pdpText = '';
    let source = 'none';

    // Try PDP URL first
    if (pdpUrl) {
      try {
        const pdpResponse = await fetch(pdpUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PC2Bot/2.0)' }
        });
        if (pdpResponse.ok) {
          const html = await pdpResponse.text();
          // Strip HTML tags, keep text
          pdpText = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 8000);
          source = 'pdp_page';
        }
      } catch (pdpErr) {
        console.log('PDP fetch failed:', pdpErr.message);
      }
    }

    // Fall back to PDF if PDP failed
    if (!pdpText && pdfUrls && pdfUrls.length > 0) {
      try {
        const pdfParse = require('pdf-parse');
        const pdfResponse = await fetch(pdfUrls[0]);
        if (pdfResponse.ok) {
          const buffer = Buffer.from(await pdfResponse.arrayBuffer());
          const pdfData = await pdfParse(buffer);
          pdpText = pdfData.text.substring(0, 6000);
          source = 'pdf_reanalysis';
        }
      } catch (pdfErr) {
        console.log('PDF fallback failed:', pdfErr.message);
      }
    }

    if (!pdpText && (!missingAttributes || missingAttributes.length === 0)) {
      return res.json({ success: true, data: { filled: {}, source: 'none', message: 'No data source available' } });
    }

    const response = await callAI({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [{
        role: 'system',
        content: `You are PC2's gap-fill engine. Given product context and page/document text, find the values for the missing attributes listed.

Return JSON:
{
  "filled": {
    "Attribute Name": {
      "value": "...",
      "confidence": 0.0-1.0,
      "source": "${source}"
    }
  },
  "still_missing": ["attributes still not found"],
  "source_used": "${source}"
}`
      }, {
        role: 'user',
        content: `Product: ${product.product_name} (${product.product_id})
Missing attributes: ${(missingAttributes || []).join(', ')}

Source text (${source}):
${pdpText || 'No text available — try to infer from product name and description: ' + (product.description || '')}`
      }]
    });

    const result = safeParseJSON(response.choices[0].message.content);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Gap fill error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 1g: Generate lifestyle image via Google Imagen 3
app.post('/api/enrich/generate-image', async (req, res) => {
  const { productName, description, category, customPrompt } = req.body;
  const prompt = customPrompt || `Professional lifestyle product photo of ${productName}. ${description || ''}. Category: ${category || 'irrigation'}. Clean white or natural outdoor background, professional product photography lighting, high quality commercial catalog image.`;

  let imageBase64 = null;
  let mimeType = 'image/png';
  let provider = '';

  // ── Try 1: Gemini Flash Image Generation ──
  try {
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) throw new Error('No GOOGLE_AI_API_KEY');

    console.log('Image gen: trying Gemini Flash...');
    const geminiImageModel = 'gemini-2.0-flash-preview-image-generation';
    const geminiImageUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiImageModel}:generateContent?key=${apiKey}`;

    const response = await fetch(geminiImageUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ['IMAGE', 'TEXT'],
          imageConfig: { imageSize: '1K' }
        }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini ${response.status}: ${errText.substring(0, 200)}`);
    }

    const result = await response.json();
    const parts = result.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.inlineData && part.inlineData.data) {
        imageBase64 = part.inlineData.data;
        mimeType = part.inlineData.mimeType || 'image/png';
      }
    }

    if (imageBase64) {
      provider = 'Gemini 2.0 Flash';
    } else {
      throw new Error('Gemini returned no image data');
    }
  } catch (geminiErr) {
    console.log(`Gemini image gen failed (${geminiErr.message}), trying OpenAI...`);
  }

  // ── Try 2: OpenAI gpt-4.1-mini with image_generation tool ──
  if (!imageBase64) {
    try {
      console.log('Image gen: trying OpenAI gpt-4.1-mini...');
      const response = await openai.responses.create({
        model: 'gpt-4.1-mini',
        input: prompt,
        tools: [{ type: 'image_generation' }]
      });

      // Find image in output
      const imageOutput = (response.output || []).find(o => o.type === 'image_generation_call');
      if (imageOutput && imageOutput.result) {
        imageBase64 = imageOutput.result;
        mimeType = 'image/png';
        provider = 'OpenAI gpt-4.1-mini';
      } else {
        throw new Error('OpenAI returned no image output');
      }
    } catch (openaiErr) {
      console.log(`OpenAI image gen failed (${openaiErr.message})`);
    }
  }

  if (!imageBase64) {
    return res.status(500).json({ success: false, error: 'Both Gemini and OpenAI image generation failed' });
  }

  res.json({
    success: true,
    data: {
      imageBase64: imageBase64,
      mimeType: mimeType,
      prompt: prompt,
      provider: provider
    }
  });
});

// 1h: Product DQ Check
app.post('/api/athena/dq-check', async (req, res) => {
  try {
    const { product, template } = req.body;
    if (!product) {
      return res.status(400).json({ success: false, error: 'No product provided' });
    }

    const attrs = product.attributes || {};
    const requiredAttrs = (template && template.required) || [];
    const allAttrKeys = Object.keys(attrs);

    // ── Basic checks (pure JS) ──
    // Completeness: what % of required attrs are filled?
    let filledRequired = 0;
    const missingRequired = [];
    requiredAttrs.forEach(attr => {
      const found = allAttrKeys.find(k => k.toLowerCase() === attr.toLowerCase());
      if (found && attrs[found] && attrs[found].value && attrs[found].value !== 'null' && attrs[found].value !== 'N/A') {
        filledRequired++;
      } else {
        missingRequired.push(attr);
      }
    });
    const completenessScore = requiredAttrs.length > 0 ? Math.round((filledRequired / requiredAttrs.length) * 100) : 100;

    // Format validation: check for obvious issues
    let formatIssues = [];
    Object.entries(attrs).forEach(([key, val]) => {
      const v = typeof val === 'object' ? val.value : val;
      if (v && typeof v === 'string') {
        if (v.length > 500) formatIssues.push(`${key}: value too long (${v.length} chars)`);
        if (/^\d+$/.test(v) && (key.toLowerCase().includes('name') || key.toLowerCase().includes('description'))) {
          formatIssues.push(`${key}: numeric value in text field`);
        }
      }
    });
    const formatScore = Math.max(0, 100 - (formatIssues.length * 15));

    // Range validation: check numeric values are in reasonable ranges
    let rangeIssues = [];
    Object.entries(attrs).forEach(([key, val]) => {
      const v = typeof val === 'object' ? val.value : val;
      if (v && typeof v === 'string') {
        const num = parseFloat(v.replace(/[^0-9.-]/g, ''));
        if (!isNaN(num)) {
          if (key.toLowerCase().includes('pressure') && (num < 0 || num > 300)) rangeIssues.push(`${key}: ${v} outside typical range`);
          if (key.toLowerCase().includes('voltage') && (num < 0 || num > 480)) rangeIssues.push(`${key}: ${v} outside typical range`);
          if (key.toLowerCase().includes('flow') && num < 0) rangeIssues.push(`${key}: negative flow rate`);
        }
      }
    });
    const rangeScore = Math.max(0, 100 - (rangeIssues.length * 20));

    // ── Advanced checks (GPT-4o call) ──
    const response = await callAI({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [{
        role: 'system',
        content: `You are PC2's advanced DQ engine. Analyze the product data for:
1. Cross-attribute consistency — do the attributes make sense together?
2. Copy quality — is the product name/description professional and complete?

Return JSON:
{
  "consistency_score": 0-100,
  "consistency_issues": ["list of inconsistency issues found"],
  "copy_quality_score": 0-100,
  "copy_issues": ["list of copy quality issues"],
  "recommendations": ["actionable suggestions to improve data quality"]
}`
      }, {
        role: 'user',
        content: `Product: ${product.product_name} (${product.product_id})
Category: ${product.category || 'Unknown'}
Description: ${(product.description || '').substring(0, 500)}
Attributes: ${JSON.stringify(attrs, null, 2).substring(0, 3000)}`
      }]
    });

    const advanced = safeParseJSON(response.choices[0].message.content);

    // Calculate overall score
    const overallScore = Math.round(
      (completenessScore * 0.35) +
      (formatScore * 0.15) +
      (rangeScore * 0.15) +
      ((advanced.consistency_score || 75) * 0.20) +
      ((advanced.copy_quality_score || 75) * 0.15)
    );

    res.json({
      success: true,
      data: {
        overall_score: overallScore,
        breakdown: {
          completeness: { score: completenessScore, missing: missingRequired, weight: '35%' },
          format: { score: formatScore, issues: formatIssues, weight: '15%' },
          range: { score: rangeScore, issues: rangeIssues, weight: '15%' },
          consistency: { score: advanced.consistency_score || 75, issues: advanced.consistency_issues || [], weight: '20%' },
          copy_quality: { score: advanced.copy_quality_score || 75, issues: advanced.copy_issues || [], weight: '15%' }
        },
        recommendations: advanced.recommendations || [],
        product_id: product.product_id,
        product_name: product.product_name
      }
    });
  } catch (err) {
    console.error('DQ check error:', err);
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

// ── KNOWLEDGE BASE ENDPOINTS ─────────────────────────────
let kbCache = null;

function loadKB() {
  if (kbCache) return kbCache;
  const XLSX = require('xlsx');
  const kbDir = path.join(__dirname, 'kb');

  // Category Master
  const catWb = XLSX.readFile(path.join(kbDir, 'category_master.xlsx'));
  const catData = XLSX.utils.sheet_to_json(catWb.Sheets[catWb.SheetNames[0]]);
  const categories = catData.map(r => ({
    path: r['Web-Class'] || '',
    classId: r['Web-Class ID'] || '',
    imageHeaders: r['Image Headers'] || '',
    uniqueAttrs: r['Unique Attributes'] || ''
  }));

  // Attribute Master
  const attrWb = XLSX.readFile(path.join(kbDir, 'attribute_master.xlsx'));
  const attrData = XLSX.utils.sheet_to_json(attrWb.Sheets[attrWb.SheetNames[0]]);
  const attributes = attrData.map(r => ({
    classId: r['Web-Class ID'] || '',
    name: r['Attribute Name'] || '',
    attrId: r['Attribute ID'] || '',
    mandatory: r['mandatory'] || 'No',
    sentenceCase: r['sentence_case'] || 'None',
    spellCheck: r['spell_grammar_check'] || 'No',
    ruleId: r['rule_id'] || '',
    rule: r['rule'] || '',
    ruleType: r['rule_type'] || '',
    ruleValue: r['rule_value'] || '',
    ruleDescription: r['rule_description'] || '',
    defaultValues: r['default_values'] || '',
    pc2Generation: r['pc2_generation'] || 'No'
  }));

  // Rules
  const ruleWb = XLSX.readFile(path.join(kbDir, 'rule_builder_v1.xlsx'));
  const ruleData = XLSX.utils.sheet_to_json(ruleWb.Sheets[ruleWb.SheetNames[0]]);
  const rules = ruleData.map(r => ({
    id: r['Rule Identifier'] || '',
    name: r['Rule Name'] || '',
    description: r['Rule Description'] || '',
    code: r['Rule Code'] || '',
    scope: r['Rule Scope'] || '',
    json: r['Rule Json'] || ''
  }));

  // Build class-to-category lookup
  const classMap = {};
  categories.forEach(c => { classMap[c.classId] = c.path; });

  // Build per-class attribute summary
  const classAttrSummary = {};
  attributes.forEach(a => {
    if (!classAttrSummary[a.classId]) classAttrSummary[a.classId] = { total: 0, mandatory: 0, withRules: 0 };
    classAttrSummary[a.classId].total++;
    if (a.mandatory === 'Yes') classAttrSummary[a.classId].mandatory++;
    if (a.ruleId) classAttrSummary[a.classId].withRules++;
  });

  kbCache = {
    categories,
    attributes,
    rules,
    classMap,
    classAttrSummary,
    stats: {
      totalCategories: categories.length,
      totalAttributes: attributes.length,
      totalRules: rules.length,
      mandatoryAttrs: attributes.filter(a => a.mandatory === 'Yes').length,
      attrsWithRules: attributes.filter(a => a.ruleId).length,
      uniqueClasses: Object.keys(classAttrSummary).length
    }
  };

  console.log(`KB loaded: ${kbCache.stats.totalCategories} categories, ${kbCache.stats.totalAttributes} attributes, ${kbCache.stats.totalRules} rules`);
  return kbCache;
}

// Load KB on startup
try { loadKB(); } catch (e) { console.log('KB load deferred:', e.message); }

// ── WAYFAIR KB ──────────────────────────────────────────
let wayfairKBCache = null;

function loadWayfairKB() {
  if (wayfairKBCache) return wayfairKBCache;
  const XLSX = require('xlsx');
  const filePath = path.join(__dirname, 'kb', 'wayfair_categories.xlsx');
  if (!fs.existsSync(filePath)) return null;
  const wb = XLSX.readFile(filePath);
  const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);

  // Build class map: ClID -> { name, attributes[] }
  const classMap = {};
  data.forEach(r => {
    const clId = r.ClID;
    if (!clId) return;
    if (!classMap[clId]) classMap[clId] = { id: clId, name: r.ClName || '', attributes: [] };
    if (!classMap[clId].name && r.ClName) classMap[clId].name = r.ClName;
    classMap[clId].attributes.push({
      name: r.tag_name || '',
      definition: r.tag_definition || '',
      instructions: r.offshore_instructions || '',
      allowedValues: r.allowed_values || '',
      dataType: r.tag_values_data_type || '',
      priority: r.priority || '',
      isLegal: r.is_legal || false
    });
  });

  const classes = Object.values(classMap);
  wayfairKBCache = {
    classes,
    classMap,
    classNames: classes.map(c => ({ id: c.id, name: c.name })).filter(c => c.name),
    stats: {
      totalClasses: classes.length,
      totalAttributes: data.length,
      requiredAttrs: data.filter(r => r.priority === 'Required').length,
      recommendedAttrs: data.filter(r => r.priority === 'Recommended').length,
      optionalAttrs: data.filter(r => r.priority === 'Optional').length,
    }
  };
  console.log(`Wayfair KB loaded: ${wayfairKBCache.stats.totalClasses} classes, ${wayfairKBCache.stats.totalAttributes} attributes`);
  return wayfairKBCache;
}

try { loadWayfairKB(); } catch (e) { console.log('Wayfair KB load deferred:', e.message); }

app.get('/api/kb/wayfair/stats', (req, res) => {
  try {
    const kb = loadWayfairKB();
    if (!kb) return res.json({ success: false, error: 'Wayfair KB not loaded' });
    res.json({ success: true, data: kb.stats });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/kb/wayfair/classes', (req, res) => {
  try {
    const kb = loadWayfairKB();
    if (!kb) return res.json({ success: true, data: { classes: [], total: 0 } });
    const search = (req.query.search || '').toLowerCase();
    let classes = kb.classNames;
    if (search) classes = classes.filter(c => c.name.toLowerCase().includes(search) || String(c.id).includes(search));
    res.json({ success: true, data: { classes: classes.slice(0, 200), total: classes.length } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/kb/wayfair/attributes', (req, res) => {
  try {
    const kb = loadWayfairKB();
    if (!kb) return res.json({ success: true, data: { attributes: [], total: 0 } });
    const classId = req.query.classId;
    const cls = kb.classMap[classId];
    if (!cls) return res.json({ success: true, data: { attributes: [], total: 0, className: '' } });
    res.json({ success: true, data: { attributes: cls.attributes, total: cls.attributes.length, className: cls.name } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/kb/stats', (req, res) => {
  try {
    const kb = loadKB();
    res.json({ success: true, data: kb.stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/kb/categories', (req, res) => {
  try {
    const kb = loadKB();
    const search = (req.query.search || '').toLowerCase();
    let cats = kb.categories;
    if (search) {
      cats = cats.filter(c => c.path.toLowerCase().includes(search) || String(c.classId).includes(search));
    }
    // Enrich with attribute counts
    cats = cats.map(c => ({
      ...c,
      attrCount: (kb.classAttrSummary[c.classId] || {}).total || 0,
      mandatoryCount: (kb.classAttrSummary[c.classId] || {}).mandatory || 0
    }));
    res.json({ success: true, data: { categories: cats.slice(0, 200), total: cats.length } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/kb/attributes', (req, res) => {
  try {
    const kb = loadKB();
    const classId = req.query.classId;
    const search = (req.query.search || '').toLowerCase();
    let attrs = kb.attributes;
    if (classId) attrs = attrs.filter(a => String(a.classId) === String(classId));
    if (search) attrs = attrs.filter(a => a.name.toLowerCase().includes(search) || (a.ruleDescription || '').toLowerCase().includes(search));
    res.json({ success: true, data: { attributes: attrs.slice(0, 500), total: attrs.length, classPath: kb.classMap[classId] || '' } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/kb/rules', (req, res) => {
  try {
    const kb = loadKB();
    res.json({ success: true, data: { rules: kb.rules, total: kb.rules.length } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get KB context for LLM prompts (compact summary for a given class)
app.get('/api/kb/context/:classId', (req, res) => {
  try {
    const kb = loadKB();
    const classId = req.params.classId;
    const classPath = kb.classMap[classId] || 'Unknown';
    const attrs = kb.attributes.filter(a => String(a.classId) === String(classId));
    const mandatory = attrs.filter(a => a.mandatory === 'Yes');
    const withRules = attrs.filter(a => a.ruleId);

    const context = {
      classPath,
      classId,
      attributeCount: attrs.length,
      mandatoryAttributes: mandatory.map(a => ({
        name: a.name,
        rule: a.ruleDescription || '',
        defaultValues: a.defaultValues || ''
      })),
      validationRules: withRules.slice(0, 20).map(a => ({
        attribute: a.name,
        ruleType: a.ruleType,
        ruleDescription: a.ruleDescription
      }))
    };

    res.json({ success: true, data: context });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── EXPORT ENRICHED DATA ─────────────────────────────────
app.post('/api/export/enriched', (req, res) => {
  try {
    const XLSX = require('xlsx');
    const { products } = req.body;
    if (!products || products.length === 0) {
      return res.status(400).json({ success: false, error: 'No products to export' });
    }

    // Excluded system attributes
    const EXCLUDED = new Set(['taxonomy level 1','taxonomy level 2','taxonomy level 3','taxonomy level 4','classpath','sub brand','feature bullets 4','feature bullets 5','feature bullets 6','feature bullets 7','feature bullets 8','feature bullets 9','feature bullets 10','object type name','parent leaf guid','sku id','omsid','file action']);

    // ROW-BASED FORMAT: one row per attribute per SKU
    const rows = [];

    products.forEach(p => {
      const sku = p.product_id || p._productId || '';
      const productName = p.product_name || '';
      const category = p.category ? (p.category.category || '') : '';
      const cls = p.category ? (p.category.class || '') : '';

      // Base product fields as attributes
      const baseAttrs = [
        { attr: 'Product Name', value: productName, conf: '100%', source: 'ingestion' },
        { attr: 'Brand', value: p.brand || '', conf: '100%', source: 'ingestion' },
        { attr: 'Category', value: category, conf: '95%', source: 'categorization' },
        { attr: 'Class', value: cls, conf: '95%', source: 'categorization' },
        { attr: 'Description', value: p.description || '', conf: '100%', source: 'ingestion' },
      ];

      // Generated copy fields
      if (p.generated_copy) {
        const gc = p.generated_copy;
        if (gc.product_title) baseAttrs.push({ attr: 'Product Title', value: gc.product_title, conf: '90%', source: 'copy_generation' });
        if (gc.short_description) baseAttrs.push({ attr: 'Short Description', value: gc.short_description, conf: '90%', source: 'copy_generation' });
        if (gc.long_description) baseAttrs.push({ attr: 'Long Description', value: gc.long_description, conf: '90%', source: 'copy_generation' });
        if (gc.bullet_points) {
          gc.bullet_points.forEach((b, i) => {
            baseAttrs.push({ attr: `Feature Bullet ${i + 1}`, value: b, conf: '90%', source: 'copy_generation' });
          });
        }
        if (gc.seo_keywords) baseAttrs.push({ attr: 'SEO Keywords', value: gc.seo_keywords.join(', '), conf: '85%', source: 'copy_generation' });
        if (gc.target_audience) baseAttrs.push({ attr: 'Target Audience', value: gc.target_audience, conf: '85%', source: 'copy_generation' });
      }

      // Push base attributes
      baseAttrs.forEach(a => {
        if (a.value) rows.push({ SKU: sku, Attribute: a.attr, Value: a.value, Confidence: a.conf, Source: a.source });
      });

      // Push extracted/enriched attributes
      Object.entries(p.attributes || {}).forEach(([key, attr]) => {
        if (EXCLUDED.has(key.toLowerCase())) return;
        const val = typeof attr === 'object' ? attr : { value: attr };
        if (!val.value || val.value === 'null' || val.value === 'N/A') return;
        const conf = val.confidence !== undefined ? Math.round((val.confidence > 1 ? val.confidence : val.confidence * 100)) + '%' : '';
        const src = val.sources ? (Array.isArray(val.sources) ? val.sources.join(', ') : val.sources) : (val.source || '');
        rows.push({ SKU: sku, Attribute: key, Value: val.value, Confidence: conf, Source: src });
      });
    });

    const ws = XLSX.utils.json_to_sheet(rows);

    // Auto-size columns
    ws['!cols'] = [
      { wch: 18 }, // SKU
      { wch: 25 }, // Attribute
      { wch: 80 }, // Value
      { wch: 12 }, // Confidence
      { wch: 20 }, // Source
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Enriched Products');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="PC2_Enriched_Products.xlsx"');
    res.send(buffer);
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── CATALOG DATA LOOKUP ──────────────────────────────────
let catalogCache = null;

function loadCatalog() {
  if (catalogCache) return catalogCache;
  const XLSX = require('xlsx');
  const filePath = path.join(__dirname, 'kb', 'catalog_data.xlsx');
  if (!fs.existsSync(filePath)) return null;
  const wb = XLSX.readFile(filePath);
  const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  catalogCache = data.map(r => ({
    sku: r['SKU / Model'] || '',
    title: r['Product Title'] || '',
    category: r['Category'] || '',
    brand: r['Brand'] || '',
    price: r['Price (USD)'] || '',
    upc: r['UPC / Store SKU'] || '',
    description: r['Description'] || '',
    bullets: [r['Bullet Point 1'], r['Bullet Point 2'], r['Bullet Point 3'], r['Bullet Point 4'], r['Bullet Point 5']].filter(Boolean),
    flowRate: r['Flow Rate'] || '',
    material: r['Material'] || '',
    connectionSize: r['Connection Size'] || '',
    operatingPressure: r['Operating Pressure'] || '',
    warranty: r['Warranty'] || '',
    weight: r['Weight (lbs)'] || '',
    countryOfOrigin: r['Country of Origin'] || '',
    imageUrl: r['Image URL'] || '',
    pdfUrl: r['PDF Spec Sheet URL'] || ''
  }));
  console.log(`Catalog loaded: ${catalogCache.length} products`);
  return catalogCache;
}

try { loadCatalog(); } catch(e) { console.log('Catalog load deferred:', e.message); }

app.get('/api/catalog/lookup', (req, res) => {
  try {
    const catalog = loadCatalog();
    if (!catalog) return res.json({ success: true, data: null });
    const sku = (req.query.sku || '').toLowerCase();
    const name = (req.query.name || '').toLowerCase();

    let match = null;
    if (sku) match = catalog.find(c => c.sku.toLowerCase() === sku);
    if (!match && name) {
      // Fuzzy: find best match by title overlap
      match = catalog.find(c => c.title.toLowerCase().includes(name) || name.includes(c.title.toLowerCase().substring(0, 20)));
      if (!match) match = catalog.find(c => {
        const words = name.split(/\s+/).filter(w => w.length > 3);
        return words.filter(w => c.title.toLowerCase().includes(w)).length >= 2;
      });
    }

    res.json({ success: true, data: match || null });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════════════╗`);
  console.log(`  ║   PC2 v2.0 — Product Content Creator        ║`);
  console.log(`  ║   SiteOne Landscape Supply Demo              ║`);
  console.log(`  ║   Running on http://localhost:${PORT}            ║`);
  console.log(`  ╚══════════════════════════════════════════════╝\n`);
});

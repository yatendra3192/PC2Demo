// ── PC2 v2.0 — Frontend Application ──────────────────────

// ── STATE ─────────────────────────────────────────────────
let currentProduct = null;   // Shared product state across modules
let allIngestedProducts = []; // All products from multi-image ingestion
let enrichProductList = [];  // Products loaded into enrichment (for bulk)
let uploadedImageBase64 = null;
let uploadedImageMime = null;
let chatHistory = [];

// ── NAVIGATION ────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    item.classList.add('active');
    const module = item.dataset.module;
    document.querySelectorAll('.module-panel').forEach(p => p.classList.remove('active'));
    document.getElementById('panel-' + module).classList.add('active');
  });
});

// Sub-tab navigation
document.querySelectorAll('.sub-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const parent = tab.parentElement;
    parent.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const panelId = tab.dataset.subtab;
    const container = parent.parentElement;
    container.querySelectorAll('.sub-panel').forEach(p => p.classList.remove('active'));
    document.getElementById(panelId).classList.add('active');
  });
});

// ── LOADING ───────────────────────────────────────────────
function showLoading(title, text) {
  document.getElementById('loading-title').textContent = title;
  document.getElementById('loading-text').textContent = text;
  document.getElementById('loading').classList.add('visible');
}

function hideLoading() {
  document.getElementById('loading').classList.remove('visible');
}

// ── HELPERS ───────────────────────────────────────────────
function confidenceBadge(score) {
  const pct = Math.round(score * 100);
  let cls = 'high';
  if (score < 0.7) cls = 'low';
  else if (score < 0.85) cls = 'medium';
  return `<span class="confidence ${cls}">${pct}%</span>`;
}

// Strip large fields (base64 images, raw text) before sending to API
function cleanProductData(product) {
  if (!product) return product;
  const clean = { ...product };
  delete clean._thumbnail;
  delete clean._fileName;
  delete clean.extracted_text;
  // Truncate description if too long
  if (clean.description && clean.description.length > 500) {
    clean.description = clean.description.substring(0, 500);
  }
  return clean;
}

function sourceTag(source, sourceDetail) {
  const map = {
    'knowledge_base': ['kb', 'Knowledge Base'],
    'manufacturer_website': ['web', 'Manufacturer Site'],
    'product_datasheet': ['kb', 'Product Datasheet'],
    'certification_database': ['web', 'Certification DB'],
    'industry_standard': ['inference', 'Industry Standard'],
    'distributor_catalog': ['web', 'Distributor Catalog'],
    'distributor_site': ['web', 'Distributor'],
    'product_database': ['web', 'Product DB'],
    'category_inference': ['inference', 'Category Inference'],
    'product_data': ['kb', 'Product Data'],
    'manufacturer_specs': ['kb', 'Mfr Specs'],
    'label_text': ['image', 'Label Text'],
  };
  const [cls, label] = map[source] || ['', source || 'Extracted'];
  const detail = sourceDetail ? `<span style="display:block;font-size:10px;color:var(--gray-500);margin-top:1px">${sourceDetail}</span>` : '';
  return `<span class="source-tag ${cls}">${label}${detail}</span>`;
}

// ── SOURCES PANEL RENDERER ────────────────────────────────
function renderSourcesPanel(containerId, sources, title, type) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const typeIcons = {
    manufacturer: '&#x1F3ED;', certification: '&#x2705;', standard: '&#x1F4D0;',
    distributor: '&#x1F4E6;', database: '&#x1F5C4;', vision_model: '&#x1F441;',
    color_analysis: '&#x1F3A8;', object_detection: '&#x1F50D;', ocr_engine: '&#x1F4C4;',
    style_guide: '&#x270D;', competitor_analysis: '&#x1F4CA;', seo_database: '&#x1F310;',
    category_taxonomy: '&#x1F3F7;', brand_guidelines: '&#x1F3AF;', pipeline: '&#x2699;'
  };

  let rowsHtml = '';

  if (type === 'pipeline') {
    // Pipeline steps view
    sources.forEach(s => {
      rowsHtml += `<div class="pipeline-step">
        <div class="pipeline-dot"></div>
        <div class="pipeline-info">
          <div class="step-name">${s.step}</div>
          <div class="step-engine">${s.engine}</div>
          <div class="step-detail">${s.detail}</div>
        </div>
        <span class="source-status completed">${s.status}</span>
      </div>`;
    });
  } else {
    // Sources list view
    sources.forEach(s => {
      const icon = typeIcons[s.type] || '&#x1F4C1;';
      const statusClass = (s.status || 'verified').replace(/ /g, '_');
      rowsHtml += `<div class="source-row">
        <div class="source-icon ${s.type}">${icon}</div>
        <div class="source-info">
          <div class="source-name">${s.name}</div>
          ${s.url ? `<div class="source-url">${s.url}</div>` : ''}
          ${s.description ? `<div class="source-desc">${s.description}</div>` : ''}
        </div>
        <div class="source-meta">
          <span class="source-status ${statusClass}">${s.status || 'verified'}</span>
          ${s.fields_sourced ? `<span class="source-fields-count">${s.fields_sourced} fields</span>` : ''}
        </div>
      </div>`;
    });
  }

  const panelHtml = `<div class="sources-panel">
    <div class="sources-panel-header" onclick="this.classList.toggle('collapsed');this.nextElementSibling.classList.toggle('collapsed')">
      &#x1F50D; ${title || 'Sources Consulted'}
      <span style="font-weight:400;opacity:0.7;margin-left:8px">${sources.length} source${sources.length !== 1 ? 's' : ''}</span>
      <span class="toggle-icon">&#x25BC;</span>
    </div>
    <div class="sources-panel-body">${rowsHtml}</div>
  </div>`;

  container.insertAdjacentHTML('afterbegin', panelHtml);
}

function setProductSummary(containerId, data) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '';
  const fields = [
    ['Product Name', data.product_name],
    ['Brand', data.brand],
    ['Model Number', data.model_number],
    ['Description', data.description],
  ];
  fields.forEach(([label, value]) => {
    if (value) {
      el.innerHTML += `<div class="product-field"><label>${label}</label><div class="value">${value}</div></div>`;
    }
  });
}

// ── DRAG & DROP SETUP ─────────────────────────────────────
function setupUploadZone(zoneId, inputId, handler, multi = false) {
  const zone = document.getElementById(zoneId);
  const input = document.getElementById(inputId);

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
      handler(multi ? e.dataTransfer.files : e.dataTransfer.files[0]);
    }
  });
  input.addEventListener('change', () => {
    if (input.files.length) handler(multi ? input.files : input.files[0]);
  });
}

// ── 3a: PDF INGESTION (MULTIPLE) ──────────────────────────
setupUploadZone('pdf-upload-zone', 'pdf-file-input', async (files) => {
  const fileList = Array.from(files);
  if (fileList.length === 0) return;

  // Show file list preview
  const fileNames = document.getElementById('pdf-file-names');
  const fileListContainer = document.getElementById('pdf-file-list');
  fileNames.innerHTML = '';
  fileListContainer.style.display = 'block';
  fileList.forEach(f => {
    fileNames.innerHTML += `<span style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;background:var(--gray-100);border-radius:6px;font-size:13px;border:1px solid var(--gray-200)">&#x1F4C4; ${f.name}</span>`;
  });

  showLoading(
    `Ingesting ${fileList.length} PDF${fileList.length > 1 ? 's' : ''}`,
    `OCR + LLM parsing — extracting and mapping fields from ${fileList.length} document${fileList.length > 1 ? 's' : ''}...`
  );

  const formData = new FormData();
  fileList.forEach(file => formData.append('files', file));

  try {
    const res = await fetch('/api/ingest/pdf', { method: 'POST', body: formData });
    const json = await res.json();
    hideLoading();

    if (!json.success) throw new Error(json.error);

    const products = json.data.products || [json.data];
    allIngestedProducts = products;
    currentProduct = products[0];

    // Update flow message
    document.getElementById('pdf-flow-msg').innerHTML =
      `&#x2705; ${products.length} product${products.length > 1 ? 's' : ''} extracted from ${fileList.length} PDF${fileList.length > 1 ? 's' : ''} — fields mapped to schema`;

    // Build result cards for each product
    const container = document.getElementById('pdf-results-container');
    container.innerHTML = '';

    // Show ingestion pipeline sources
    const pipeline = json.data.ingestion_pipeline;
    if (pipeline && pipeline.length) {
      renderSourcesPanel('pdf-results-container', pipeline, 'Ingestion Pipeline — Processing Steps', 'pipeline');
    }

    products.forEach((product, idx) => {
      const attrs = { ...product.attributes, ...product.specifications };
      let attrRows = '';
      Object.entries(attrs).forEach(([key, val]) => {
        const v = typeof val === 'object' ? val : { value: val, confidence: 0.9, supplier_term: key };
        attrRows += `<tr>
          <td class="field-name">${key}</td>
          <td>${v.supplier_term ? `<span class="supplier-term">${v.supplier_term}</span> <span class="mapping-arrow">→</span> ${key}` : '—'}</td>
          <td>${v.value}</td>
          <td>${confidenceBadge(v.confidence || 0.9)}</td>
        </tr>`;
      });

      const pdfLabel = product.pdf_file || 'PDF ' + ((product.pdf_index || 0) + 1);

      container.innerHTML += `
        <div class="image-result-card ${idx === 0 ? 'selected' : ''}" data-pdf-idx="${idx}" onclick="selectPdfProduct(${idx})">
          <div class="image-result-header">
            <span class="img-num">${idx + 1}</span>
            <span>${product.product_name || 'Product ' + (idx + 1)}</span>
            <span style="margin-left:auto;font-size:11px;color:var(--gray-500)">&#x1F4C4; ${pdfLabel}</span>
          </div>
          <div style="padding:16px">
            <div class="product-summary" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
              ${product.product_name ? `<div class="product-field"><label>Product Name</label><div class="value">${product.product_name}</div></div>` : ''}
              ${product.brand ? `<div class="product-field"><label>Brand</label><div class="value">${product.brand}</div></div>` : ''}
              ${product.model_number ? `<div class="product-field"><label>Model Number</label><div class="value">${product.model_number}</div></div>` : ''}
              ${product.description ? `<div class="product-field"><label>Description</label><div class="value">${product.description}</div></div>` : ''}
            </div>
            <table class="attr-table">
              <thead>
                <tr><th>Schema Field</th><th>Supplier Term</th><th>Extracted Value</th><th>Confidence</th></tr>
              </thead>
              <tbody>${attrRows}</tbody>
            </table>
          </div>
        </div>
      `;
    });

    // Populate product selector dropdown
    const selector = document.getElementById('pdf-product-selector');
    selector.innerHTML = '';
    products.forEach((p, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `Product ${i + 1}: ${p.product_name || p.pdf_file || 'Unknown'}`;
      selector.appendChild(opt);
    });
    selector.onchange = () => selectPdfProduct(parseInt(selector.value));

    document.getElementById('pdf-results').classList.add('visible');
    updateCategorizePanel();
  } catch (err) {
    hideLoading();
    alert('Error: ' + err.message);
  }
}, true);  // true = multi-file mode

function selectPdfProduct(idx) {
  if (!allIngestedProducts[idx]) return;
  currentProduct = allIngestedProducts[idx];

  // Update selected state
  document.querySelectorAll('[data-pdf-idx]').forEach(c => c.classList.remove('selected'));
  const card = document.querySelector(`[data-pdf-idx="${idx}"]`);
  if (card) card.classList.add('selected');

  document.getElementById('pdf-product-selector').value = idx;
  updateCategorizePanel();
}

// ── 3b: IMAGE INGESTION (MULTIPLE) ────────────────────────
setupUploadZone('image-upload-zone', 'image-file-input', async (files) => {
  const fileList = Array.from(files);
  if (fileList.length === 0) return;

  // Show thumbnails preview
  const thumbGrid = document.getElementById('image-thumb-grid');
  const thumbContainer = document.getElementById('image-thumbnails');
  thumbGrid.innerHTML = '';
  thumbContainer.style.display = 'block';

  // Read files for thumbnails and store first image for enrichment
  const localPreviews = [];
  fileList.forEach((file, i) => {
    const reader = new FileReader();
    reader.onload = () => {
      localPreviews[i] = { dataUrl: reader.result, base64: reader.result.split(',')[1], mime: file.type };
      thumbGrid.innerHTML += `<img class="thumb-item" src="${reader.result}" title="${file.name}">`;
      // Store first image for enrichment
      if (i === 0) {
        uploadedImageBase64 = reader.result.split(',')[1];
        uploadedImageMime = file.type;
      }
    };
    reader.readAsDataURL(file);
  });

  showLoading(
    `Processing ${fileList.length} Image${fileList.length > 1 ? 's' : ''}`,
    `Computer Vision + LLM — reading labels and data from ${fileList.length} image${fileList.length > 1 ? 's' : ''}...`
  );

  const formData = new FormData();
  fileList.forEach(file => formData.append('files', file));

  try {
    const res = await fetch('/api/ingest/image', { method: 'POST', body: formData });
    const json = await res.json();
    hideLoading();

    if (!json.success) throw new Error(json.error);

    const products = json.data.products || [json.data];
    allIngestedProducts = products;
    currentProduct = products[0];

    // Store the first product's image for enrichment (use server-provided thumbnail if available)
    if (products[0]._thumbnail) {
      uploadedImageBase64 = products[0]._thumbnail.split(',')[1];
      uploadedImageMime = products[0]._thumbnail.split(';')[0].split(':')[1];
    }

    // Update flow message
    document.getElementById('image-flow-msg').innerHTML =
      `&#x2705; ${products.length} image${products.length > 1 ? 's' : ''} processed — text and data extracted via Computer Vision + LLM`;

    // Build result cards for each product
    const container = document.getElementById('image-results-container');
    container.innerHTML = '';

    products.forEach((product, idx) => {
      const imgSrc = product._thumbnail || (localPreviews[idx] ? localPreviews[idx].dataUrl : '');

      let attrRows = '';
      // Basic fields
      const basicFields = { 'Product Name': product.product_name, 'Brand': product.brand, 'Model Number': product.model_number };
      Object.entries(basicFields).forEach(([key, val]) => {
        if (val) {
          attrRows += `<tr><td class="field-name">${key}</td><td>${val}</td><td>${confidenceBadge(0.95)}</td></tr>`;
        }
      });
      // Attributes
      if (product.attributes) {
        Object.entries(product.attributes).forEach(([key, val]) => {
          const v = typeof val === 'object' ? val : { value: val, confidence: 0.85 };
          attrRows += `<tr><td class="field-name">${key}</td><td>${v.value}</td><td>${confidenceBadge(v.confidence || 0.85)}</td></tr>`;
        });
      }
      // Certifications
      if (product.certifications && product.certifications.length) {
        attrRows += `<tr><td class="field-name">Certifications</td><td>${product.certifications.join(', ')}</td><td>${confidenceBadge(0.9)}</td></tr>`;
      }

      container.innerHTML += `
        <div class="image-result-card ${idx === 0 ? 'selected' : ''}" data-product-idx="${idx}" onclick="selectImageProduct(${idx})">
          <div class="image-result-header">
            <span class="img-num">${idx + 1}</span>
            <span>${product.product_name || product._fileName || 'Product ' + (idx + 1)}</span>
            <span style="margin-left:auto;font-size:11px;color:var(--gray-500)">${product._fileName || 'Image ' + (idx + 1)}</span>
          </div>
          <div class="image-result-body">
            <div class="image-result-preview">
              ${imgSrc ? `<img src="${imgSrc}" alt="Product ${idx + 1}">` : '<span style="color:var(--gray-400)">No preview</span>'}
            </div>
            <div class="image-result-data">
              <table class="attr-table">
                <thead><tr><th>Field</th><th>Value</th><th>Confidence</th></tr></thead>
                <tbody>${attrRows}</tbody>
              </table>
            </div>
          </div>
        </div>
      `;
    });

    // Populate product selector dropdown
    const selector = document.getElementById('image-product-selector');
    selector.innerHTML = '';
    products.forEach((p, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `Product ${i + 1}: ${p.product_name || p._fileName || 'Unknown'}`;
      selector.appendChild(opt);
    });
    selector.onchange = () => selectImageProduct(parseInt(selector.value));

    document.getElementById('image-results').classList.add('visible');
    updateCategorizePanel();
  } catch (err) {
    hideLoading();
    alert('Error: ' + err.message);
  }
}, true);  // true = multi-file mode

function selectImageProduct(idx) {
  if (!allIngestedProducts[idx]) return;
  currentProduct = allIngestedProducts[idx];

  // Update selected state
  document.querySelectorAll('.image-result-card').forEach(c => c.classList.remove('selected'));
  const card = document.querySelector(`.image-result-card[data-product-idx="${idx}"]`);
  if (card) card.classList.add('selected');

  // Update selector
  document.getElementById('image-product-selector').value = idx;

  // Update image for enrichment
  if (currentProduct._thumbnail) {
    uploadedImageBase64 = currentProduct._thumbnail.split(',')[1];
    uploadedImageMime = currentProduct._thumbnail.split(';')[0].split(':')[1];
  }

  updateCategorizePanel();
}

// ── 3c: WEB INGESTION ─────────────────────────────────────
async function searchWeb() {
  const query = document.getElementById('web-search-input').value.trim();
  if (!query) return;

  showLoading('Web Extraction', 'Targeted extraction from manufacturer and distributor sites...');

  try {
    const res = await fetch('/api/ingest/web', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });
    const json = await res.json();
    hideLoading();

    if (!json.success) throw new Error(json.error);

    const product = json.data;
    currentProduct = product;

    setProductSummary('web-product-summary', product);

    if (product.sources_consulted) {
      document.getElementById('web-sources').textContent = 'Sources: ' + product.sources_consulted.join(', ');
    }

    const tbody = document.getElementById('web-attrs-body');
    tbody.innerHTML = '';
    const attrs = { ...product.attributes, ...product.specifications };
    Object.entries(attrs).forEach(([key, val]) => {
      const v = typeof val === 'object' ? val : { value: val, confidence: 0.85, source: 'web' };
      tbody.innerHTML += `<tr>
        <td class="field-name">${key}</td>
        <td>${v.value}</td>
        <td>${sourceTag(v.source)}</td>
        <td>${confidenceBadge(v.confidence || 0.85)}</td>
      </tr>`;
    });

    document.getElementById('web-results').classList.add('visible');
    updateCategorizePanel();
  } catch (err) {
    hideLoading();
    alert('Error: ' + err.message);
  }
}

// ── 3d: AUTO CATEGORIZE ───────────────────────────────────
function updateCategorizePanel() {
  if (currentProduct) {
    document.getElementById('categorize-empty').style.display = 'none';
    document.getElementById('categorize-ready').style.display = 'block';
    setProductSummary('cat-product-summary', currentProduct);
  }
  updateDedupPanel();
}

async function autoCategorize() {
  if (!currentProduct) return;
  showLoading('Identifying Category', 'Cross-referencing against retail Knowledge Base...');

  try {
    const res = await fetch('/api/ingest/categorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productData: cleanProductData(currentProduct) })
    });
    const json = await res.json();
    hideLoading();

    if (!json.success) throw new Error(json.error);

    const cat = json.data;
    const body = document.getElementById('category-result-body');

    let altHtml = '';
    if (cat.alternative_categories && cat.alternative_categories.length) {
      altHtml = '<div style="margin-top:16px"><h4 style="font-size:12px;font-weight:600;color:var(--gray-500);margin-bottom:8px">ALTERNATIVE CLASSIFICATIONS</h4>';
      cat.alternative_categories.forEach(alt => {
        altHtml += `<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--gray-100)">
          <span>${alt.category} → ${alt.class}</span>
          ${confidenceBadge(alt.confidence)}
        </div>`;
      });
      altHtml += '</div>';
    }

    body.innerHTML = `
      <div class="category-result">
        <div class="category-path">
          <span style="color:var(--blue)">${cat.category}</span>
          <span class="separator">→</span>
          <span style="color:var(--green)">${cat.class}</span>
        </div>
        ${confidenceBadge(cat.confidence)}
      </div>
      <div style="margin-top:12px;padding:12px 16px;background:var(--gray-50);border-radius:var(--radius);font-size:13px;color:var(--gray-600)">
        <strong>Reasoning:</strong> ${cat.reasoning}
      </div>
      ${altHtml}
    `;

    document.getElementById('category-results').classList.add('visible');
  } catch (err) {
    hideLoading();
    alert('Error: ' + err.message);
  }
}

// ── SEND TO ENRICHMENT ────────────────────────────────────
function sendToEnrichment() {
  if (!currentProduct) return;

  // Switch to Enrichment tab
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector('[data-module="enrichment"]').classList.add('active');
  document.querySelectorAll('.module-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-enrichment').classList.add('active');

  // Show enrichment content
  document.getElementById('enrichment-empty').style.display = 'none';
  document.getElementById('enrichment-content').style.display = 'block';

  // Populate attributes table with gaps
  populateEnrichmentTable();

  // Setup image preview for enrichment
  if (uploadedImageBase64) {
    document.getElementById('image-enrich-preview').innerHTML =
      `<img src="data:${uploadedImageMime};base64,${uploadedImageBase64}" style="max-width:100%;max-height:250px;border-radius:8px;border:1px solid var(--gray-200)">`;
    document.getElementById('run-image-enrichment-btn').style.display = '';
  } else {
    document.getElementById('image-enrich-preview').innerHTML =
      '<div class="empty-state" style="padding:30px"><div class="icon">&#x1F4F7;</div><h3>No image available</h3><p>Upload a product image in Ingestion to enable visual analysis</p></div>';
    document.getElementById('run-image-enrichment-btn').style.display = 'none';
  }
}

// ── SEND BULK TO ENRICHMENT ───────────────────────────────
function sendBulkToEnrichment() {
  // Gather all processed bulk results into enrichment product list
  const processed = [];
  bulkProducts.forEach((bp, i) => {
    const result = bulkResults[i];
    if (result) {
      // Convert bulk result into a product format compatible with enrichment
      processed.push({
        _bulkIndex: i,
        product_name: result.product_name || result._originalName || bp.product_name,
        brand: result.brand || '',
        model_number: result.model_number || '',
        description: result.generated_copy ? result.generated_copy.short_description : (bp.description || ''),
        attributes: result.attributes || {},
        specifications: {},
        category: result.category,
        acr_score: result.acr_score,
        visual_attributes: result.visual_attributes,
        generated_copy: result.generated_copy,
        sources_consulted: result.sources_consulted,
        dq_issues: result.dq_issues,
        _imageUrl: result._imageUrl,
        _productId: result._productId
      });
    }
  });

  if (processed.length === 0) {
    alert('No processed products to send. Run "Process All Products" first.');
    return;
  }

  enrichProductList = processed;

  // Switch to Enrichment tab
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector('[data-module="enrichment"]').classList.add('active');
  document.querySelectorAll('.module-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-enrichment').classList.add('active');

  // Show enrichment content
  document.getElementById('enrichment-empty').style.display = 'none';
  document.getElementById('enrichment-content').style.display = 'block';

  // Show product switcher
  const switcher = document.getElementById('enrich-product-switcher');
  switcher.style.display = 'block';
  document.getElementById('enrich-switcher-count').textContent = processed.length + ' products loaded';

  const select = document.getElementById('enrich-product-select');
  select.innerHTML = '';
  processed.forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `${i + 1}. ${p.product_name} (ID: ${p._productId})`;
    select.appendChild(opt);
  });

  // Load first product
  switchEnrichProduct(0);
}

function switchEnrichProduct(idx) {
  if (!enrichProductList[idx]) return;

  const product = enrichProductList[idx];
  currentProduct = product;

  // Update select
  document.getElementById('enrich-product-select').value = idx;

  // Reset enrichment UI state
  document.getElementById('enrich-sources-container').innerHTML = '';
  document.getElementById('enrich-gap-warning').innerHTML = '&#x26A0; Product has attribute gaps &mdash; missing fields highlighted below';
  document.getElementById('enrich-gap-warning').classList.add('warning');
  document.getElementById('acr-after-card').style.display = 'none';

  const enrichBtn = document.getElementById('run-enrichment-btn');
  enrichBtn.textContent = '🤖 Run Enrichment';
  enrichBtn.disabled = false;

  const copyBtn = document.getElementById('gen-copy-btn');
  copyBtn.textContent = '✍ Generate Copy';
  copyBtn.disabled = false;

  // Hide previous copy results
  document.getElementById('copy-results').classList.remove('visible');
  document.getElementById('image-enrich-results').classList.remove('visible');

  // Populate attributes table
  populateEnrichmentTable();

  // Setup image for enrichment
  if (product._imageUrl) {
    document.getElementById('image-enrich-preview').innerHTML =
      `<img src="${product._imageUrl}" style="max-width:100%;max-height:250px;border-radius:8px;border:1px solid var(--gray-200)" onerror="this.parentElement.innerHTML='<div class=\\'empty-state\\' style=\\'padding:30px\\'><div class=\\'icon\\'>📷</div><h3>Image could not load</h3></div>'">`;
    document.getElementById('run-image-enrichment-btn').style.display = '';
    // We don't have base64 for URL images, so set flag for server-side fetch
    uploadedImageBase64 = null;
    uploadedImageMime = null;
  } else {
    document.getElementById('image-enrich-preview').innerHTML =
      '<div class="empty-state" style="padding:30px"><div class="icon">&#x1F4F7;</div><h3>No image available</h3></div>';
    document.getElementById('run-image-enrichment-btn').style.display = 'none';
  }

  // Show enrichment-done button
  document.getElementById('enrichment-done').style.display = 'block';
}

function populateEnrichmentTable() {
  const tbody = document.getElementById('enrich-attrs-body');
  tbody.innerHTML = '';

  const attrs = { ...currentProduct.attributes, ...currentProduct.specifications };

  // Show only actual extracted attributes from the product (not hardcoded list)
  let filled = 0;
  const attrKeys = Object.keys(attrs);

  attrKeys.forEach(key => {
    const val = typeof attrs[key] === 'object' ? attrs[key] : { value: attrs[key], confidence: 0.9 };
    // Skip empty values
    if (!val.value || val.value === '' || val.value === 'N/A') return;
    filled++;
    tbody.innerHTML += `<tr>
      <td class="field-name">${key}</td>
      <td>${val.value}</td>
      <td>${sourceTag(val.source || 'product_data', val.source_detail)}</td>
      <td>${confidenceBadge(val.confidence || 0.9)}</td>
    </tr>`;
  });

  // Use ACR from bulk if available, otherwise estimate
  const acrFromProduct = currentProduct.acr_score;
  const acr = acrFromProduct || Math.min(Math.round((filled / Math.max(filled + 5, 15)) * 100), 70);

  document.getElementById('acr-before-val').textContent = acr + '%';
  document.getElementById('acr-before-detail').textContent = `${filled} attributes extracted`;

  const circle = document.getElementById('acr-before-circle');
  circle.className = 'acr-circle ' + (acr < 50 ? 'low' : acr < 75 ? 'medium' : 'high');
}

// ── 4a: RUN ENRICHMENT ────────────────────────────────────
async function runEnrichment() {
  if (!currentProduct) return;
  showLoading('Running Enrichment', 'Filling attribute gaps from Knowledge Base and category inference...');

  try {
    const res = await fetch('/api/enrich/attributes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productData: cleanProductData(currentProduct),
        category: (currentProduct.category && currentProduct.category.category)
          ? currentProduct.category.category + ' > ' + (currentProduct.category.class || '')
          : 'General'
      })
    });
    const json = await res.json();
    hideLoading();

    if (!json.success) throw new Error(json.error);

    const enriched = json.data;
    const tbody = document.getElementById('enrich-attrs-body');
    tbody.innerHTML = '';

    let gapsFilled = 0;
    let total = 0;

    Object.entries(enriched.enriched_attributes).forEach(([key, val]) => {
      // Skip attributes with no value or 0% confidence
      if (!val.value || val.value === '' || val.value === 'N/A' || val.value === 'null') return;
      if (val.confidence !== undefined && val.confidence <= 0) return;

      total++;
      const wasMissing = val.was_missing;
      if (wasMissing) gapsFilled++;

      tbody.innerHTML += `<tr class="${wasMissing ? 'filled-cell' : ''}">
        <td class="field-name">${key} ${wasMissing ? '<span style="color:var(--green);font-size:11px">&#x2705; FILLED</span>' : ''}</td>
        <td>${val.value}</td>
        <td>${sourceTag(val.source, val.source_detail)}</td>
        <td>${confidenceBadge(val.confidence)}</td>
      </tr>`;
    });

    // Update ACR scores
    const acrBefore = enriched.acr_before || 45;
    const acrAfter = enriched.acr_after || 94;

    document.getElementById('acr-before-val').textContent = Math.round(acrBefore) + '%';
    document.getElementById('acr-after-card').style.display = 'block';
    document.getElementById('acr-after-val').textContent = Math.round(acrAfter) + '%';
    document.getElementById('acr-improvement').innerHTML = `&#x2B06; +${Math.round(acrAfter - acrBefore)}% &mdash; ${enriched.gaps_filled || gapsFilled} gaps filled`;

    // Show sources consulted
    if (enriched.sources_consulted && enriched.sources_consulted.length) {
      document.getElementById('enrich-sources-container').innerHTML = '';
      renderSourcesPanel('enrich-sources-container', enriched.sources_consulted, 'Data Sources Consulted — Verified Origins', 'sources');
    }
    document.getElementById('enrich-gap-warning').innerHTML = '&#x2705; Attribute gaps filled from verified sources — see sources panel above';
    document.getElementById('enrich-gap-warning').classList.remove('warning');

    document.getElementById('run-enrichment-btn').textContent = '✅ Enrichment Complete';
    document.getElementById('run-enrichment-btn').disabled = true;

    document.getElementById('enrichment-done').style.display = 'block';
  } catch (err) {
    hideLoading();
    alert('Error: ' + err.message);
  }
}

// ── 4b: IMAGE ENRICHMENT ──────────────────────────────────
async function runImageEnrichment() {
  const hasBase64 = !!uploadedImageBase64;
  const hasUrl = currentProduct && currentProduct._imageUrl;
  if (!hasBase64 && !hasUrl) return;

  showLoading('Analysing Image', 'Generating visual attributes from product photo...');

  const payload = {};
  if (hasBase64) {
    payload.imageBase64 = uploadedImageBase64;
    payload.mimeType = uploadedImageMime;
  } else if (hasUrl) {
    payload.imageUrl = currentProduct._imageUrl;
  }

  try {
    const res = await fetch('/api/enrich/image-analysis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    hideLoading();

    if (!json.success) throw new Error(json.error);

    const data = json.data;

    if (data.visual_summary) {
      document.getElementById('visual-summary').textContent = data.visual_summary;
    }

    const grid = document.getElementById('visual-attrs-grid');
    grid.innerHTML = '';

    Object.entries(data.visual_attributes).forEach(([key, val]) => {
      const v = typeof val === 'object' ? val : { value: val, confidence: 0.85 };
      grid.innerHTML += `<div class="visual-attr">
        <div class="va-name">${key}</div>
        <div class="va-value">${v.value} ${confidenceBadge(v.confidence || 0.85)}</div>
      </div>`;
    });

    // Show analysis methods as sources
    if (data.analysis_methods && data.analysis_methods.length) {
      document.getElementById('image-enrich-sources-container').innerHTML = '';
      renderSourcesPanel('image-enrich-sources-container', data.analysis_methods.map(m => ({
        name: m.name, type: m.type, description: m.description, status: m.status
      })), 'Analysis Methods — Computer Vision Pipeline', 'sources');
    }

    document.getElementById('image-enrich-results').classList.add('visible');
    document.getElementById('enrichment-done').style.display = 'block';
  } catch (err) {
    hideLoading();
    alert('Error: ' + err.message);
  }
}

// ── 4c: COPY GENERATION ──────────────────────────────────
async function generateCopy() {
  if (!currentProduct) return;
  showLoading('Generating Copy', 'Creating category-specific product content...');

  try {
    const res = await fetch('/api/enrich/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productData: cleanProductData(currentProduct) })
    });
    const json = await res.json();
    hideLoading();

    if (!json.success) throw new Error(json.error);

    const copy = json.data;
    const output = document.getElementById('copy-output');

    let bulletsHtml = '';
    if (copy.bullet_points && copy.bullet_points.length) {
      bulletsHtml = '<ul class="bullets-list">' +
        copy.bullet_points.map(b => `<li>${b}</li>`).join('') +
        '</ul>';
    }

    let keywordsHtml = '';
    if (copy.seo_keywords && copy.seo_keywords.length) {
      keywordsHtml = copy.seo_keywords.map(k =>
        `<span style="display:inline-block;padding:4px 10px;background:var(--gray-100);border-radius:4px;font-size:12px;margin:2px 4px">${k}</span>`
      ).join('');
    }

    output.innerHTML = `
      <div class="copy-section">
        <h4>Product Title</h4>
        <div class="content title">${copy.product_title}</div>
      </div>
      <div class="copy-section">
        <h4>Short Description</h4>
        <div class="content">${copy.short_description}</div>
      </div>
      <div class="copy-section">
        <h4>Long Description</h4>
        <div class="content">${copy.long_description.replace(/\n/g, '<br>')}</div>
      </div>
      <div class="copy-section">
        <h4>Key Selling Points</h4>
        <div class="content">${bulletsHtml}</div>
      </div>
      <div class="copy-section">
        <h4>SEO Keywords</h4>
        <div class="content">${keywordsHtml}</div>
      </div>
      <div class="copy-section">
        <h4>Target Audience</h4>
        <div class="content">${copy.target_audience}</div>
      </div>
    `;

    // Show copy sources
    if (copy.copy_sources && copy.copy_sources.length) {
      document.getElementById('copy-sources-container').innerHTML = '';
      renderSourcesPanel('copy-sources-container', copy.copy_sources.map(s => ({
        name: s.name, type: s.type, description: s.description, status: s.status
      })), 'Content Sources — Copy Generation Pipeline', 'sources');
    }

    document.getElementById('copy-results').classList.add('visible');
    document.getElementById('gen-copy-btn').textContent = '✅ Copy Generated';
    document.getElementById('gen-copy-btn').disabled = true;
    document.getElementById('enrichment-done').style.display = 'block';
  } catch (err) {
    hideLoading();
    alert('Error: ' + err.message);
  }
}

// ── SEND TO ATHENA ────────────────────────────────────────
function sendToAthena() {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector('[data-module="athena"]').classList.add('active');
  document.querySelectorAll('.module-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-athena').classList.add('active');
}

// ── ATHENA DASHBOARD ──────────────────────────────────────
function initDashboard() {
  const categories = [
    { name: 'Sprinkler Heads', acr: 81.2, issues: 621 },
    { name: 'Transformers', acr: 77.2, issues: 312 },
    { name: 'LED Fixtures', acr: 74.6, issues: 945 },
    { name: 'Irrigation Controllers', acr: 72.4, issues: 847 },
    { name: 'Fertilizers', acr: 70.1, issues: '1,823' },
    { name: 'Irrigation Valves', acr: 68.1, issues: '1,203' },
    { name: 'Drip Irrigation', acr: 65.3, issues: '1,567' },
    { name: 'Pavers', acr: 63.4, issues: '2,156' },
    { name: 'Pipes & Fittings', acr: 59.8, issues: '3,204' },
  ];

  const container = document.getElementById('category-bars');
  container.innerHTML = '';

  categories.forEach(cat => {
    const cls = cat.acr < 65 ? 'low' : cat.acr < 75 ? 'medium' : 'high';
    const color = cat.acr < 65 ? 'var(--red)' : cat.acr < 75 ? 'var(--orange)' : 'var(--green)';
    container.innerHTML += `<div class="category-row">
      <span class="cat-name">${cat.name}</span>
      <div class="cat-bar-container">
        <div class="cat-bar ${cls}" style="width:${cat.acr}%"></div>
      </div>
      <span class="cat-score" style="color:${color}">${cat.acr}%</span>
      <span class="cat-issues">${cat.issues} issues</span>
    </div>`;
  });
}

// ── SIMULATE FIX ──────────────────────────────────────────
function simulateFix(btn, category) {
  btn.disabled = true;
  btn.innerHTML = '&#x23F3; Running...';
  btn.className = 'btn btn-sm btn-secondary';

  setTimeout(() => {
    btn.innerHTML = '&#x2705; Fixed';
    btn.className = 'btn btn-sm btn-success';
    btn.style.opacity = '0.7';

    // Update the affected SKUs cell
    const row = btn.closest('tr');
    const skuCell = row.querySelector('.confidence');
    skuCell.className = 'confidence high';
    skuCell.textContent = '0 SKUs remaining';
  }, 2000);
}

// ── GOD MODE CLEANUP ──────────────────────────────────────
function initiateCleanup(btn) {
  btn.disabled = true;
  btn.innerHTML = '&#x23F3; Running cleanup...';

  setTimeout(() => {
    btn.innerHTML = '&#x2705; Cleanup Complete — 47 products fixed';
    btn.className = 'btn btn-success btn-sm';
    btn.style.opacity = '0.8';
    btn.closest('.alert-card').style.borderLeftColor = 'var(--green)';
  }, 2500);
}

// ── CDI CHAT ──────────────────────────────────────────────
function askCDI(text) {
  document.getElementById('chat-input').value = text;
  sendChat();
}

async function sendChat() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  // Add user message
  const messagesEl = document.getElementById('chat-messages');
  messagesEl.innerHTML += `<div class="chat-msg user">${text}</div>`;

  // Add typing indicator
  const typingId = 'typing-' + Date.now();
  messagesEl.innerHTML += `<div class="chat-msg assistant" id="${typingId}" style="opacity:0.6">Athena is thinking...</div>`;
  messagesEl.scrollTop = messagesEl.scrollHeight;

  chatHistory.push({ role: 'user', content: text });

  try {
    const res = await fetch('/api/athena/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: chatHistory })
    });
    const json = await res.json();

    // Remove typing indicator
    document.getElementById(typingId).remove();

    if (!json.success) throw new Error(json.error);

    chatHistory.push({ role: 'assistant', content: json.reply });

    // Format the response (basic markdown-like formatting)
    let formatted = json.reply
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n\n/g, '<br><br>')
      .replace(/\n- /g, '<br>• ')
      .replace(/\n(\d+)\. /g, '<br>$1. ')
      .replace(/\n/g, '<br>');

    messagesEl.innerHTML += `<div class="chat-msg assistant">${formatted}</div>`;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } catch (err) {
    document.getElementById(typingId).remove();
    messagesEl.innerHTML += `<div class="chat-msg assistant" style="color:var(--red)">Error: ${err.message}</div>`;
  }
}

// ── DEDUPLICATION ─────────────────────────────────────────

// Update dedup panel when products are available
function updateDedupPanel() {
  const products = allIngestedProducts.length > 0 ? allIngestedProducts : (bulkProducts.length > 0 ? bulkProducts : []);
  if (products.length >= 2) {
    document.getElementById('dedup-empty').style.display = 'none';
    document.getElementById('dedup-ready').style.display = 'block';
  }
}

async function runDeduplication() {
  const products = allIngestedProducts.length > 0 ? allIngestedProducts : (bulkProducts.length > 0 ? bulkProducts : []);
  if (products.length < 2) {
    alert('Need at least 2 products to scan for duplicates.');
    return;
  }

  showLoading('Scanning for Duplicates', `Comparing ${products.length} products for potential duplicates...`);

  try {
    const res = await fetch('/api/ingest/deduplicate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ products: products.map(p => cleanProductData(p)) })
    });
    const json = await res.json();
    hideLoading();

    if (!json.success) throw new Error(json.error);

    const data = json.data;
    const groups = data.duplicate_groups || [];

    // Update flow message
    document.getElementById('dedup-flow-msg').innerHTML = groups.length > 0
      ? `&#x26A0; ${groups.length} duplicate group${groups.length !== 1 ? 's' : ''} found — review and merge below`
      : `&#x2705; No duplicates found — all ${products.length} products are unique`;
    document.getElementById('dedup-flow-msg').classList.toggle('warning', groups.length > 0);

    // Stats
    document.getElementById('dedup-stat-scanned').textContent = data.total_scanned || products.length;
    document.getElementById('dedup-stat-groups').textContent = groups.length;
    document.getElementById('dedup-stat-unique').textContent = data.unique_count || (products.length - groups.reduce((sum, g) => sum + g.products.length - 1, 0));

    // Sources
    if (data.dedup_methods && data.dedup_methods.length) {
      document.getElementById('dedup-sources-container').innerHTML = '';
      renderSourcesPanel('dedup-sources-container', data.dedup_methods, 'Deduplication Methods', 'sources');
    }

    // Render groups
    const container = document.getElementById('dedup-groups-container');
    container.innerHTML = '';

    if (groups.length === 0) {
      container.innerHTML = '<div class="card"><div class="card-body" style="text-align:center;padding:40px;color:var(--green)"><span style="font-size:48px">&#x2705;</span><h3 style="margin-top:12px">All Products Are Unique</h3><p style="color:var(--gray-500)">No duplicate records detected across ' + products.length + ' products</p></div></div>';
    }

    groups.forEach((group, gi) => {
      const matchLabel = group.match_type === 'exact_match' ? 'Exact Match' : group.match_type === 'high_similarity' ? 'High Similarity' : 'Possible Match';
      const matchPct = Math.round((group.match_score || 0.85) * 100);

      let itemsHtml = '';
      group.products.forEach(p => {
        itemsHtml += `<div class="dedup-item ${p.is_primary ? 'primary' : ''}">
          <span class="dedup-label">${p.is_primary ? 'KEEP' : 'DUPLICATE'}</span>
          <div style="flex:1">
            <div style="font-weight:500">${p.product_name}</div>
            <div style="font-size:11px;color:var(--gray-500)">ID: ${p.product_id}</div>
          </div>
        </div>`;
      });

      container.innerHTML += `<div class="dedup-group">
        <div class="dedup-group-header">
          <span class="dup-badge">Group ${gi + 1}</span>
          <span>${matchLabel}</span>
          <span style="font-size:12px;color:var(--gray-500);flex:1">${group.reason}</span>
          <span class="dedup-match-score">${matchPct}% match</span>
        </div>
        ${itemsHtml}
        <div class="dedup-actions">
          <button class="btn btn-sm btn-secondary" onclick="this.textContent='Skipped';this.disabled=true">Skip</button>
          <button class="btn btn-sm btn-success" onclick="this.innerHTML='&#x2705; Merged';this.disabled=true;this.closest('.dedup-group').style.opacity='0.5'">Merge &amp; Keep Primary</button>
        </div>
      </div>`;
    });

    document.getElementById('dedup-results').classList.add('visible');
    document.getElementById('dedup-run-btn').textContent = '✅ Scan Complete';
    document.getElementById('dedup-run-btn').disabled = true;
  } catch (err) {
    hideLoading();
    alert('Error: ' + err.message);
  }
}

// ── BULK UPLOAD ───────────────────────────────────────────
let bulkProducts = [];
let bulkResults = {};

setupUploadZone('bulk-upload-zone', 'bulk-file-input', async (files) => {
  const file = Array.from(files)[0] || files;
  if (!file) return;

  showLoading('Parsing Excel', 'Reading product data from spreadsheet...');

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/api/ingest/bulk/parse', { method: 'POST', body: formData });
    const json = await res.json();
    hideLoading();

    if (!json.success) throw new Error(json.error);

    bulkProducts = json.data.products;
    bulkResults = {};

    document.getElementById('bulk-flow-msg').innerHTML =
      `&#x2705; ${bulkProducts.length} products parsed from Excel — ready for processing`;
    document.getElementById('bulk-count').textContent = bulkProducts.length;

    // Populate table
    const tbody = document.getElementById('bulk-table-body');
    tbody.innerHTML = '';
    bulkProducts.forEach((p, i) => {
      const imgSrc = p.image_urls[0] || '';
      tbody.innerHTML += `<tr class="bulk-row" id="bulk-row-${i}" onclick="showBulkDetail(${i})">
        <td style="font-weight:600;color:var(--gray-500)">${i + 1}</td>
        <td>${imgSrc ? `<img class="bulk-img-thumb" src="${imgSrc}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 40 40%22><rect fill=%22%23eee%22 width=%2240%22 height=%2240%22/><text x=%2220%22 y=%2224%22 text-anchor=%22middle%22 fill=%22%23999%22 font-size=%2212%22>?</text></svg>'">` : '<span style="color:var(--gray-300)">—</span>'}</td>
        <td>
          <div style="font-weight:500;color:var(--gray-800);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.product_name}</div>
          <div style="font-size:10px;color:var(--gray-400)">ID: ${p.product_id} | ${p.pdf_urls.length} PDF${p.pdf_urls.length !== 1 ? 's' : ''} | ${p.image_urls.length} img${p.image_urls.length !== 1 ? 's' : ''}</div>
        </td>
        <td id="bulk-cat-${i}"><span class="bulk-cat-tag">—</span></td>
        <td id="bulk-acr-${i}"><span style="color:var(--gray-400)">—</span></td>
        <td id="bulk-src-${i}"><span style="color:var(--gray-400)">—</span></td>
        <td id="bulk-status-${i}"><span class="bulk-status pending">Pending</span></td>
      </tr>`;
    });

    document.getElementById('bulk-parsed').classList.add('visible');
  } catch (err) {
    hideLoading();
    alert('Error: ' + err.message);
  }
}, true);

async function bulkProcessAll() {
  if (bulkProducts.length === 0) return;

  const btn = document.getElementById('bulk-process-btn');
  btn.disabled = true;
  btn.innerHTML = '&#x23F3; Processing...';

  const progressCard = document.getElementById('bulk-progress-card');
  progressCard.style.display = 'block';

  const total = bulkProducts.length;
  let completed = 0;
  let totalAcr = 0;
  let totalIssues = 0;
  let allSources = [];

  for (let i = 0; i < total; i++) {
    const product = bulkProducts[i];

    // Update status to processing
    document.getElementById(`bulk-status-${i}`).innerHTML =
      '<span class="bulk-status processing">Processing</span>';
    document.getElementById('bulk-progress-status').textContent =
      `Processing: ${product.product_name}...`;

    // Scroll row into view
    document.getElementById(`bulk-row-${i}`).scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    try {
      const res = await fetch('/api/ingest/bulk/process-one', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product })
      });
      const json = await res.json();

      if (json.success) {
        bulkResults[i] = json.data;
        const acr = json.data.acr_score || 0;
        const issues = (json.data.dq_issues || []).length;
        totalAcr += acr;
        totalIssues += issues;

        if (json.data.sources_consulted) {
          allSources.push(...json.data.sources_consulted);
        }

        // Update row
        document.getElementById(`bulk-status-${i}`).innerHTML =
          '<span class="bulk-status done">Done</span>';

        const cat = json.data.category;
        if (cat) {
          document.getElementById(`bulk-cat-${i}`).innerHTML =
            `<span class="bulk-cat-tag">${cat.class || cat.category || '—'}</span>`;
        }

        document.getElementById(`bulk-acr-${i}`).innerHTML =
          `<span style="font-weight:600;color:${acr >= 75 ? 'var(--green)' : acr >= 50 ? 'var(--orange)' : 'var(--red)'}">${acr}%</span>`;

        const srcCount = (json.data.sources_consulted || []).length;
        document.getElementById(`bulk-src-${i}`).innerHTML =
          `<span style="font-size:11px;color:var(--blue)">${srcCount}</span>`;
      } else {
        document.getElementById(`bulk-status-${i}`).innerHTML =
          '<span class="bulk-status error">Error</span>';
      }
    } catch (err) {
      document.getElementById(`bulk-status-${i}`).innerHTML =
        '<span class="bulk-status error">Error</span>';
    }

    completed++;
    const pct = Math.round((completed / total) * 100);
    document.getElementById('bulk-progress-bar').style.width = pct + '%';
    document.getElementById('bulk-progress-text').textContent = `${completed} / ${total}`;
  }

  // Done
  document.getElementById('bulk-progress-status').textContent =
    `All ${total} products processed successfully!`;
  btn.innerHTML = '&#x2705; All Products Processed';

  // Show "Send All to Enrichment" button
  document.getElementById('bulk-enrich-btn').style.display = '';

  // Show summary
  document.getElementById('bulk-summary').style.display = 'block';
  document.getElementById('bulk-stat-processed').textContent = completed;
  document.getElementById('bulk-stat-acr').textContent = Math.round(totalAcr / completed) + '%';
  document.getElementById('bulk-stat-issues').textContent = totalIssues;

  // Deduplicate and show sources
  const uniqueSources = [];
  const seenNames = new Set();
  allSources.forEach(s => {
    if (!seenNames.has(s.name)) {
      seenNames.add(s.name);
      uniqueSources.push(s);
    }
  });
  if (uniqueSources.length > 0) {
    document.getElementById('bulk-sources-container').innerHTML = '';
    renderSourcesPanel('bulk-sources-container', uniqueSources,
      `All Sources Consulted — ${uniqueSources.length} unique verified sources across ${completed} products`, 'sources');
  }
}

// ── BULK DEDUPLICATION ─────────────────────────────────────
async function runBulkDedup() {
  if (bulkProducts.length < 2) {
    alert('Need at least 2 products to scan for duplicates.');
    return;
  }

  const btn = document.getElementById('bulk-dedup-btn');
  btn.disabled = true;
  btn.innerHTML = '&#x23F3; Scanning...';

  showLoading('Scanning for Duplicates', `Comparing ${bulkProducts.length} products for potential duplicates...`);

  try {
    const res = await fetch('/api/ingest/deduplicate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ products: bulkProducts.map(p => cleanProductData(p)) })
    });
    const json = await res.json();
    hideLoading();

    if (!json.success) throw new Error(json.error);

    const data = json.data;
    const groups = data.duplicate_groups || [];

    // Show section
    document.getElementById('bulk-dedup-section').style.display = 'block';

    const summaryText = document.getElementById('bulk-dedup-summary-text');
    summaryText.textContent = groups.length > 0
      ? `${groups.length} duplicate group${groups.length !== 1 ? 's' : ''} found in ${bulkProducts.length} products`
      : `No duplicates — all ${bulkProducts.length} products are unique`;

    const container = document.getElementById('bulk-dedup-groups');
    container.innerHTML = '';

    if (groups.length === 0) {
      container.innerHTML = '<div style="text-align:center;padding:24px;color:var(--green)"><span style="font-size:36px">&#x2705;</span><h3 style="margin-top:8px">All Products Are Unique</h3><p style="color:var(--gray-500);font-size:13px">No duplicate records detected</p></div>';
      btn.innerHTML = '&#x2705; No Duplicates';
    } else {
      groups.forEach((group, gi) => {
        const matchPct = Math.round((group.match_score || 0.85) * 100);
        const matchLabel = group.match_type === 'exact_match' ? 'Exact Match' : group.match_type === 'high_similarity' ? 'High Similarity' : 'Possible Match';

        let itemsHtml = '';
        group.products.forEach(p => {
          itemsHtml += `<div class="dedup-item ${p.is_primary ? 'primary' : ''}">
            <span class="dedup-label">${p.is_primary ? 'KEEP' : 'DUPLICATE'}</span>
            <div style="flex:1">
              <div style="font-weight:500;font-size:13px">${p.product_name}</div>
              <div style="font-size:11px;color:var(--gray-500)">ID: ${p.product_id}</div>
            </div>
          </div>`;
        });

        container.innerHTML += `<div class="dedup-group">
          <div class="dedup-group-header">
            <span class="dup-badge">Group ${gi + 1}</span>
            <span>${matchLabel}</span>
            <span style="font-size:12px;color:var(--gray-500);flex:1">${group.reason}</span>
            <span class="dedup-match-score">${matchPct}% match</span>
          </div>
          ${itemsHtml}
          <div class="dedup-actions">
            <button class="btn btn-sm btn-secondary" onclick="this.textContent='Skipped';this.disabled=true">Skip</button>
            <button class="btn btn-sm btn-success" onclick="this.innerHTML='&#x2705; Merged';this.disabled=true;this.closest('.dedup-group').style.opacity='0.5'">Merge &amp; Keep Primary</button>
          </div>
        </div>`;
      });

      btn.innerHTML = `&#x1F504; ${groups.length} Duplicate${groups.length !== 1 ? 's' : ''} Found`;
      btn.style.background = 'rgba(230,126,34,0.1)';
      btn.style.color = 'var(--orange)';
      btn.style.borderColor = 'var(--orange)';
    }

    // Scroll to results
    document.getElementById('bulk-dedup-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    hideLoading();
    btn.disabled = false;
    btn.innerHTML = '&#x1F504; Deduplicate';
    alert('Error: ' + err.message);
  }
}

function showBulkDetail(idx) {
  const result = bulkResults[idx];
  const product = bulkProducts[idx];
  const card = document.getElementById('bulk-detail-card');
  const body = document.getElementById('bulk-detail-body');
  const title = document.getElementById('bulk-detail-title');

  title.textContent = product.product_name;

  if (!result) {
    body.innerHTML = `<div class="empty-state" style="padding:24px"><h3>Not yet processed</h3><p>Click "Process All Products" to run ingestion + enrichment</p></div>`;
    card.style.display = 'block';
    return;
  }

  // Build detail view
  let attrsHtml = '';
  if (result.attributes) {
    Object.entries(result.attributes).forEach(([key, val]) => {
      const v = typeof val === 'object' ? val : { value: val, confidence: 0.85 };
      attrsHtml += `<tr>
        <td class="field-name">${key}</td>
        <td>${v.value}</td>
        <td>${sourceTag(v.source, v.source_detail)}</td>
        <td>${confidenceBadge(v.confidence || 0.85)}</td>
      </tr>`;
    });
  }

  let visualHtml = '';
  if (result.visual_attributes) {
    Object.entries(result.visual_attributes).forEach(([key, val]) => {
      visualHtml += `<div class="visual-attr"><div class="va-name">${key}</div><div class="va-value">${val}</div></div>`;
    });
  }

  let issuesHtml = '';
  if (result.dq_issues && result.dq_issues.length) {
    issuesHtml = '<div style="margin-top:12px"><h4 style="font-size:12px;font-weight:600;color:var(--red);margin-bottom:6px">DQ ISSUES</h4><ul style="margin:0;padding-left:16px;font-size:13px;color:var(--gray-600)">' +
      result.dq_issues.map(issue => `<li>${issue}</li>`).join('') + '</ul></div>';
  }

  let sourcesHtml = '';
  if (result.sources_consulted && result.sources_consulted.length) {
    sourcesHtml = '<div style="margin-top:16px"><h4 style="font-size:12px;font-weight:600;color:var(--gray-500);margin-bottom:6px">SOURCES CONSULTED</h4>';
    result.sources_consulted.forEach(s => {
      sourcesHtml += `<div class="source-row" style="padding:6px 0">
        <div class="source-info">
          <div class="source-name" style="font-size:12px">${s.name}</div>
          ${s.url ? `<div class="source-url">${s.url}</div>` : ''}
        </div>
        <span class="source-status ${(s.status || 'verified').replace(/ /g, '_')}">${s.status || 'verified'}</span>
      </div>`;
    });
    sourcesHtml += '</div>';
  }

  const cat = result.category;
  const imgUrl = result._imageUrl;

  body.innerHTML = `
    <div class="two-col" style="margin-bottom:16px">
      <div>
        <div class="product-summary" style="display:grid;grid-template-columns:1fr;gap:8px;margin-bottom:12px">
          <div class="product-field"><label>Product ID</label><div class="value">${result._productId}</div></div>
          <div class="product-field"><label>Product Name</label><div class="value">${result.product_name || result._originalName}</div></div>
          ${result.brand ? `<div class="product-field"><label>Brand</label><div class="value">${result.brand}</div></div>` : ''}
          ${cat ? `<div class="product-field"><label>Category</label><div class="value">${cat.category || ''} &rarr; ${cat.class || ''} ${confidenceBadge(cat.confidence || 0.85)}</div></div>` : ''}
          <div class="product-field"><label>ACR Score</label><div class="value" style="font-size:20px;font-weight:700;color:${(result.acr_score||0) >= 75 ? 'var(--green)' : 'var(--orange)'}">${result.acr_score || 0}%</div></div>
        </div>
        ${result.generated_copy ? `
          <div class="product-field" style="margin-bottom:8px"><label>Generated Title</label><div class="value" style="font-weight:600">${result.generated_copy.product_title || ''}</div></div>
          <div class="product-field"><label>Generated Description</label><div class="value" style="font-size:13px">${result.generated_copy.short_description || ''}</div></div>
        ` : ''}
      </div>
      <div>
        ${imgUrl ? `<img src="${imgUrl}" style="width:100%;max-height:250px;object-fit:contain;border-radius:8px;border:1px solid var(--gray-200);margin-bottom:12px" onerror="this.style.display='none'">` : ''}
        ${visualHtml ? `<div class="visual-grid" style="grid-template-columns:1fr 1fr">${visualHtml}</div>` : ''}
      </div>
    </div>
    ${attrsHtml ? `
    <h4 style="font-size:12px;font-weight:600;color:var(--gray-500);margin-bottom:8px">EXTRACTED ATTRIBUTES</h4>
    <table class="attr-table" style="font-size:12px">
      <thead><tr><th>Attribute</th><th>Value</th><th>Source</th><th>Confidence</th></tr></thead>
      <tbody>${attrsHtml}</tbody>
    </table>` : ''}
    ${issuesHtml}
    ${sourcesHtml}
  `;

  card.style.display = 'block';
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── INIT ──────────────────────────────────────────────────
initDashboard();

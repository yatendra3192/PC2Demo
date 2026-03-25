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
  if (score > 1) score = score / 100; // Normalize 0-100 to 0-1
  const pct = Math.round(score * 100);
  let cls = 'high';
  if (score < 0.7) cls = 'low';
  else if (score < 0.85) cls = 'medium';
  return `<span class="confidence ${cls}">${pct}%</span>`;
}

// Compute ACR consistently across all views (enrichment, dashboard, DQ)
function computeACR(product, template) {
  const attrs = { ...(product.attributes || {}), ...(product.specifications || {}) };
  const attrKeys = Object.keys(attrs);
  let filled = 0;
  const missingNames = [];

  attrKeys.forEach(key => {
    const val = typeof attrs[key] === 'object' ? attrs[key].value : attrs[key];
    if (val && val !== 'null' && val !== 'N/A' && val !== '') {
      filled++;
    } else {
      missingNames.push(key);
    }
  });

  // Cross-reference against template — required attrs not in extracted data
  if (template) {
    const allTemplateAttrs = [...(template.required || []), ...(template.optional || [])];
    allTemplateAttrs.forEach(reqAttr => {
      const found = attrKeys.find(k => k.toLowerCase() === reqAttr.toLowerCase());
      if (!found) missingNames.push(reqAttr);
    });
  }

  const missing = missingNames.length;
  const total = filled + missing;
  const acr = total > 0 ? Math.round((filled / total) * 100) : 0;
  return { filled, total, missing, acr, missingNames };
}

// Strip large fields before sending to API
function cleanProductData(product) {
  if (!product) return product;
  const clean = { ...product };
  delete clean._thumbnail;
  delete clean._fileName;
  if (clean.extracted_text && clean.extracted_text.length > 2000) {
    clean.extracted_text = clean.extracted_text.substring(0, 2000);
  }
  if (clean.description && clean.description.length > 3000) {
    clean.description = clean.description.substring(0, 3000);
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

// Multi-source tag renderer for extraction pipeline
function multiSourceTags(sources) {
  if (!sources) return '';
  // Handle both array and single string
  const srcArray = Array.isArray(sources) ? sources : [sources];
  if (srcArray.length === 0) return '';
  const srcMap = {
    'pdf': ['kb', 'PDF'],
    'image': ['image', 'Image'],
    'description': ['web', 'Description'],
    'inferred': ['inference', 'Inferred'],
    'user_edit': ['', 'User Edit'],
    'pdp_page': ['web', 'PDP Page'],
    'pdf_reanalysis': ['kb', 'PDF (re-scan)'],
  };
  return srcArray.map(s => {
    // Normalize objects to strings (LLM may return {source: "pdf"} instead of "pdf")
    const key = (typeof s === 'object' && s !== null) ? (s.source || s.type || s.name || String(s)) : s;
    const [cls, label] = srcMap[key] || ['', key];
    return `<span class="source-tag ${cls}">${label}</span>`;
  }).join(' ');
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
      const dataUrl = reader.result || '';
      const base64Part = dataUrl.indexOf(',') !== -1 ? dataUrl.split(',')[1] : '';
      localPreviews[i] = { dataUrl: dataUrl, base64: base64Part, mime: file.type };
      thumbGrid.innerHTML += `<img class="thumb-item" src="${dataUrl}" title="${file.name}">`;
      // Store first image for enrichment
      if (i === 0) {
        uploadedImageBase64 = base64Part;
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
      try {
        const thumb = products[0]._thumbnail;
        uploadedImageBase64 = thumb.indexOf(',') !== -1 ? thumb.split(',')[1] : '';
        const mimeMatch = thumb.match(/^data:([^;]+);/);
        uploadedImageMime = mimeMatch ? mimeMatch[1] : null;
      } catch (e) {
        uploadedImageBase64 = null;
        uploadedImageMime = null;
      }
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
    // Save category back to currentProduct for downstream use
    currentProduct.category = { category: cat.category, class: cat.class, classId: cat.classId, confidence: cat.confidence };

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

  // Reset stale enrichment state from previous sessions
  document.getElementById('enrich-product-switcher').style.display = 'none';
  document.getElementById('enrichment-done').style.display = 'none';
  document.getElementById('copy-results').classList.remove('visible');
  document.getElementById('image-enrich-results').classList.remove('visible');
  document.getElementById('imagen-results').classList.remove('visible');
  document.getElementById('acr-after-card').style.display = 'none';
  document.getElementById('enrich-sources-container').innerHTML = '';
  document.getElementById('run-enrichment-btn').textContent = '🤖 Run Enrichment';
  document.getElementById('run-enrichment-btn').disabled = false;
  document.getElementById('gen-copy-btn').textContent = '✍ Generate Copy';
  document.getElementById('gen-copy-btn').disabled = false;

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

  const imgGenBtn = document.getElementById('gen-image-btn');
  if (imgGenBtn) { imgGenBtn.textContent = '🎨 Generate Lifestyle Image'; imgGenBtn.disabled = false; }

  // Hide previous results from all sub-tabs
  document.getElementById('copy-results').classList.remove('visible');
  document.getElementById('image-enrich-results').classList.remove('visible');
  document.getElementById('imagen-results').classList.remove('visible');

  // Populate attributes table
  populateEnrichmentTable();

  // Setup image for enrichment
  if (product._imageUrl) {
    document.getElementById('image-enrich-preview').innerHTML =
      `<img src="${product._imageUrl}" style="max-width:100%;max-height:250px;border-radius:8px;border:1px solid var(--gray-200)" onerror="this.style.display='none'">`;
    document.getElementById('run-image-enrichment-btn').style.display = '';
    // We don't have base64 for URL images, so set flag for server-side fetch
    uploadedImageBase64 = null;
    uploadedImageMime = null;
  } else {
    document.getElementById('image-enrich-preview').innerHTML =
      '<div class="empty-state" style="padding:30px"><div class="icon">&#x1F4F7;</div><h3>No image available</h3></div>';
    document.getElementById('run-image-enrichment-btn').style.display = 'none';
  }

  // Hide enrichment-done until user actually runs enrichment on this product
  document.getElementById('enrichment-done').style.display = 'none';
}

function populateEnrichmentTable() {
  const tbody = document.getElementById('enrich-attrs-body');
  tbody.innerHTML = '';

  const attrs = { ...(currentProduct.attributes || {}), ...(currentProduct.specifications || {}) };

  // Get template for this product
  const bulkIdx = currentProduct._bulkIndex;
  const tpl = (bulkIdx !== undefined && pipelineState.templates[bulkIdx]) ? pipelineState.templates[bulkIdx].template : null;
  const acrData = computeACR(currentProduct, tpl);

  const attrKeys = Object.keys(attrs);
  attrKeys.forEach(key => {
    const val = typeof attrs[key] === 'object' ? attrs[key] : { value: attrs[key], confidence: 0.9 };
    if (!val.value || val.value === '' || val.value === 'N/A') return;
    tbody.innerHTML += `<tr>
      <td class="field-name">${key}</td>
      <td>${val.value}</td>
      <td>${sourceTag(val.source || 'product_data', val.source_detail)}</td>
      <td>${confidenceBadge(val.confidence || 0.9)}</td>
    </tr>`;
  });

  document.getElementById('acr-before-val').textContent = acrData.acr + '%';
  document.getElementById('acr-before-detail').textContent = `${acrData.filled} of ${acrData.total} attributes filled`;

  const circle = document.getElementById('acr-before-circle');
  circle.className = 'acr-circle ' + (acrData.acr < 50 ? 'low' : acrData.acr < 75 ? 'medium' : 'high');
}

// ── 4a: RUN ENRICHMENT (PDP gap-fill first, then standard) ─
async function runEnrichment() {
  if (!currentProduct) return;

  const hasPdp = currentProduct.pdp_url;
  const hasPdf = currentProduct.pdf_urls && currentProduct.pdf_urls.length > 0;

  // Try gap-fill with PDP/PDF first if available
  if (hasPdp || hasPdf) {
    showLoading('Gap Filling', hasPdp ? 'Fetching PDP page for missing attributes...' : 'Re-analyzing PDF for missing attributes...');

    try {
      // Figure out which attributes are missing
      const attrs = { ...currentProduct.attributes, ...currentProduct.specifications };
      const allKeys = Object.keys(attrs);
      const missingAttrs = allKeys.filter(k => {
        const v = typeof attrs[k] === 'object' ? attrs[k].value : attrs[k];
        return !v || v === 'null' || v === 'N/A';
      });

      if (missingAttrs.length > 0) {
        const gapRes = await fetch('/api/enrich/gap-fill', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            product: cleanProductData(currentProduct),
            missingAttributes: missingAttrs,
            pdpUrl: currentProduct.pdp_url || '',
            pdfUrls: currentProduct.pdf_urls || [],
            imageUrls: currentProduct.image_urls || []
          })
        });
        const gapJson = await gapRes.json();

        if (gapJson.success && gapJson.data.filled) {
          // Merge gap-filled attributes into currentProduct
          Object.entries(gapJson.data.filled).forEach(([key, val]) => {
            if (val.value && val.value !== 'null') {
              if (!currentProduct.attributes) currentProduct.attributes = {};
              currentProduct.attributes[key] = {
                value: val.value,
                confidence: val.confidence || 0.8,
                source: val.source || 'gap_fill',
                was_missing: true
              };
            }
          });
        }
      }
    } catch (gapErr) {
      console.log('Gap-fill step failed, continuing with standard enrichment:', gapErr.message);
    }
  }

  showLoading('Running Enrichment', 'Filling remaining gaps from Knowledge Base and category inference...');

  try {
    const res = await fetch('/api/enrich/attributes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productData: cleanProductData(currentProduct),
        category: (currentProduct.category && currentProduct.category.category)
          ? currentProduct.category.category + ' > ' + (currentProduct.category.class || '')
          : 'General',
        classId: currentProduct.category ? currentProduct.category.classId : null
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

    Object.entries(enriched.enriched_attributes || enriched.attributes || {}).forEach(([key, val]) => {
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

    // Compute real ACR after enrichment (don't trust LLM hallucinated values)
    const bulkIdx = currentProduct._bulkIndex;
    const tpl = (bulkIdx !== undefined && pipelineState.templates[bulkIdx]) ? pipelineState.templates[bulkIdx].template : null;
    const acrBeforeData = computeACR(currentProduct, tpl);
    // Write enriched attributes back to currentProduct so DQ/dashboard see them
    currentProduct.attributes = enriched.enriched_attributes || enriched.attributes || {};
    currentProduct.specifications = {};
    const acrAfterData = computeACR(currentProduct, tpl);

    document.getElementById('acr-before-val').textContent = acrBeforeData.acr + '%';
    document.getElementById('acr-after-card').style.display = 'block';
    document.getElementById('acr-after-val').textContent = acrAfterData.acr + '%';
    document.getElementById('acr-improvement').innerHTML = `&#x2B06; +${acrAfterData.acr - acrBeforeData.acr}% &mdash; ${gapsFilled} gaps filled`;

    // Show sources consulted
    if (enriched.sources_consulted && enriched.sources_consulted.length) {
      document.getElementById('enrich-sources-container').innerHTML = '';
      renderSourcesPanel('enrich-sources-container', enriched.sources_consulted, 'Data Sources Consulted — Verified Origins', 'sources');
    }
    const pdpNote = currentProduct.pdp_url ? ' (PDP page + KB sources)' : ' (KB + verified sources)';
    document.getElementById('enrich-gap-warning').innerHTML = `&#x2705; Attribute gaps filled${pdpNote} — see sources panel above`;
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
        <div class="content">${(copy.long_description || '').replace(/\n/g, '<br>')}</div>
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

  // Refresh dashboard with real product data
  refreshDashboard();

  // Populate DQ product selector from whatever products we have
  const products = enrichProductList.length > 0 ? enrichProductList : allIngestedProducts;
  if (products.length > 0) {
    populateDQSelector(products);
  }
}

// ── ATHENA DASHBOARD ──────────────────────────────────────
// ── DQ ISSUE DETAIL MODAL ─────────────────────────────────
function showDQIssueModal(idx) {
  const iss = (window._dqIssuesList || [])[idx];
  if (!iss) return;

  const modal = document.getElementById('dq-issue-modal');
  const title = document.getElementById('dq-modal-title');
  const body = document.getElementById('dq-modal-body');

  title.textContent = `${iss.product} — ${iss.count} Missing Attributes`;

  let html = `<div style="display:flex;gap:16px;margin-bottom:16px">
    <div class="stat-card red" style="flex:1;padding:14px">
      <div class="stat-label">Missing</div>
      <div class="stat-value" style="font-size:22px">${iss.count}</div>
    </div>
    <div class="stat-card green" style="flex:1;padding:14px">
      <div class="stat-label">Filled</div>
      <div class="stat-value" style="font-size:22px">${iss.filled}</div>
    </div>
    <div class="stat-card blue" style="flex:1;padding:14px">
      <div class="stat-label">ACR</div>
      <div class="stat-value" style="font-size:22px">${iss.acr}%</div>
    </div>
  </div>`;

  html += '<div style="font-size:12px;font-weight:600;color:var(--gray-500);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Missing Attributes</div>';
  html += '<div style="margin-bottom:16px">';
  (iss.allMissing || []).forEach(attr => {
    html += `<span class="missing-attr-chip">${escapeForHtml(attr)}</span>`;
  });
  html += '</div>';

  body.innerHTML = html;
  modal.classList.add('visible');
}

function closeDQModal() {
  document.getElementById('dq-issue-modal').classList.remove('visible');
}

function initDashboard() {
  // Show real data from processed products
  refreshDashboard();
}

function refreshDashboard() {
  const products = enrichProductList.length > 0 ? enrichProductList : allIngestedProducts;

  if (products.length === 0) {
    document.getElementById('athena-dash-empty').style.display = 'block';
    document.getElementById('athena-dash-content').style.display = 'none';
    return;
  }

  document.getElementById('athena-dash-empty').style.display = 'none';
  document.getElementById('athena-dash-content').style.display = 'block';

  // Compute real stats from products
  const totalSkus = products.length;
  let totalFilled = 0;
  let totalRequired = 0;
  let totalMissing = 0;
  const productStats = [];
  const issuesList = [];

  products.forEach((p, idx) => {
    const bulkIdx = p._bulkIndex !== undefined ? p._bulkIndex : undefined;
    const tpl = (bulkIdx !== undefined && pipelineState.templates[bulkIdx]) ? pipelineState.templates[bulkIdx].template : null;
    const acrData = computeACR(p, tpl);

    totalFilled += acrData.filled;
    totalRequired += acrData.total;
    totalMissing += acrData.missing;

    const name = p.product_name || p._productId || 'Unknown';
    productStats.push({ name, acr: acrData.acr, filled: acrData.filled, total: acrData.total, missing: acrData.missing });

    if (acrData.missing > 0) {
      issuesList.push({
        product: name,
        issue: `Missing ${acrData.missingNames.slice(0, 3).join(', ')}${acrData.missingNames.length > 3 ? ` (+${acrData.missingNames.length - 3} more)` : ''}`,
        count: acrData.missing,
        allMissing: acrData.missingNames,
        filled: acrData.filled,
        total: acrData.total,
        acr: acrData.acr
      });
    }
  });

  const overallAcr = totalRequired > 0 ? Math.round((totalFilled / totalRequired) * 100) : 0;

  // Update stat cards
  document.getElementById('dash-total-skus').textContent = totalSkus;
  document.getElementById('dash-overall-acr').textContent = overallAcr + '%';
  document.getElementById('dash-overall-acr').style.color = overallAcr >= 75 ? 'var(--green)' : overallAcr >= 50 ? 'var(--orange)' : 'var(--red)';
  document.getElementById('dash-missing-attrs').textContent = totalMissing;
  document.getElementById('dash-missing-sub').textContent = `Across ${totalSkus} products`;

  // ACR by Product bars
  const barsContainer = document.getElementById('dash-product-bars');
  barsContainer.innerHTML = '';
  productStats.sort((a, b) => b.acr - a.acr).forEach(ps => {
    const cls = ps.acr < 50 ? 'low' : ps.acr < 75 ? 'medium' : 'high';
    const color = ps.acr < 50 ? 'var(--red)' : ps.acr < 75 ? 'var(--orange)' : 'var(--green)';
    barsContainer.innerHTML += `<div class="category-row">
      <span class="cat-name" style="width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeForHtml(ps.name)}">${escapeForHtml(ps.name)}</span>
      <div class="cat-bar-container">
        <div class="cat-bar ${cls}" style="width:${ps.acr}%"></div>
      </div>
      <span class="cat-score" style="color:${color}">${ps.acr}%</span>
      <span class="cat-issues">${ps.filled}/${ps.total}</span>
    </div>`;
  });

  // Top DQ Issues
  const issuesBody = document.getElementById('dash-issues-body');
  // Store issues globally for modal access
  window._dqIssuesList = [];
  issuesBody.innerHTML = '';
  if (issuesList.length === 0) {
    issuesBody.innerHTML = '<tr><td colspan="3" style="text-align:center;padding:20px;color:var(--green)">No missing attributes found</td></tr>';
  } else {
    issuesList.sort((a, b) => b.count - a.count);
    window._dqIssuesList = issuesList;
    issuesList.forEach((iss, idx) => {
      issuesBody.innerHTML += `<tr class="bulk-row" onclick="showDQIssueModal(${idx})" title="Click to view all missing attributes">
        <td class="field-name">${escapeForHtml(iss.product)}</td>
        <td style="font-size:12px;color:var(--gray-600)">${escapeForHtml(iss.issue)}</td>
        <td><span class="confidence ${iss.count > 3 ? 'low' : iss.count > 1 ? 'medium' : 'high'}">${iss.count} missing</span></td>
      </tr>`;
    });
  }
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
  messagesEl.innerHTML += `<div class="chat-msg user">${escapeForHtml(text)}</div>`;

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
    const typingEl = document.getElementById(typingId);
    if (typingEl) typingEl.remove();

    if (!json.success) throw new Error(json.error);

    chatHistory.push({ role: 'assistant', content: json.reply });

    // Format the response (escape first, then apply basic markdown-like formatting)
    let formatted = escapeForHtml(json.reply)
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n\n/g, '<br><br>')
      .replace(/\n- /g, '<br>• ')
      .replace(/\n(\d+)\. /g, '<br>$1. ')
      .replace(/\n/g, '<br>');

    messagesEl.innerHTML += `<div class="chat-msg assistant">${formatted}</div>`;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } catch (err) {
    const typingEl = document.getElementById(typingId);
    if (typingEl) typingEl.remove();
    messagesEl.innerHTML += `<div class="chat-msg assistant" style="color:var(--red)">Error: ${escapeForHtml(err.message)}</div>`;
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

// ── BULK UPLOAD — 4-STEP WIZARD PIPELINE ──────────────────
let bulkProducts = [];
let bulkResults = {};

// Pipeline state for wizard
let pipelineState = {
  step: 1,
  products: [],
  categories: [],
  templates: [],
  extractedData: {},
  userEdits: {},
  dedupDecisions: {}
};

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
    pipelineState.products = bulkProducts;
    pipelineState.step = 1;

    // Hide upload section, show wizard
    document.getElementById('bulk-upload-section').style.display = 'none';
    document.getElementById('bulk-wizard').style.display = 'block';
    document.getElementById('bulk-wizard-file-info').textContent =
      `${bulkProducts.length} products parsed from "${file.name || 'Excel file'}"`;

    // Populate Step 1 category table
    const tbody = document.getElementById('wiz-cat-table-body');
    tbody.innerHTML = '';
    bulkProducts.forEach((p, i) => {
      tbody.innerHTML += `<tr>
        <td style="font-weight:600;color:var(--gray-500)">${i + 1}</td>
        <td style="font-size:12px">${p.product_id}</td>
        <td>
          <div style="font-weight:500;color:var(--gray-800)">${p.product_name}</div>
          <div style="font-size:10px;color:var(--gray-400)">${p.pdf_urls.length} PDF | ${p.image_urls.length} img${p.pdp_url ? ' | PDP' : ''}</div>
        </td>
        <td id="wiz-cat-cat-${i}"><span style="color:var(--gray-400)">—</span></td>
        <td id="wiz-cat-cls-${i}"><span style="color:var(--gray-400)">—</span></td>
        <td id="wiz-cat-conf-${i}"><span style="color:var(--gray-400)">—</span></td>
      </tr>`;
    });

    goToStep(1);
  } catch (err) {
    hideLoading();
    alert('Error: ' + err.message);
  }
}, true);

function resetBulkWizard() {
  bulkProducts = [];
  bulkResults = {};
  pipelineState = { step: 1, products: [], categories: [], templates: [], extractedData: {}, userEdits: {}, dedupDecisions: {}, dedupGroups: null };
  // Clear all global state that leaks across sessions
  allIngestedProducts = [];
  enrichProductList = [];
  currentProduct = null;
  uploadedImageBase64 = null;
  uploadedImageMime = null;
  document.getElementById('bulk-wizard').style.display = 'none';
  document.getElementById('bulk-upload-section').style.display = 'block';
  document.getElementById('bulk-file-input').value = '';
  // Reset all wizard buttons
  ['wiz-categorize-btn', 'wiz-template-btn', 'wiz-extract-btn', 'wiz-dedup-btn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) { btn.disabled = false; }
  });
  ['wiz-next-1', 'wiz-next-2', 'wiz-next-3'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = true;
  });
}

// ── WIZARD NAVIGATION ─────────────────────────────────────
function goToStep(n) {
  pipelineState.step = n;

  // Update wizard nav
  document.querySelectorAll('.wizard-step').forEach(s => {
    const stepNum = parseInt(s.dataset.wizStep);
    s.classList.remove('active', 'completed');
    if (stepNum === n) s.classList.add('active');
    else if (stepNum < n) s.classList.add('completed');
  });

  // Update connectors
  const connectors = document.querySelectorAll('.wizard-connector');
  connectors.forEach((c, i) => {
    c.classList.toggle('completed', i < n - 1);
  });

  // Show/hide panels
  document.querySelectorAll('.wizard-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById(`wizard-step-${n}`);
  if (panel) panel.classList.add('active');
}

// ── STEP 1: BATCH CATEGORIZE ──────────────────────────────
async function runBatchCategorize() {
  if (bulkProducts.length === 0) return;

  const btn = document.getElementById('wiz-categorize-btn');
  btn.disabled = true;
  btn.innerHTML = '&#x23F3; Categorizing...';

  showLoading('Batch Categorization', `Classifying ${bulkProducts.length} products in one API call...`);

  try {
    const res = await fetch('/api/ingest/bulk/categorize-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ products: bulkProducts })
    });
    const json = await res.json();
    hideLoading();

    if (!json.success) throw new Error(json.error);

    const categories = json.data.categories || [];
    // Reindex categories by their index field so downstream lookups by product index are correct
    const reindexed = [];
    categories.forEach(cat => {
      const idx = cat.index !== undefined ? cat.index : reindexed.length;
      reindexed[idx] = cat;
    });
    pipelineState.categories = reindexed;

    // Update table rows
    categories.forEach((cat, i) => {
      const idx = cat.index !== undefined ? cat.index : i;
      const catEl = document.getElementById(`wiz-cat-cat-${idx}`);
      const clsEl = document.getElementById(`wiz-cat-cls-${idx}`);
      const confEl = document.getElementById(`wiz-cat-conf-${idx}`);
      if (catEl) catEl.innerHTML = `<span class="bulk-cat-tag">${cat.category || '—'}</span>`;
      if (clsEl) clsEl.innerHTML = `<span style="font-weight:500;color:var(--blue)">${cat.class || '—'}</span>${cat.classId ? `<span style="display:block;font-size:10px;color:var(--gray-400)">ID: ${cat.classId}</span>` : ''}`;
      if (confEl) confEl.innerHTML = confidenceBadge(cat.confidence || 0.85);
    });

    btn.innerHTML = '&#x2705; Categorized';
    document.getElementById('wiz-next-1').disabled = false;
  } catch (err) {
    hideLoading();
    btn.disabled = false;
    btn.innerHTML = '&#x1F916; Categorize All Products';
    alert('Error: ' + err.message);
  }
}

// ── STEP 2: LOAD TEMPLATES ────────────────────────────────
async function loadTemplates() {
  const btn = document.getElementById('wiz-template-btn');
  btn.disabled = true;
  btn.innerHTML = '&#x23F3; Loading...';

  // Build product list with categories + classId from KB
  const productsWithCats = bulkProducts.map((p, i) => {
    const cat = pipelineState.categories[i] || {};
    return {
      index: i,
      product_id: p.product_id,
      product_name: p.product_name,
      category: cat.category || '',
      class: cat.class || '',
      classId: cat.classId || ''
    };
  });

  try {
    const res = await fetch('/api/ingest/bulk/get-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ products: productsWithCats })
    });
    const json = await res.json();

    if (!json.success) throw new Error(json.error);

    pipelineState.templates = json.data.templates || [];

    // Render template cards
    const container = document.getElementById('wiz-templates-container');
    container.innerHTML = '';

    pipelineState.templates.forEach((tpl, i) => {
      const reqHtml = (tpl.template.required || []).map(a =>
        `<span class="required-badge">${a}</span>`
      ).join('');
      const optHtml = (tpl.template.optional || []).map(a =>
        `<span class="optional-badge">${a}</span>`
      ).join('');

      const sourceBadge = tpl.source === 'Knowledge Base'
        ? '<span class="source-tag kb" style="font-size:10px">KB</span>'
        : '<span class="source-tag inference" style="font-size:10px">Default</span>';
      const classIdLabel = tpl.classId ? ` | Class ID: ${tpl.classId}` : '';

      container.innerHTML += `<div class="template-product-card">
        <div class="template-product-header">
          <span class="tpl-num">${i + 1}</span>
          <div style="flex:1">
            <div style="font-weight:600;font-size:13px">${tpl.product_name}</div>
            <div style="font-size:11px;color:var(--gray-500)">${tpl.category} &rarr; ${tpl.class}${classIdLabel}</div>
          </div>
          ${sourceBadge}
        </div>
        <div style="margin-bottom:6px;font-size:11px;font-weight:600;color:var(--gray-500)">REQUIRED (${(tpl.template.required || []).length})</div>
        <div class="template-attrs" style="margin-bottom:10px">${reqHtml || '<span style="color:var(--gray-400);font-size:12px">None</span>'}</div>
        <div style="font-size:11px;font-weight:600;color:var(--gray-400)">OPTIONAL (${(tpl.template.optional || []).length})</div>
        <div class="template-attrs">${optHtml || '<span style="color:var(--gray-400);font-size:12px">None</span>'}</div>
      </div>`;
    });

    btn.innerHTML = '&#x2705; Templates Loaded';
    document.getElementById('wiz-next-2').disabled = false;
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = '&#x1F4CB; Load Templates';
    alert('Error: ' + err.message);
  }
}

// ── STEP 3: DATA EXTRACTION ──────────────────────────────
async function runDataExtraction() {
  const btn = document.getElementById('wiz-extract-btn');
  btn.disabled = true;
  btn.innerHTML = '&#x23F3; Extracting...';

  const progressEl = document.getElementById('wiz-extract-progress');
  progressEl.style.display = 'block';

  const total = bulkProducts.length;

  // Populate product selector
  const select = document.getElementById('wiz-extract-product-select');
  select.innerHTML = '';
  bulkProducts.forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `${i + 1}. ${p.product_name}`;
    select.appendChild(opt);
  });

  for (let i = 0; i < total; i++) {
    const product = bulkProducts[i];
    const template = pipelineState.templates[i] ? pipelineState.templates[i].template : { required: [], optional: [] };

    document.getElementById('wiz-extract-progress-text').textContent = `${i + 1} / ${total}`;
    document.getElementById('wiz-extract-progress-bar').style.width = `${Math.round(((i + 0.5) / total) * 100)}%`;

    try {
      const res = await fetch('/api/ingest/bulk/extract-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product, template })
      });
      const json = await res.json();

      if (json.success) {
        pipelineState.extractedData[i] = json.data;
      } else {
        pipelineState.extractedData[i] = { error: json.error, attributes: {} };
      }
    } catch (err) {
      pipelineState.extractedData[i] = { error: err.message, attributes: {} };
    }

    document.getElementById('wiz-extract-progress-bar').style.width = `${Math.round(((i + 1) / total) * 100)}%`;
  }

  document.getElementById('wiz-extract-progress-text').textContent = `${total} / ${total}`;

  btn.innerHTML = '&#x2705; Extracted';
  document.getElementById('wiz-next-3').disabled = false;

  // Show first product
  showExtractedProduct(0);
}

function showExtractedProduct(idx) {
  const data = pipelineState.extractedData[idx];
  const template = pipelineState.templates[idx] ? pipelineState.templates[idx].template : { required: [], optional: [] };
  const product = bulkProducts[idx];
  const container = document.getElementById('wiz-extract-table-container');

  document.getElementById('wiz-extract-product-select').value = idx;

  if (!data) {
    container.innerHTML = '<div class="empty-state" style="padding:20px"><h3>Not yet extracted</h3></div>';
    return;
  }

  if (data.error) {
    container.innerHTML = `<div class="flow-indicator warning">&#x26A0; Extraction error: ${data.error}</div>`;
    return;
  }

  const attrs = data.attributes || {};
  const allRequired = template.required || [];
  const allOptional = template.optional || [];

  // Build editable table rows
  let rows = '';

  // Helper: check if value is effectively missing
  function isMissingVal(v) { return !v || v === 'null' || v === 'N/A' || v === 'undefined' || v === 'None'; }
  // Helper: clean display value (don't show "null" in inputs)
  function cleanVal(v) { return isMissingVal(v) ? '' : v; }

  // Required attributes first
  allRequired.forEach(attrName => {
    const attrData = findAttr(attrs, attrName);
    const value = attrData ? (attrData.value || '') : '';
    const conf = attrData ? attrData.confidence : 0;
    const sources = attrData ? (attrData.sources || attrData.source || '') : '';
    const missing = isMissingVal(value);
    const userEdit = pipelineState.userEdits[`${idx}_${attrName}`];

    rows += `<tr class="${missing && !userEdit ? 'missing-attr-row' : ''}">
      <td class="field-name">${attrName} <span class="required-badge">REQ</span></td>
      <td><input class="inline-edit ${userEdit ? 'user-edited' : ''}" value="${escapeHtml(userEdit || cleanVal(value))}" data-product="${idx}" data-attr="${attrName}" onchange="handleCellEdit(this)"></td>
      <td>${!missing && sources ? multiSourceTags(sources) : (missing ? '<span style="color:var(--red);font-size:11px">missing</span>' : '')}</td>
      <td>${!missing && conf ? confidenceBadge(conf) : (missing ? '' : '')}</td>
    </tr>`;
  });

  // Optional attributes
  allOptional.forEach(attrName => {
    const attrData = findAttr(attrs, attrName);
    const value = attrData ? (attrData.value || '') : '';
    const conf = attrData ? attrData.confidence : 0;
    const sources = attrData ? (attrData.sources || attrData.source || '') : '';
    const missing = isMissingVal(value);
    const userEdit = pipelineState.userEdits[`${idx}_${attrName}`];

    rows += `<tr>
      <td class="field-name">${attrName} <span class="optional-badge">OPT</span></td>
      <td><input class="inline-edit ${userEdit ? 'user-edited' : ''}" value="${escapeHtml(userEdit || cleanVal(value))}" data-product="${idx}" data-attr="${attrName}" onchange="handleCellEdit(this)"></td>
      <td>${!missing && sources ? multiSourceTags(sources) : ''}</td>
      <td>${!missing && conf ? confidenceBadge(conf) : ''}</td>
    </tr>`;
  });

  // Any extra attributes from extraction not in template
  Object.keys(attrs).forEach(key => {
    const normalized = key.toLowerCase();
    const inTemplate = [...allRequired, ...allOptional].some(t => t.toLowerCase() === normalized);
    if (!inTemplate) {
      const attrData = attrs[key];
      const value = typeof attrData === 'object' ? (attrData.value || '') : attrData;
      const conf = typeof attrData === 'object' ? attrData.confidence : 0.85;
      const sources = typeof attrData === 'object' ? (attrData.sources || attrData.source || '') : '';
      const missing = isMissingVal(value);
      const userEdit = pipelineState.userEdits[`${idx}_${key}`];

      rows += `<tr>
        <td class="field-name">${key}</td>
        <td><input class="inline-edit ${userEdit ? 'user-edited' : ''}" value="${escapeHtml(userEdit || cleanVal(value))}" data-product="${idx}" data-attr="${key}" onchange="handleCellEdit(this)"></td>
        <td>${!missing && sources ? multiSourceTags(sources) : ''}</td>
        <td>${!missing && conf ? confidenceBadge(conf) : ''}</td>
      </tr>`;
    }
  });

  const missingCount = allRequired.filter(a => {
    const d = findAttr(attrs, a);
    const userEdit = pipelineState.userEdits[`${idx}_${a}`];
    return !userEdit && (!d || !d.value || d.value === 'null' || d.value === 'N/A');
  }).length;

  container.innerHTML = `
    ${missingCount > 0 ? `<div class="flow-indicator warning" style="margin-bottom:12px">&#x26A0; ${missingCount} required attribute${missingCount !== 1 ? 's' : ''} missing — highlighted in red</div>` : '<div class="flow-indicator" style="margin-bottom:12px">&#x2705; All required attributes populated</div>'}
    <div style="font-size:13px;font-weight:600;color:var(--gray-700);margin-bottom:8px">${data.product_name || product.product_name} <span style="font-weight:400;color:var(--gray-500)">(${product.product_id})</span></div>
    ${data.extraction_summary ? `<div style="font-size:12px;color:var(--gray-500);margin-bottom:12px">${data.extraction_summary}</div>` : ''}
    <table class="attr-table" style="font-size:12px">
      <thead>
        <tr><th>Attribute</th><th>Value</th><th>Source</th><th>Confidence</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function findAttr(attrs, name) {
  // Case-insensitive attribute lookup
  const key = Object.keys(attrs).find(k => k.toLowerCase() === name.toLowerCase());
  if (!key) return null;
  const val = attrs[key];
  if (typeof val === 'object') return val;
  return { value: val, confidence: 0.85, sources: [] };
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeForHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function handleCellEdit(input) {
  const productIdx = input.dataset.product;
  const attrName = input.dataset.attr;
  const value = input.value.trim();

  pipelineState.userEdits[`${productIdx}_${attrName}`] = value;
  input.classList.add('user-edited');

  // Remove missing-attr-row class if user filled it
  if (value) {
    const row = input.closest('tr');
    if (row) row.classList.remove('missing-attr-row');
  }
}

// ── STEP 4: WIZARD DEDUPLICATION ──────────────────────────
async function runWizardDedup() {
  const btn = document.getElementById('wiz-dedup-btn');
  btn.disabled = true;
  btn.innerHTML = '&#x23F3; Scanning...';

  showLoading('Scanning for Duplicates', `Comparing ${bulkProducts.length} products...`);

  try {
    // Build product list with extracted data
    const products = bulkProducts.map((p, i) => {
      const extracted = pipelineState.extractedData[i] || {};
      return {
        product_id: p.product_id,
        product_name: extracted.product_name || p.product_name,
        description: p.description || '',
        brand: extracted.brand || ''
      };
    });

    const res = await fetch('/api/ingest/deduplicate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ products })
    });
    const json = await res.json();
    hideLoading();

    if (!json.success) throw new Error(json.error);

    const data = json.data;
    const groups = data.duplicate_groups || [];
    pipelineState.dedupGroups = groups; // Store for finishWizard to apply merge decisions
    const container = document.getElementById('wiz-dedup-container');

    if (groups.length === 0) {
      container.innerHTML = `
        <div style="text-align:center;padding:30px;color:var(--green)">
          <span style="font-size:48px">&#x2705;</span>
          <h3 style="margin-top:12px">All ${bulkProducts.length} Products Are Unique</h3>
          <p style="color:var(--gray-500)">No duplicate records detected — ready to send to Enrichment</p>
        </div>`;
    } else {
      let html = `<div class="flow-indicator warning" style="margin-bottom:16px">&#x26A0; ${groups.length} duplicate group${groups.length !== 1 ? 's' : ''} found — review below</div>`;

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

        html += `<div class="dedup-group">
          <div class="dedup-group-header">
            <span class="dup-badge">Group ${gi + 1}</span>
            <span>${matchLabel}</span>
            <span style="font-size:12px;color:var(--gray-500);flex:1">${group.reason}</span>
            <span class="dedup-match-score">${matchPct}% match</span>
          </div>
          ${itemsHtml}
          <div class="dedup-actions">
            <button class="btn btn-sm btn-secondary" onclick="wizDedupDecision(${gi},'skip',this)">Skip</button>
            <button class="btn btn-sm btn-success" onclick="wizDedupDecision(${gi},'merge',this)">Merge &amp; Keep Primary</button>
          </div>
        </div>`;
      });

      container.innerHTML = html;
    }

    btn.innerHTML = '&#x2705; Scan Complete';
  } catch (err) {
    hideLoading();
    btn.disabled = false;
    btn.innerHTML = '&#x1F50D; Scan for Duplicates';
    alert('Error: ' + err.message);
  }
}

function wizDedupDecision(groupIdx, decision, btn) {
  pipelineState.dedupDecisions[groupIdx] = decision;
  if (decision === 'merge') {
    btn.innerHTML = '&#x2705; Merged';
    btn.disabled = true;
    btn.closest('.dedup-group').style.opacity = '0.5';
  } else {
    btn.textContent = 'Skipped';
    btn.disabled = true;
  }
}

// ── FINISH WIZARD → SEND TO ENRICHMENT ────────────────────
function finishWizard() {
  // Build set of product indices to exclude (merged duplicates)
  const excludedIndices = new Set();
  if (pipelineState.dedupGroups) {
    pipelineState.dedupGroups.forEach((group, gi) => {
      if (pipelineState.dedupDecisions[gi] === 'merge') {
        group.products.forEach(p => {
          if (!p.is_primary && p.index !== undefined) excludedIndices.add(p.index);
        });
      }
    });
  }

  // Build enrichment product list from wizard data
  const processed = [];
  bulkProducts.forEach((bp, i) => {
    if (excludedIndices.has(i)) return; // Skip merged duplicates

    const extracted = pipelineState.extractedData[i] || {};
    const cat = pipelineState.categories[i] || {};

    // Merge extracted attrs with user edits (use regex to avoid prefix collision for indices 1 vs 10)
    const mergedAttrs = { ...(extracted.attributes || {}) };
    Object.keys(pipelineState.userEdits).forEach(key => {
      const match = key.match(/^(\d+)_(.+)$/);
      if (match && parseInt(match[1]) === i) {
        mergedAttrs[match[2]] = {
          value: pipelineState.userEdits[key],
          confidence: 1.0,
          source: 'user_edit'
        };
      }
    });

    processed.push({
      _bulkIndex: i,
      product_name: extracted.product_name || bp.product_name,
      product_id: bp.product_id,
      brand: extracted.brand || '',
      model_number: extracted.model_number || '',
      description: bp.description || '',
      attributes: mergedAttrs,
      specifications: {},
      category: { category: cat.category || '', class: cat.class || '', classId: cat.classId || '', confidence: cat.confidence || 0 },
      _imageUrl: bp.image_urls[0] || null,
      _productId: bp.product_id,
      pdp_url: bp.pdp_url || '',
      pdf_urls: bp.pdf_urls || [],
      image_urls: bp.image_urls || []
    });
  });

  enrichProductList = processed;

  // Also store in allIngestedProducts and bulkResults for DQ checks
  allIngestedProducts = processed;
  processed.forEach((p, i) => {
    bulkResults[i] = p;
  });

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
  document.getElementById('enrich-switcher-count').textContent = processed.length + ' products loaded from wizard';

  const select = document.getElementById('enrich-product-select');
  select.innerHTML = '';
  processed.forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `${i + 1}. ${p.product_name} (${p._productId})`;
    select.appendChild(opt);
  });

  // Also populate DQ product selector
  populateDQSelector(processed);

  // Load first product
  switchEnrichProduct(0);
}

// ── IMAGE GENERATION (IMAGEN 3) ───────────────────────────
async function generateLifestyleImage() {
  if (!currentProduct) return;

  const customPrompt = document.getElementById('imagen-prompt').value.trim();
  const btn = document.getElementById('gen-image-btn');
  btn.disabled = true;
  btn.innerHTML = '&#x23F3; Generating...';

  showLoading('Generating Image', 'Creating lifestyle product image via Gemini Flash / OpenAI...');

  try {
    const res = await fetch('/api/enrich/generate-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productName: currentProduct.product_name,
        description: currentProduct.description || '',
        category: currentProduct.category ? (currentProduct.category.category + ' > ' + (currentProduct.category.class || '')) : '',
        customPrompt: customPrompt || undefined
      })
    });
    const json = await res.json();
    hideLoading();

    if (!json.success) throw new Error(json.error);

    const data = json.data;
    document.getElementById('imagen-preview').innerHTML =
      `<img src="data:${data.mimeType};base64,${data.imageBase64}" alt="Generated lifestyle image">`;
    document.getElementById('imagen-prompt-used').innerHTML =
      `<strong>Prompt used:</strong> ${data.prompt}`;

    document.getElementById('imagen-results').classList.add('visible');
    btn.innerHTML = '&#x2705; Image Generated';
  } catch (err) {
    hideLoading();
    btn.disabled = false;
    btn.innerHTML = '&#x1F3A8; Generate Lifestyle Image';
    alert('Error: ' + err.message);
  }
}

// ── PRODUCT DQ CHECK (ATHENA) ─────────────────────────────
let dqRecentChecks = [];

function populateDQSelector(products) {
  const select = document.getElementById('dq-product-select');
  select.innerHTML = '<option value="">-- Select a product --</option>';
  (products || enrichProductList || []).forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `${p.product_name} (${p._productId || p.product_id || ''})`;
    select.appendChild(opt);
  });
  if (products && products.length > 0) {
    document.getElementById('dq-empty').style.display = 'none';
  }
}

async function runProductDQ() {
  const select = document.getElementById('dq-product-select');
  const idx = parseInt(select.value);
  if (isNaN(idx)) {
    alert('Select a product first');
    return;
  }

  const products = enrichProductList.length > 0 ? enrichProductList : allIngestedProducts;
  const product = products[idx];
  if (!product) return;

  // Try to get template — use _bulkIndex first, then fall back
  let template = null;
  const bulkIdx = product._bulkIndex;
  if (bulkIdx !== undefined && pipelineState.templates[bulkIdx]) {
    template = pipelineState.templates[bulkIdx].template;
  } else if (pipelineState.templates[idx]) {
    template = pipelineState.templates[idx].template;
  }

  showLoading('Running DQ Check', `Analyzing data quality for ${product.product_name}...`);

  try {
    const res = await fetch('/api/athena/dq-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product: {
          product_id: product._productId || product.product_id,
          product_name: product.product_name,
          description: product.description || '',
          category: product.category ? (product.category.category + ' > ' + (product.category.class || '')) : '',
          classId: product.category ? product.category.classId : null,
          attributes: { ...(product.attributes || {}), ...(product.specifications || {}) }
        },
        template
      })
    });
    const json = await res.json();
    hideLoading();

    if (!json.success) throw new Error(json.error);

    const dq = json.data;

    // Update gauge
    const gauge = document.getElementById('dq-gauge');
    const gaugeVal = document.getElementById('dq-gauge-value');
    gaugeVal.textContent = dq.overall_score;
    gauge.style.setProperty('--score', dq.overall_score);
    gauge.className = 'dq-gauge ' + (dq.overall_score < 50 ? 'low' : dq.overall_score < 75 ? 'medium' : 'high');

    document.getElementById('dq-gauge-label').textContent =
      `Overall DQ Score — ${product.product_name}`;

    // Breakdown cards
    const breakdownGrid = document.getElementById('dq-breakdown-grid');
    breakdownGrid.innerHTML = '';
    const breakdownOrder = ['completeness', 'format', 'range', 'consistency', 'copy_quality'];
    const breakdownLabels = {
      completeness: 'Completeness',
      format: 'Format',
      range: 'Value Range',
      consistency: 'Consistency',
      copy_quality: 'Copy Quality'
    };

    breakdownOrder.forEach(key => {
      const b = dq.breakdown[key];
      if (!b) return;
      const color = b.score < 50 ? 'var(--red)' : b.score < 75 ? 'var(--orange)' : 'var(--green)';
      const issues = (b.issues || b.missing || []).slice(0, 3);
      const issuesHtml = issues.length > 0
        ? `<div class="dq-b-issues">${issues.map(i => `<div style="padding:2px 0">- ${i}</div>`).join('')}</div>`
        : '';

      breakdownGrid.innerHTML += `<div class="dq-breakdown-card">
        <div class="dq-b-label">${breakdownLabels[key] || key}</div>
        <div class="dq-b-score" style="color:${color}">${b.score}</div>
        <div class="dq-b-weight">${b.weight || ''}</div>
        ${issuesHtml}
      </div>`;
    });

    // Recommendations
    const recsContainer = document.getElementById('dq-recommendations');
    recsContainer.innerHTML = '';
    if (dq.recommendations && dq.recommendations.length) {
      recsContainer.innerHTML = '<ul style="margin:0;padding-left:16px;font-size:13px;color:var(--gray-700)">' +
        dq.recommendations.map(r => `<li style="padding:4px 0">${r}</li>`).join('') + '</ul>';
    } else {
      recsContainer.innerHTML = '<p style="color:var(--gray-500);font-size:13px">No specific recommendations</p>';
    }

    // Add to recent checks
    const totalIssues = breakdownOrder.reduce((sum, key) => {
      const b = dq.breakdown[key];
      return sum + ((b && b.issues) || (b && b.missing) || []).length;
    }, 0);

    dqRecentChecks.unshift({
      name: product.product_name,
      sku: product._productId || product.product_id,
      score: dq.overall_score,
      issues: totalIssues,
      time: new Date().toLocaleTimeString()
    });

    // Update recent checks table
    const recentBody = document.getElementById('dq-recent-checks');
    recentBody.innerHTML = '';
    dqRecentChecks.slice(0, 10).forEach(check => {
      const color = check.score < 50 ? 'var(--red)' : check.score < 75 ? 'var(--orange)' : 'var(--green)';
      recentBody.innerHTML += `<tr>
        <td style="font-weight:500;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${check.name}</td>
        <td style="font-size:11px;color:var(--gray-500)">${check.sku}</td>
        <td><span style="font-weight:700;color:${color}">${check.score}</span></td>
        <td>${check.issues > 0 ? `<span style="color:var(--red)">${check.issues}</span>` : '<span style="color:var(--green)">0</span>'}</td>
        <td style="font-size:11px;color:var(--gray-400)">${check.time}</td>
      </tr>`;
    });

    document.getElementById('dq-flow-msg').innerHTML =
      `&#x2705; DQ check complete — score: ${dq.overall_score}/100`;
    document.getElementById('dq-results').classList.add('visible');
  } catch (err) {
    hideLoading();
    alert('Error: ' + err.message);
  }
}

// ── KNOWLEDGE BASE ────────────────────────────────────────
let kbCategoriesCache = [];

async function loadKBStats() {
  try {
    const res = await fetch('/api/kb/stats');
    const json = await res.json();
    if (!json.success) return;
    const s = json.data;
    document.getElementById('kb-stat-cats').textContent = s.totalCategories.toLocaleString();
    document.getElementById('kb-stat-attrs').textContent = s.totalAttributes.toLocaleString();
    document.getElementById('kb-stat-rules').textContent = s.totalRules;
  } catch (e) { console.log('KB stats load error:', e); }
}

async function loadKBCategories() {
  try {
    const search = (document.getElementById('kb-cat-search') || {}).value || '';
    const res = await fetch('/api/kb/categories?search=' + encodeURIComponent(search));
    const json = await res.json();
    if (!json.success) return;

    kbCategoriesCache = json.data.categories;
    document.getElementById('kb-cat-count').textContent = json.data.total;

    const tbody = document.getElementById('kb-cat-table-body');
    tbody.innerHTML = '';
    kbCategoriesCache.forEach(c => {
      const parts = c.path.split('>');
      const pathHtml = parts.map((p, i) =>
        `<span style="color:${i === parts.length - 1 ? 'var(--gray-800);font-weight:600' : 'var(--gray-500)'}">${p.trim()}</span>`
      ).join(' <span style="color:var(--gray-300)">&rsaquo;</span> ');

      tbody.innerHTML += `<tr class="bulk-row" onclick="viewClassAttributes(${c.classId})">
        <td style="font-weight:600;color:var(--blue);font-size:11px">${c.classId}</td>
        <td>${pathHtml}</td>
        <td style="text-align:center">${c.attrCount}</td>
        <td style="text-align:center">${c.mandatoryCount > 0 ? `<span style="color:var(--red);font-weight:600">${c.mandatoryCount}</span>` : '<span style="color:var(--gray-400)">0</span>'}</td>
        <td><button class="btn btn-sm btn-secondary" style="padding:2px 8px;font-size:10px" onclick="event.stopPropagation();viewClassAttributes(${c.classId})">View</button></td>
      </tr>`;
    });

    // Also populate the attribute class dropdown
    const select = document.getElementById('kb-attr-class-select');
    if (select && select.options.length <= 1) {
      kbCategoriesCache.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.classId;
        opt.textContent = `${c.classId} — ${c.path}`;
        select.appendChild(opt);
      });
    }
  } catch (e) { console.log('KB categories load error:', e); }
}

function searchKBCategories() {
  loadKBCategories();
}

function viewClassAttributes(classId) {
  // Switch to attributes sub-tab
  const panel = document.getElementById('panel-kb');
  panel.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
  panel.querySelectorAll('.sub-panel').forEach(p => p.classList.remove('active'));
  panel.querySelector('[data-subtab="kb-attributes"]').classList.add('active');
  document.getElementById('kb-attributes').classList.add('active');

  document.getElementById('kb-attr-class-select').value = classId;
  loadKBAttributes();
}

async function loadKBAttributes() {
  const classId = document.getElementById('kb-attr-class-select').value;
  const search = (document.getElementById('kb-attr-search') || {}).value || '';

  if (!classId && !search) {
    document.getElementById('kb-attr-table-body').innerHTML =
      '<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--gray-400)">Select a class to view attributes</td></tr>';
    document.getElementById('kb-attr-class-path').style.display = 'none';
    return;
  }

  try {
    const res = await fetch(`/api/kb/attributes?classId=${classId}&search=${encodeURIComponent(search)}`);
    const json = await res.json();
    if (!json.success) return;

    const attrs = json.data.attributes;
    const pathEl = document.getElementById('kb-attr-class-path');
    if (json.data.classPath) {
      pathEl.style.display = 'block';
      document.getElementById('kb-attr-class-path-text').textContent = json.data.classPath;
      document.getElementById('kb-attr-total-text').textContent = `${json.data.total} attributes`;
    } else {
      pathEl.style.display = search ? 'block' : 'none';
      if (search) {
        document.getElementById('kb-attr-class-path-text').textContent = 'All classes';
        document.getElementById('kb-attr-total-text').textContent = `${json.data.total} matches`;
      }
    }

    const tbody = document.getElementById('kb-attr-table-body');
    tbody.innerHTML = '';

    if (attrs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:30px;color:var(--gray-400)">No attributes found</td></tr>';
      return;
    }

    attrs.forEach(a => {
      const mandBadge = a.mandatory === 'Yes'
        ? '<span class="required-badge">YES</span>'
        : '<span style="color:var(--gray-400);font-size:11px">No</span>';
      const ruleTypeBadge = a.ruleType
        ? `<span class="source-tag kb" style="font-size:10px">${a.ruleType}</span>`
        : '';
      const pc2Badge = a.pc2Generation === 'Yes'
        ? '<span style="color:var(--green);font-weight:600;font-size:11px">Yes</span>'
        : '<span style="color:var(--gray-400);font-size:11px">No</span>';

      tbody.innerHTML += `<tr>
        <td class="field-name">${a.name}</td>
        <td style="text-align:center">${mandBadge}</td>
        <td>${ruleTypeBadge}</td>
        <td style="font-size:11px;color:var(--gray-600)">${a.ruleDescription || '<span style="color:var(--gray-300)">—</span>'}</td>
        <td style="font-size:11px;color:var(--gray-500)">${a.defaultValues || '<span style="color:var(--gray-300)">—</span>'}</td>
        <td style="text-align:center">${pc2Badge}</td>
      </tr>`;
    });
  } catch (e) { console.log('KB attributes load error:', e); }
}

async function loadKBRules() {
  try {
    const res = await fetch('/api/kb/rules');
    const json = await res.json();
    if (!json.success) return;

    const rules = json.data.rules;
    document.getElementById('kb-rules-count').textContent = rules.length;

    const container = document.getElementById('kb-rules-container');
    container.innerHTML = '';

    rules.forEach((r, i) => {
      const scopeBadge = r.scope === 'global'
        ? '<span class="source-tag inference">Global</span>'
        : '<span class="source-tag kb">Node</span>';

      // Parse rule JSON for display
      let ruleDetails = '';
      try {
        const ruleJson = JSON.parse(r.json);
        const ruleKeys = Object.keys(ruleJson.rules || {});
        const firstRule = ruleJson.rules[ruleKeys[0]] || {};
        ruleDetails = `<div style="font-size:11px;color:var(--gray-500);margin-top:6px">
          Type: <strong>${firstRule.ruleType || '—'}</strong> |
          Steps: ${ruleKeys.length} |
          Attributes: ${(firstRule.show_attr || []).length}
        </div>`;
      } catch (e) {}

      container.innerHTML += `<div class="kb-rule-card">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
          <span style="font-size:11px;font-weight:700;color:var(--blue)">${r.id}</span>
          ${scopeBadge}
          <span style="font-weight:600;font-size:13px;color:var(--gray-800)">${r.name}</span>
        </div>
        <div style="font-size:12px;color:var(--gray-600)">${r.description}</div>
        ${ruleDetails}
      </div>`;
    });
  } catch (e) { console.log('KB rules load error:', e); }
}

// Load KB when module is activated
function initKB() {
  loadKBStats();
  loadKBCategories();
  loadKBRules();
}

// ── RULE BUILDER (local KB rules) ─────────────────────────
async function loadRBRules() {
  try {
    const res = await fetch('/api/kb/rules');
    const json = await res.json();
    if (!json.success) return;
    const rules = json.data.rules;
    document.getElementById('rb-local-count').textContent = rules.length;
    const tbody = document.getElementById('rb-rules-table-body');
    tbody.innerHTML = '';
    if (rules.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:30px;color:var(--gray-400)">No local rules found</td></tr>';
      return;
    }
    rules.forEach(r => {
      let ruleType = '';
      try { const rj = JSON.parse(r.json); const k = Object.keys(rj.rules||{})[0]; ruleType = (rj.rules[k]||{}).ruleType || ''; } catch(e){}
      const scopeBadge = r.scope === 'global'
        ? '<span class="source-tag inference">Global</span>'
        : '<span class="source-tag kb">Node</span>';
      const typeBadge = ruleType ? `<span class="source-tag" style="font-size:10px">${ruleType}</span>` : '';
      tbody.innerHTML += `<tr class="bulk-row" onclick="window.open('https://athenadev2.iksulalive.com/admin/custom-rule-list','_blank')">
        <td style="font-weight:600;color:var(--blue);font-size:11px">${escapeForHtml(r.id)}</td>
        <td class="field-name">${escapeForHtml(r.name)}</td>
        <td style="font-size:11px;color:var(--gray-600)">${escapeForHtml(r.description)}</td>
        <td>${scopeBadge}</td>
        <td>${typeBadge}</td>
      </tr>`;
    });
  } catch(e) { console.log('RB rules load error:', e); }
}

// ── INIT ──────────────────────────────────────────────────
initDashboard();
initKB();
loadRBRules();

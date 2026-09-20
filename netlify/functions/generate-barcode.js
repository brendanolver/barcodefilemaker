/**
 * netlify/functions/generate-barcode.js
 *
 * Given one or more ApparelMagic purchase order and/or sales order numbers,
 * fetches each document's line items and joins in category + retail price
 * from the products endpoint, returning rows ready for the barcode sheet
 * (same shape the old CSV export used).
 *
 * It also supports building a sheet from whole ApparelMagic collections (the
 * product `group` field), driven in batches by the browser so large collections
 * stay inside the function timeout:
 *   action "collections"        -> distinct collection names
 *   action "collectionProducts" -> products in the chosen collection(s)
 *   action "collectionSkus"     -> barcode rows for a batch of those products
 *
 * Auth: GET params time=<unix_ts>&token=<APPAREL_MAGIC_TOKEN>
 * Subdomain: APPAREL_MAGIC_SUBDOMAIN (bare subdomain, e.g. "kohindustries")
 */

const MIN_PAGE_SIZE = 10;
const PRODUCT_PAGE_SIZE = 1000;
const SKU_BATCH_LIMIT = 40;
const COLLECTION_FIELD = 'group';

const DOC_TYPES = {
  po: { endpoint: 'purchase_orders', idField: 'purchase_order_id', itemsField: 'purchase_order_items', label: 'PO' },
  so: { endpoint: 'orders', idField: 'order_id', itemsField: 'order_items', label: 'SO' },
};

function getEnv() {
  const token = process.env.APPAREL_MAGIC_TOKEN;
  let subdomain = process.env.APPAREL_MAGIC_SUBDOMAIN;
  if (!token || !subdomain) {
    throw new Error('APPAREL_MAGIC_TOKEN and APPAREL_MAGIC_SUBDOMAIN must be set');
  }
  subdomain = subdomain.replace(/\.app\.apparelmagic\.com\/?$/, '').trim();
  return { token, subdomain };
}

async function amGet(subdomain, token, endpoint, params = {}) {
  const t = Math.floor(Date.now() / 1000);
  const qs = new URLSearchParams({ time: t, token, ...params }).toString();
  const url = `https://${subdomain}.app.apparelmagic.com/api/json/${endpoint}/?${qs}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'WNDRR-BarcodeFileMaker/1.0' } });
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`AM API ${endpoint} returned invalid JSON (status ${res.status})`);
  }
  if (res.status !== 200) {
    const msg = data?.meta?.errors?.join('; ') || raw.slice(0, 200);
    throw new Error(`AM API ${endpoint} returned ${res.status}: ${msg}`);
  }
  return data;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function parseDocNumbers(raw) {
  return (raw || []).map((n) => String(n).trim()).filter(Boolean);
}


// Cursor-paginate an AM endpoint (pagination[last_id]) until exhausted.
async function amGetAll(subdomain, token, endpoint, params = {}) {
  const all = [];
  let lastId = null;
  for (let guard = 0; guard < 200; guard++) {
    const page = { ...params, 'pagination[page_size]': PRODUCT_PAGE_SIZE };
    if (lastId) page['pagination[last_id]'] = lastId;
    const data = await amGet(subdomain, token, endpoint, page);
    const batch = data.response || [];
    all.push(...batch);
    const next = data.meta?.pagination?.last_id;
    if (batch.length < PRODUCT_PAGE_SIZE || !next || String(next) === String(lastId)) break;
    lastId = next;
  }
  return all;
}

function reply(statusCode, obj) {
  return { statusCode, body: JSON.stringify(obj) };
}

async function listCollections(subdomain, token) {
  const products = await amGetAll(subdomain, token, 'products');
  const counts = new Map();
  for (const p of products) {
    const name = (p[COLLECTION_FIELD] || '').trim();
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return Array.from(counts, ([name, productCount]) => ({ name, productCount }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function listCollectionProducts(subdomain, token, collections) {
  const seen = new Map();
  for (const name of collections) {
    const rows = await amGetAll(subdomain, token, 'products', {
      'parameters[0][field]': COLLECTION_FIELD,
      'parameters[0][operator]': '=',
      'parameters[0][value]': name,
    });
    for (const p of rows) {
      if (String(p[COLLECTION_FIELD] || '').trim() !== name) continue; // guard against a filter being ignored
      if (!seen.has(p.product_id)) {
        seen.set(p.product_id, {
          product_id: String(p.product_id),
          style_number: p.style_number || '',
          description: p.description || '',
          category: p.category || '',
          retail_price: p.retail_price || '',
        });
      }
    }
  }
  return Array.from(seen.values());
}

async function skusForProducts(subdomain, token, products) {
  const perProduct = await mapWithConcurrency(products, 8, async (product) => {
    const data = await amGet(subdomain, token, 'inventory', {
      'parameters[0][field]': 'product_id',
      'parameters[0][operator]': '=',
      'parameters[0][value]': product.product_id,
      'pagination[page_size]': 100,
    });
    // Inventory can return one row per warehouse; keep one row per SKU.
    const bySku = new Map();
    for (const sku of data.response || []) {
      if (String(sku.product_id) !== String(product.product_id)) continue;
      const key = sku.sku_id || sku.upc_display || sku.upc || `${sku.attr_2}|${sku.size}`;
      if (!bySku.has(key)) bySku.set(key, sku);
    }
    return Array.from(bySku.values()).map((sku) => ({
      Style: product.style_number || sku.style_number || '',
      Description: product.description || sku.description || '',
      COLOUR: sku.attr_2 || '',
      SIZE: sku.size || '',
      Category: product.category || '',
      Barcode: sku.upc_display || sku.upc || '',
      'Retail Price': sku.retail_price || product.retail_price || '',
    }));
  });
  return perProduct.flat();
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return reply(400, { error: 'Invalid JSON body' });
  }

  if (body.action) {
    let creds;
    try {
      creds = getEnv();
    } catch (err) {
      return reply(500, { error: err.message });
    }
    try {
      if (body.action === 'collections') {
        return reply(200, { collections: await listCollections(creds.subdomain, creds.token) });
      }
      if (body.action === 'collectionProducts') {
        const names = (body.collections || []).map((c) => String(c).trim()).filter(Boolean);
        if (!names.length) return reply(400, { error: 'collections array required' });
        return reply(200, { products: await listCollectionProducts(creds.subdomain, creds.token, names) });
      }
      if (body.action === 'collectionSkus') {
        const products = (body.products || []).filter((p) => p && p.product_id);
        if (!products.length) return reply(400, { error: 'products array required' });
        if (products.length > SKU_BATCH_LIMIT) return reply(400, { error: `Max ${SKU_BATCH_LIMIT} products per batch` });
        return reply(200, { rows: await skusForProducts(creds.subdomain, creds.token, products) });
      }
      return reply(400, { error: `Unknown action: ${body.action}` });
    } catch (err) {
      return reply(502, { error: err.message });
    }
  }

  let requestedDocs; // [{ type: 'po'|'so', number: string }]
  try {
    const poNumbers = parseDocNumbers(body.poNumbers);
    const soNumbers = parseDocNumbers(body.soNumbers);
    requestedDocs = [
      ...poNumbers.map((number) => ({ type: 'po', number })),
      ...soNumbers.map((number) => ({ type: 'so', number })),
    ];
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  if (!requestedDocs.length) {
    return { statusCode: 400, body: JSON.stringify({ error: 'poNumbers and/or soNumbers array required' }) };
  }

  let token, subdomain;
  try {
    ({ token, subdomain } = getEnv());
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }

  const docResults = [];
  const allItems = [];

  try {
    for (const { type, number } of requestedDocs) {
      const cfg = DOC_TYPES[type];
      const data = await amGet(subdomain, token, cfg.endpoint, {
        [cfg.idField]: number,
        'pagination[page_size]': MIN_PAGE_SIZE,
      });
      const rows = data.response || [];
      const doc = rows.find((r) => String(r[cfg.idField]) === number);

      if (!doc) {
        docResults.push({ type, number, found: false, itemCount: 0 });
        continue;
      }

      const items = doc[cfg.itemsField] || [];
      docResults.push({ type, number, found: true, itemCount: items.length });
      for (const item of items) {
        allItems.push({ ...item, _docType: type, _docNumber: number });
      }
    }

    // Dedupe by sku_id across the selected document(s) — barcode sheet is one row per SKU.
    const bySkuId = new Map();
    for (const item of allItems) {
      if (item.sku_id && !bySkuId.has(item.sku_id)) bySkuId.set(item.sku_id, item);
    }
    const uniqueItems = Array.from(bySkuId.values());

    // Look up category + retail_price per unique product_id.
    const productIds = Array.from(new Set(uniqueItems.map((i) => i.product_id).filter(Boolean)));
    const productLookups = await mapWithConcurrency(productIds, 8, async (productId) => {
      const data = await amGet(subdomain, token, 'products', {
        product_id: productId,
        'pagination[page_size]': MIN_PAGE_SIZE,
      });
      const rows = data.response || [];
      return rows.find((r) => String(r.product_id) === productId) || null;
    });
    const productById = new Map();
    productIds.forEach((id, i) => productById.set(id, productLookups[i]));

    const rows = uniqueItems.map((item) => {
      const product = productById.get(item.product_id) || {};
      return {
        Style: item.style_number || '',
        Description: item.description || product.description || '',
        COLOUR: item.attr_2 || '',
        SIZE: item.size || '',
        Category: product.category || '',
        Barcode: item.upc_display || item.upc || '',
        'Retail Price': product.retail_price || '',
      };
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ rows, docResults }),
    };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: err.message, docResults }) };
  }
};

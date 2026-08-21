/**
 * netlify/functions/generate-barcode.js
 *
 * Given one or more ApparelMagic purchase order and/or sales order numbers,
 * fetches each document's line items and joins in category + retail price
 * from the products endpoint, returning rows ready for the barcode sheet
 * (same shape the old CSV export used).
 *
 * Auth: GET params time=<unix_ts>&token=<APPAREL_MAGIC_TOKEN>
 * Subdomain: APPAREL_MAGIC_SUBDOMAIN (bare subdomain, e.g. "kohindustries")
 */

const MIN_PAGE_SIZE = 10;

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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let requestedDocs; // [{ type: 'po'|'so', number: string }]
  try {
    const body = JSON.parse(event.body || '{}');
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

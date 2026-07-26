/**
 * netlify/functions/generate-barcode.js
 *
 * Given one or more ApparelMagic purchase order numbers, fetches each PO's
 * line items and joins in category + retail price from the products endpoint,
 * returning rows ready for the barcode sheet (same shape the old CSV export used).
 *
 * Auth: GET params time=<unix_ts>&token=<APPAREL_MAGIC_TOKEN>
 * Subdomain: APPAREL_MAGIC_SUBDOMAIN (bare subdomain, e.g. "kohindustries")
 */

const MIN_PAGE_SIZE = 10;

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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let poNumbers;
  try {
    const body = JSON.parse(event.body || '{}');
    poNumbers = (body.poNumbers || [])
      .map((n) => String(n).trim())
      .filter(Boolean);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  if (!poNumbers.length) {
    return { statusCode: 400, body: JSON.stringify({ error: 'poNumbers array required' }) };
  }

  let token, subdomain;
  try {
    ({ token, subdomain } = getEnv());
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }

  const poResults = [];
  const allItems = [];

  try {
    for (const poNumber of poNumbers) {
      const data = await amGet(subdomain, token, 'purchase_orders', {
        purchase_order_id: poNumber,
        'pagination[page_size]': MIN_PAGE_SIZE,
      });
      const rows = data.response || [];
      const po = rows.find((r) => String(r.purchase_order_id) === poNumber);

      if (!po) {
        poResults.push({ poNumber, found: false, itemCount: 0 });
        continue;
      }

      const items = po.purchase_order_items || [];
      poResults.push({ poNumber, found: true, itemCount: items.length, vendorName: po.vendor_name || null });
      for (const item of items) {
        allItems.push({ ...item, _poNumber: poNumber });
      }
    }

    // Dedupe by sku_id across the selected PO(s) — barcode sheet is one row per SKU.
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
      body: JSON.stringify({ rows, poResults }),
    };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: err.message, poResults }) };
  }
};

// Cliente da API pública de catálogo VTEX. Tenta primeiro a busca
// "inteligente" (melhor relevância) e cai para a busca clássica se a loja
// não a suportar ou não retornar nada.
import { detectType, matchesQuery, parseDosage, parsePromo, parseQuantity, queryTokens } from './parse.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TIMEOUT_MS = 15000;
const PAGE_SIZE = 50;

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'pt-BR,pt;q=0.9' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('resposta não é JSON');
  }
}

async function intelligentSearch(store, query) {
  const url =
    `${store.base}/api/io/_v/api/intelligent-search/product_search/?query=${encodeURIComponent(query)}` +
    `&count=${PAGE_SIZE}&page=1&locale=pt-BR&hideUnavailableItems=true`;
  const data = await getJson(url);
  return Array.isArray(data?.products) ? data.products : [];
}

async function legacySearch(store, query) {
  const url =
    `${store.base}/api/catalog_system/pub/products/search?ft=${encodeURIComponent(query)}` +
    `&_from=0&_to=${PAGE_SIZE - 1}`;
  const data = await getJson(url);
  return Array.isArray(data) ? data : [];
}

// Lê uma chave em qualquer capitalização / formato de backing field do .NET
function pick(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  const lower = key.toLowerCase();
  for (const k of Object.keys(obj)) {
    const clean = k.replace(/^<|>k__BackingField$/g, '').toLowerCase();
    if (clean === lower) return obj[k];
  }
  return undefined;
}

function paramsToObject(list) {
  const out = {};
  for (const p of list || []) out[pick(p, 'name')] = pick(p, 'value');
  return out;
}

function readTeasers(offer) {
  const raw = [...(pick(offer, 'teasers') || []), ...(pick(offer, 'PromotionTeasers') || [])];
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    const name = pick(t, 'name');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const cond = pick(t, 'conditions') || {};
    const eff = pick(t, 'effects') || {};
    out.push({
      name,
      minQty: pick(cond, 'minimumQuantity'),
      effects: paramsToObject(pick(eff, 'parameters')),
    });
  }
  return out;
}

function readHighlights(offer) {
  const list = pick(offer, 'discountHighlights') || pick(offer, 'DiscountHighLight') || [];
  return list.map((h) => pick(h, 'name')).filter(Boolean);
}

function readProps(product, re) {
  const values = [];
  if (Array.isArray(product.properties)) {
    for (const p of product.properties) if (re.test(p.name)) values.push(...(p.values || []));
  }
  for (const [k, v] of Object.entries(product)) {
    if (re.test(k) && Array.isArray(v)) values.push(...v.filter((x) => typeof x === 'string'));
  }
  return values;
}

function bestInstallment(offer) {
  let best = null;
  for (const i of pick(offer, 'Installments') || []) {
    const n = pick(i, 'NumberOfInstallments');
    if (pick(i, 'InterestRate') === 0 && n > 1 && (!best || n > best.count)) {
      best = { count: n, value: pick(i, 'Value') };
    }
  }
  return best;
}

function absoluteUrl(store, product) {
  const link = product.link || `/${product.linkText}/p`;
  if (/^https?:/.test(link)) return link;
  return store.base + (link.startsWith('/') ? '' : '/') + link;
}

const round2 = (v) => Math.round(v * 100) / 100;

export function productToOffers(store, product, tokens) {
  const activeIngredient = readProps(product, /princ[ií]pio ativo/i);
  const typeProps = readProps(product, /tipo (de|do) (medicamento|produto)|categoria do medicamento/i);
  const haystack = [product.productName, product.brand, ...activeIngredient].join(' ');
  const relevant = matchesQuery(tokens, haystack);

  const offers = [];
  for (const item of product.items || []) {
    // escolhe o vendedor mais barato com estoque
    let chosen = null;
    for (const seller of item.sellers || []) {
      const o = seller.commertialOffer || {};
      const price = Number(o.Price);
      const available = (o.AvailableQuantity ?? 0) > 0 && price > 0;
      if (!available) continue;
      if (!chosen || price < chosen.price) chosen = { seller, o, price };
    }
    if (!chosen) continue;

    const { o, price, seller } = chosen;
    // nameComplete costuma repetir o nome do produto; só vale quando há várias variações
    const name =
      (product.items.length > 1 ? item.nameComplete : null) || product.productName || item.nameComplete || item.name;
    const listPrice = Math.max(Number(o.ListPrice) || price, Number(o.PriceWithoutDiscount) || 0, price);
    const spot = Number(o.spotPrice);
    const promos = readTeasers(o).map((t) => parsePromo(t, price));
    const quantity = parseQuantity(name) || parseQuantity(product.productName);
    const promoUnit = promos.map((p) => p.unitPrice).filter((v) => v != null);
    const bestPrice = Math.min(price, spot > 0 ? spot : Infinity, ...promoUnit);

    offers.push({
      storeId: store.id,
      storeName: store.name,
      sellerId: seller.sellerId || '1',
      sellerName: seller.sellerDefault === false ? seller.sellerName : null,
      productId: product.productId,
      skuId: item.itemId,
      name,
      brand: product.brand || null,
      ean: item.ean ? String(item.ean).replace(/^0+/, '') : null,
      url: absoluteUrl(store, product),
      image: item.images?.[0]?.imageUrl || null,
      price: round2(price),
      listPrice: round2(listPrice),
      spotPrice: spot > 0 && spot < price - 0.005 ? round2(spot) : null,
      discountPct: listPrice > price ? Math.round((1 - price / listPrice) * 100) : 0,
      promos,
      highlights: readHighlights(o),
      bestPrice: round2(bestPrice),
      quantity,
      unitPrice: quantity ? round2(price / quantity.qty) : null,
      bestUnitPrice: quantity ? Math.round((bestPrice / quantity.qty) * 1000) / 1000 : null,
      dosage: parseDosage(name),
      type: detectType(name, typeProps),
      activeIngredient: activeIngredient[0] || null,
      installment: bestInstallment(o),
      relevant,
    });
  }
  return offers;
}

export async function searchStore(store, query) {
  const tokens = queryTokens(query);
  let products = [];
  let mode = 'intelligent';
  try {
    products = await intelligentSearch(store, query);
  } catch {
    products = [];
  }
  if (!products.length) {
    mode = 'legacy';
    products = await legacySearch(store, query);
  }
  const offers = products.flatMap((p) => productToOffers(store, p, tokens));
  return { mode, offers };
}

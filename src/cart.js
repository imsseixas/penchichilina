// Otimizador de carrinho: para cada farmácia, simula o pedido inteiro (com as
// promoções de quantidade aplicadas pela própria loja e um frete único para o
// pedido) e compara "tudo numa loja só" com "dividir entre duas lojas".
import { STORES, STORE_BY_ID } from './stores.js';
import { findByEan, mapLimit } from './catalog.js';
import { fetchWithRetry } from './shipping.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
export const MAX_CART_ITEMS = 15;
const MAX_FREIGHT = 100;

const isSku = (v) => /^\d{1,12}$/.test(String(v));
const isSeller = (v) => /^[\w-]{1,40}$/.test(String(v));
const cents = (v) => Math.round(v) / 100;

// só aceita link https que aponte para o domínio da própria loja
export function sameStoreUrl(url, store) {
  try {
    const u = new URL(url);
    const host = new URL(store.base).hostname.replace(/^www\./, '');
    return u.protocol === 'https:' && (u.hostname === host || u.hostname.endsWith('.' + host)) ? u.href : null;
  } catch {
    return null;
  }
}

// Resume a simulação de um pedido com várias linhas.
export function summarizeCart(data, lines) {
  const byId = new Map(); // skuId -> { total, available }
  const items = data?.items || [];
  const availableIdx = [];
  items.forEach((it, idx) => {
    const entry = byId.get(String(it.id)) || { total: 0, available: false };
    const total = it.priceDefinition?.total ?? (it.sellingPrice ?? it.price) * it.quantity;
    if (it.availability === 'available') {
      entry.available = true;
      entry.total += total;
      availableIdx.push(idx);
    }
    byId.set(String(it.id), entry);
  });

  const logistics = (data?.logisticsInfo || []).filter((li) => availableIdx.includes(li.itemIndex));
  let freight = null;
  let pickup = false;
  if (logistics.length && logistics.every((li) => li.slas?.length)) {
    // um nome de SLA só serve se atende TODAS as linhas; o frete é a soma
    const sums = new Map();
    for (const li of logistics) {
      for (const s of li.slas) {
        const k = `${s.deliveryChannel}|${s.name}`;
        const e = sums.get(k) || { name: s.name, channel: s.deliveryChannel, price: 0, n: 0, estimate: s.shippingEstimate };
        e.price += s.price;
        e.n++;
        sums.set(k, e);
      }
    }
    const complete = [...sums.values()].filter((e) => e.n === logistics.length);
    const delivery = complete.filter((e) => e.channel !== 'pickup-in-point').sort((a, b) => a.price - b.price)[0];
    if (delivery) freight = { name: delivery.name, price: cents(delivery.price), estimate: delivery.estimate };
    pickup = complete.some((e) => e.channel === 'pickup-in-point');
  }

  const result = lines.map((l) => {
    const e = byId.get(String(l.skuId));
    return { key: l.key, available: Boolean(e?.available), total: e?.available ? cents(e.total) : null };
  });
  const subtotal = cents(result.reduce((s, r) => s + (r.total ?? 0) * 100, 0));
  return { lines: result, subtotal, freight, pickup };
}

async function simulateCart(store, lines, cep) {
  const body = {
    items: lines.map((l) => ({ id: String(l.skuId), quantity: l.qty, seller: l.sellerId || '1' })),
    country: 'BRA',
  };
  if (cep) body.postalCode = cep;
  const res = await fetchWithRetry(`${store.base}/api/checkout/pub/orderForms/simulation?sc=1`, {
    method: 'POST',
    headers: { 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return summarizeCart(await res.json(), lines);
}

function planTotal(storeResult, cep, mode) {
  if (!storeResult || storeResult.error) return null;
  if (storeResult.lines.some((l) => !l.available)) return null;
  if (!cep) return { total: storeResult.subtotal, freight: 0, via: null };
  if (mode === 'any' && storeResult.pickup) return { total: storeResult.subtotal, freight: 0, via: 'pickup' };
  if (storeResult.freight && storeResult.freight.price <= MAX_FREIGHT) {
    return { total: cents((storeResult.subtotal + storeResult.freight.price) * 100), freight: storeResult.freight.price, via: 'delivery' };
  }
  return null;
}

// items: [{ key, ean, name, qty, offers: [{ storeId, skuId, sellerId }] }]
export async function optimizeCart(items, cep, mode = 'delivery') {
  items = items.slice(0, MAX_CART_ITEMS).map((it) => ({
    key: String(it.key || it.ean || '').slice(0, 80),
    ean: /^\d{6,14}$/.test(it.ean) ? it.ean : null,
    name: String(it.name || '').slice(0, 200),
    qty: Math.min(Math.max(parseInt(it.qty, 10) || 1, 1), 20),
    offers: (Array.isArray(it.offers) ? it.offers : []).filter((o) => STORE_BY_ID[o.storeId] && isSku(o.skuId)),
  }));

  // 1) para cada loja, descobre o SKU de cada item (oferta conhecida ou busca por EAN)
  const stores = await Promise.all(
    STORES.map(async (store) => {
      const lines = [];
      const missing = [];
      await mapLimit(items, 4, async (it) => {
        let offer = it.offers.find((o) => o.storeId === store.id);
        if (!offer && it.ean) {
          try {
            offer = await findByEan(store, it.ean);
          } catch {
            offer = null;
          }
        }
        if (offer) {
          lines.push({ key: it.key, skuId: offer.skuId, sellerId: isSeller(offer.sellerId) ? offer.sellerId : '1', qty: it.qty, url: sameStoreUrl(offer.url, store) });
        } else {
          missing.push(it.key);
        }
      });
      if (!lines.length) return { storeId: store.id, storeName: store.name, missing, lines: [], subtotal: 0 };
      try {
        const sim = await simulateCart(store, lines, cep);
        for (const l of sim.lines) {
          const src = lines.find((x) => x.key === l.key);
          l.url = src?.url;
          l.skuId = src?.skuId;
          l.sellerId = src?.sellerId;
          l.qty = src?.qty;
        }
        // itens que a loja não tem também contam como indisponíveis
        for (const key of missing) sim.lines.push({ key, available: false, total: null });
        return { storeId: store.id, storeName: store.name, missing, ...sim };
      } catch (err) {
        return { storeId: store.id, storeName: store.name, missing, lines: [], subtotal: 0, error: err.message };
      }
    }),
  );

  // 2) melhor loja única
  const singles = stores
    .map((s) => ({ storeId: s.storeId, plan: planTotal(s, cep, mode) }))
    .filter((s) => s.plan)
    .sort((a, b) => a.plan.total - b.plan.total);

  // 3) melhor divisão entre duas lojas (estimativa e depois confirmação exata)
  let split = null;
  const usable = stores.filter((s) => !s.error && s.lines.some((l) => l.available));
  const unitCost = (s, key) => s.lines.find((l) => l.key === key && l.available)?.total ?? null;
  const shipCost = (s) => {
    if (!cep) return 0;
    if (mode === 'any' && s.pickup) return 0;
    return s.freight && s.freight.price <= MAX_FREIGHT ? s.freight.price : null;
  };
  let bestEstimate = null;
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const A = usable[i];
      const B = usable[j];
      const fa = shipCost(A);
      const fb = shipCost(B);
      const assign = {};
      let sum = 0;
      let ok = true;
      for (const it of items) {
        const ca = fa == null ? null : unitCost(A, it.key);
        const cb = fb == null ? null : unitCost(B, it.key);
        if (ca == null && cb == null) {
          ok = false;
          break;
        }
        const pickA = cb == null || (ca != null && ca <= cb);
        assign[it.key] = pickA ? A.storeId : B.storeId;
        sum += pickA ? ca : cb;
      }
      if (!ok) continue;
      const used = new Set(Object.values(assign));
      if (used.size < 2) continue;
      // frete da simulação completa é uma estimativa (pedido menor pode custar menos)
      const est = sum + fa + fb;
      if (!bestEstimate || est < bestEstimate.est) bestEstimate = { est, assign, stores: [A, B] };
    }
  }

  if (bestEstimate) {
    // confirma com simulações exatas de cada parte
    const parts = await Promise.all(
      bestEstimate.stores.map(async (s) => {
        const keys = items.filter((it) => bestEstimate.assign[it.key] === s.storeId).map((it) => it.key);
        const lines = s.lines.filter((l) => keys.includes(l.key)).map((l) => ({ key: l.key, skuId: l.skuId, sellerId: l.sellerId, qty: l.qty, url: l.url }));
        try {
          const sim = await simulateCart(STORE_BY_ID[s.storeId], lines, cep);
          sim.lines.forEach((l) => (l.url = lines.find((x) => x.key === l.key)?.url));
          return { storeId: s.storeId, storeName: s.storeName, ...sim, plan: planTotal(sim, cep, mode) };
        } catch {
          return null;
        }
      }),
    );
    if (parts.every((p) => p?.plan)) {
      split = { parts, total: cents(parts.reduce((s, p) => s + p.plan.total * 100, 0)) };
    }
  }

  const bestSingle = singles[0] || null;
  const splitWorthIt = split && (!bestSingle || split.total < bestSingle.plan.total - 0.5);
  return {
    cep: cep || null,
    mode,
    items: items.map(({ key, ean, name, qty }) => ({ key, ean, name, qty })),
    stores,
    singles: singles.map((s) => ({ storeId: s.storeId, ...s.plan })),
    split: splitWorthIt ? split : null,
    savingsVsSingle: splitWorthIt && bestSingle ? cents((bestSingle.plan.total - split.total) * 100) : null,
  };
}

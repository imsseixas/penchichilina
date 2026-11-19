// Verifica entrega/retirada para um CEP usando a simulação de carrinho da VTEX.
// Cada SKU é simulado sozinho (quantidade 1): ao simular vários itens juntos a
// VTEX rateia o frete entre eles e o valor por item fica distorcido.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TIMEOUT_MS = 12000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const CONCURRENCY_PER_STORE = 5;
const MAX_SKUS_PER_STORE = 40;

const cache = new Map(); // `${storeId}|${skuId}|${seller}|${cep}` -> { at, result }

export function cleanCep(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return /^\d{8}$/.test(digits) ? digits : null;
}

// "3bd" -> 3 dias úteis, "60m" -> 60 minutos, "2h", "30d" -> minutos aproximados
export function estimateToMinutes(est) {
  const m = String(est || '').match(/^(\d+)(bd|d|h|m)$/);
  if (!m) return null;
  const n = Number(m[1]);
  return { bd: n * 24 * 60 * 1.4, d: n * 24 * 60, h: n * 60, m: n }[m[2]];
}

export function summarizeSimulation(data) {
  const item = data?.items?.[0];
  const logistics = data?.logisticsInfo?.[0];
  const slas = logistics?.slas || [];
  if (!item) return { ok: false, delivery: null, fastest: null, pickup: null, reason: 'produto indisponível' };

  const delivery = slas.filter((s) => s.deliveryChannel !== 'pickup-in-point');
  const pickup = slas.filter((s) => s.deliveryChannel === 'pickup-in-point');
  const mapSla = (s) => ({ name: s.name, price: s.price / 100, estimate: s.shippingEstimate });

  const cheapest = delivery.length
    ? delivery.reduce((a, b) => (b.price < a.price || (b.price === a.price && estimateToMinutes(b.shippingEstimate) < estimateToMinutes(a.shippingEstimate)) ? b : a))
    : null;
  const fastest = delivery.length
    ? delivery.reduce((a, b) => (estimateToMinutes(b.shippingEstimate) < estimateToMinutes(a.shippingEstimate) ? b : a))
    : null;

  let pickupInfo = null;
  if (pickup.length) {
    const nearest = pickup.reduce((a, b) =>
      (b.pickupDistance ?? Infinity) < (a.pickupDistance ?? Infinity) ? b : a,
    );
    const quickest = pickup.reduce((a, b) =>
      estimateToMinutes(b.shippingEstimate) < estimateToMinutes(a.shippingEstimate) ? b : a,
    );
    pickupInfo = {
      count: pickup.length,
      estimate: quickest.shippingEstimate,
      nearest: nearest.pickupStoreInfo?.friendlyName || null,
      distanceKm: nearest.pickupDistance != null ? Math.round(nearest.pickupDistance * 10) / 10 : null,
    };
  }

  const reason = (data.messages || []).map((m) => m.text).find(Boolean) || null;
  return {
    ok: Boolean(cheapest || pickupInfo),
    // preço praticado na região (pode diferir do catálogo nacional)
    price: item.sellingPrice > 0 ? item.sellingPrice / 100 : null,
    delivery: cheapest ? mapSla(cheapest) : null,
    fastest: fastest && fastest !== cheapest ? mapSla(fastest) : null,
    pickup: pickupInfo,
    reason: cheapest || pickupInfo ? null : reason || 'não entrega neste CEP',
  };
}

async function simulateOne(store, skuId, seller, cep) {
  const key = `${store.id}|${skuId}|${seller}|${cep}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

  const res = await fetch(`${store.base}/api/checkout/pub/orderForms/simulation?sc=1`, {
    method: 'POST',
    headers: { 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ id: String(skuId), quantity: 1, seller }], postalCode: cep, country: 'BRA' }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const result = summarizeSimulation(await res.json());
  cache.set(key, { at: Date.now(), result });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return result;
}

// Simula as ofertas relevantes de uma loja. Retorna { [skuId]: resultado }
export async function checkShipping(store, offers, cep) {
  const seen = new Set();
  const queue = [];
  for (const o of offers) {
    if (!o.relevant || seen.has(o.skuId)) continue;
    seen.add(o.skuId);
    queue.push(o);
    if (queue.length >= MAX_SKUS_PER_STORE) break;
  }

  const results = {};
  let next = 0;
  async function worker() {
    while (next < queue.length) {
      const o = queue[next++];
      try {
        results[o.skuId] = await simulateOne(store, o.skuId, o.sellerId || '1', cep);
      } catch (err) {
        results[o.skuId] = { ok: null, error: err.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY_PER_STORE, queue.length) }, worker));
  return results;
}

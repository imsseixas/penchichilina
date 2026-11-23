// Busca por código de barras (EAN) com cache, e utilitários de concorrência.
import { lookupByEan } from './vtex.js';

const TTL_MS = 30 * 60 * 1000;
const cache = new Map(); // `${storeId}|${ean}` -> { at, offer }

export async function findByEan(store, ean) {
  const key = `${store.id}|${ean}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.offer;
  const offer = await lookupByEan(store, ean);
  cache.set(key, { at: Date.now(), offer });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return offer;
}

// Executa fn em cada item com no máximo `limit` em paralelo, preservando a ordem.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

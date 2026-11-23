// Lojas físicas perto do usuário, pela API pública de pontos de retirada da
// VTEX (/api/checkout/pub/pickup-points). Só algumas redes publicam suas lojas
// (hoje: Drogaria São Paulo/Pacheco e Pague Menos/Extrafarma); as demais
// devolvem lista vazia e ficam de fora do modo "ir à farmácia".
import { STORES } from './stores.js';
import { cleanCep, cleanName, formatAddress } from './shipping.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const CACHE_TTL_MS = 6 * 3600 * 1000; // lojas físicas mudam pouco
const MAX_POINTS = 30; // a API devolve no máximo 30 por página

const cache = new Map(); // `${storeId}|${where}` -> { at, points }

// Arredonda para 3 casas (~100 m): precisão suficiente e menos exposição.
export function cleanGeo(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  if (lat == null || lng == null || lat === '' || lng === '') return null;
  // limites aproximados do Brasil
  if (!Number.isFinite(la) || !Number.isFinite(ln) || la < -34 || la > 6 || ln < -74 || ln > -34) return null;
  return { lat: Math.round(la * 1000) / 1000, lng: Math.round(ln * 1000) / 1000 };
}

export function cleanRadius(v, fallback = 3) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 30) : fallback;
}

export function haversineKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

// horários no formato da VTEX: [{ DayOfWeek: 0..6 (domingo=0), OpeningTime, ClosingTime }]
export function mapHours(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return list
    .filter((h) => Number.isInteger(h.DayOfWeek))
    .map((h) => ({ day: h.DayOfWeek, open: String(h.OpeningTime || '').slice(0, 5), close: String(h.ClosingTime || '').slice(0, 5) }));
}

export function summarizePoints(data, origin) {
  return (data?.items || [])
    .filter((it) => it.pickupPoint?.isActive !== false)
    .map((it) => {
      const p = it.pickupPoint || {};
      const [lng, lat] = p.address?.geoCoordinates || [];
      const geo = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
      const km = origin && geo ? haversineKm(origin, geo) : it.distance;
      return {
        id: String(p.id || ''),
        name: cleanName(p.friendlyName),
        address: formatAddress(p.address),
        postalCode: cleanCep(p.address?.postalCode),
        lat: geo?.lat ?? null,
        lng: geo?.lng ?? null,
        distanceKm: Number.isFinite(km) ? Math.round(km * 100) / 100 : null,
        hours: mapHours(p.businessHours),
      };
    })
    .filter((p) => p.id && p.distanceKm != null)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

async function fetchPoints(store, { cep, geo }) {
  const where = geo ? `geoCoordinates=${geo.lng};${geo.lat}` : `postalCode=${cep}&countryCode=BRA`;
  const key = `${store.id}|${where}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.points;
  const res = await fetch(`${store.base}/api/checkout/pub/pickup-points?${where}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const points = summarizePoints(await res.json(), geo);
  cache.set(key, { at: Date.now(), points });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return points;
}

// Para cada farmácia, as lojas físicas dentro do raio.
export async function nearbyStores({ cep, geo, radiusKm }) {
  if (!cep && !geo) throw new Error('informe CEP ou localização');
  const stores = await Promise.all(
    STORES.map(async (store) => {
      try {
        const all = await fetchPoints(store, { cep, geo });
        const points = all.filter((p) => p.distanceKm <= radiusKm);
        return { storeId: store.id, storeName: store.name, count: points.length, nearestKm: all[0]?.distanceKm ?? null, points: points.slice(0, MAX_POINTS) };
      } catch (err) {
        return { storeId: store.id, storeName: store.name, count: 0, nearestKm: null, points: [], error: err.message };
      }
    }),
  );
  return { radiusKm, stores };
}

// CEP de uma loja bem próxima: a simulação de carrinho da VTEX exige CEP, mesmo
// quando recebe coordenadas (que passam a valer para a distância).
export async function approxCep(geo) {
  for (const store of STORES) {
    try {
      const nearest = (await fetchPoints(store, { geo })).find((p) => p.postalCode);
      if (nearest && nearest.distanceKm <= 5) return nearest.postalCode;
    } catch {
      /* tenta a próxima rede */
    }
  }
  return null;
}

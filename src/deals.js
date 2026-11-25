// Superofertas: varre periodicamente categorias (suplementos, higiene, bebê,
// medicamentos sem receita) em todas as farmácias, ordenando por desconto, e
// pontua cada produto pelo DESCONTO REAL — preço comparado à mediana do mesmo
// produto (mesmo EAN) nas outras farmácias. O "de/por" da loja costuma ser
// inflado, então só vale como critério secundário.
import { STORES, STORE_BY_ID } from './stores.js';
import { searchStore } from './vtex.js';
import { record } from './history.js';
import { mapLimit, median } from './catalog.js';
import { readJson, SERVERLESS, writeJson } from './jsonfile.js';

export const DEAL_CATEGORIES = [
  {
    id: 'suplementos',
    name: 'Suplementos',
    terms: ['omega 3', 'whey protein', 'barra de proteina', 'creatina', 'colageno', 'vitamina d', 'vitamina c', 'multivitaminico', 'magnesio'],
  },
  { id: 'beleza', name: 'Higiene e beleza', terms: ['protetor solar', 'hidratante', 'shampoo', 'creme dental', 'desodorante'] },
  { id: 'bebe', name: 'Bebê', terms: ['fralda', 'lenco umedecido'] },
  { id: 'mip', name: 'Remédios sem receita', terms: ['dipirona', 'paracetamol', 'ibuprofeno', 'loratadina', 'dorflex', 'buscopan'] },
];

const FILE = 'deals.json';
const REFRESH_MS = (Number(process.env.DEALS_INTERVAL_HOURS) || 6) * 3600 * 1000;
const MIN_REAL_DISCOUNT = 0.2; // 20% abaixo da mediana das outras farmácias
const MIN_LIST_DISCOUNT = 0.4; // sem comparação, exige 40% no "de/por" da loja
const MAX_DEALS = 400;

let snapshot = null; // { updatedAt, deals }
let scanning = null; // { done, total, startedAt }

// ---------- pontuação (função pura, testável) ----------
// entries: [{ category, offer }]
export function scoreDeals(entries) {
  const groups = new Map();
  for (const { category, offer: o } of entries) {
    if (!o.relevant || !(o.price >= 1)) continue;
    const key = o.ean ? `e:${o.ean}` : `s:${o.storeId}:${o.skuId}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { category, byStore: new Map() }));
    const prev = g.byStore.get(o.storeId);
    if (!prev || o.bestPrice < prev.bestPrice) g.byStore.set(o.storeId, o);
  }

  const deals = [];
  for (const g of groups.values()) {
    const offers = [...g.byStore.values()].sort((a, b) => a.bestPrice - b.bestPrice);
    const best = offers[0];
    const others = offers.slice(1).map((o) => o.bestPrice);
    const ref = others.length >= 2 ? median(others) : null;
    const realDiscount = ref ? 1 - best.bestPrice / ref : null;
    const listDiscount = best.listPrice > best.bestPrice ? 1 - best.bestPrice / best.listPrice : 0;

    const qualifies = ref != null ? realDiscount >= MIN_REAL_DISCOUNT : listDiscount >= MIN_LIST_DISCOUNT;
    if (!qualifies) continue;

    deals.push({
      key: best.ean ? `e:${best.ean}` : `s:${best.storeId}:${best.skuId}`,
      category: g.category,
      ean: best.ean,
      name: best.name,
      brand: best.maker || best.brand,
      image: best.image,
      dosage: best.dosage,
      quantity: best.quantity,
      best,
      storesCount: offers.length,
      refPrice: ref != null ? Math.round(ref * 100) / 100 : null,
      realDiscount: realDiscount != null ? Math.round(realDiscount * 100) : null,
      listDiscount: Math.round(listDiscount * 100),
      // comparação entre lojas vale mais que o "de/por" da própria loja
      score: realDiscount != null ? realDiscount : listDiscount * 0.5,
      others: offers.slice(1, 6).map((o) => ({ storeId: o.storeId, storeName: o.storeName, price: o.bestPrice })),
    });
  }
  return deals.sort((a, b) => b.score - a.score).slice(0, MAX_DEALS);
}

// ---------- varredura ----------
// Uma varredura por vez; quem chegar durante ela espera a mesma.
let scanPromise = null;
function scan() {
  if (!scanPromise) {
    scanPromise = doScan().finally(() => {
      scanning = null;
      scanPromise = null;
    });
  }
  return scanPromise;
}

async function doScan() {
  const tasks = [];
  for (const store of STORES) for (const cat of DEAL_CATEGORIES) for (const term of cat.terms) tasks.push({ store, cat, term });
  scanning = { done: 0, total: tasks.length, startedAt: new Date().toISOString() };

  const entries = [];
  // em paralelo entre lojas, mas poucas requisições simultâneas por loja
  const byStore = STORES.map((s) => tasks.filter((t) => t.store === s));
  await Promise.all(
    byStore.map((list) =>
      mapLimit(list, 2, async ({ store, cat, term }) => {
        try {
          const { offers } = await searchStore(store, term, { sort: 'discount' });
          for (const offer of offers) entries.push({ category: cat.id, offer });
          record(offers.filter((o) => o.relevant)).catch(() => {});
        } catch {
          /* loja fora do ar: segue com as outras */
        }
        scanning.done++;
      }),
    ),
  );

  const deals = scoreDeals(entries);
  scanning = null;
  // varredura que falhou inteira (farmácias fora do ar ou bloqueando) não apaga as ofertas anteriores
  if (!deals.length && snapshot?.deals?.length) {
    console.error('Varredura de ofertas não trouxe nada; mantendo as anteriores');
    return;
  }
  snapshot = { updatedAt: new Date().toISOString(), deals };
  await writeJson(FILE, snapshot).catch((err) => console.error('Falha ao salvar ofertas:', err.message));
  console.log(`Superofertas atualizadas: ${snapshot.deals.length} ofertas`);
}

export function refreshDeals() {
  scan().catch((err) => console.error('Falha na varredura de ofertas:', err));
}

const isFresh = () =>
  Boolean(snapshot?.deals?.length) && Date.now() - Date.parse(snapshot.updatedAt) < REFRESH_MS;

// Serverless: garante ofertas frescas esperando a varredura dentro da requisição.
export async function ensureDeals() {
  if (!snapshot) snapshot = await readJson(FILE, null);
  if (!isFresh()) await scan().catch((err) => console.error('Falha na varredura de ofertas:', err));
  return getDeals();
}

export async function startDeals() {
  snapshot = await readJson(FILE, null);
  if (SERVERLESS) return; // sem processo contínuo: a varredura acontece em ensureDeals()
  const age = snapshot ? Date.now() - Date.parse(snapshot.updatedAt) : Infinity;
  // a lista de farmácias mudou desde a última varredura: refaz (a mediana muda)
  const staleStores = snapshot?.deals?.some((d) => [d.best, ...(d.others || [])].some((o) => !STORE_BY_ID[o.storeId]));
  if (age > REFRESH_MS || staleStores) refreshDeals();
  setInterval(refreshDeals, REFRESH_MS).unref();
}

export function getDeals() {
  // enquanto a nova varredura não termina, esconde ofertas de lojas removidas
  const deals = (snapshot?.deals || [])
    .filter((d) => STORE_BY_ID[d.best.storeId])
    .map((d) => ({ ...d, others: (d.others || []).filter((o) => STORE_BY_ID[o.storeId]) }));
  return {
    updatedAt: snapshot?.updatedAt || null,
    scanning: scanning ? { done: scanning.done, total: scanning.total } : null,
    canRefresh: !SERVERLESS,
    categories: DEAL_CATEGORIES.map((c) => ({ id: c.id, name: c.name, count: deals.filter((d) => d.category === c.id).length })),
    deals,
  };
}

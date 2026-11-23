// Monitoramento de preços: produtos monitorados (por EAN) são verificados
// periodicamente em todas as farmácias. Gera alertas quando o preço atinge o
// alvo, bate o menor valor já visto ou cai bastante desde a última checagem.
// Notificação no celular opcional via ntfy.sh (variável NTFY_TOPIC).
import { randomUUID } from 'node:crypto';
import { STORES } from './stores.js';
import { findByEan, mapLimit } from './catalog.js';
import { simulateOne, cleanCep } from './shipping.js';
import { readJson, writeJson } from './jsonfile.js';

const FILE = 'watch.json';
const INTERVAL_MS = (Number(process.env.WATCH_INTERVAL_HOURS) || 6) * 3600 * 1000;
const MAX_FREIGHT = 100;
const BIG_DROP = 0.1; // queda de 10% desde a última checagem
const MAX_WATCHES = 100;
const MAX_ALERTS = 200;

let db = null; // { items: [], alerts: [] }
let checking = false;

async function load() {
  if (!db) db = await readJson(FILE, { items: [], alerts: [] });
  return db;
}
const save = () => writeJson(FILE, db);
const round2 = (v) => Math.round(v * 100) / 100;

export async function listWatches() {
  await load();
  return db.items;
}

export async function addWatch({ ean, name, image, target, cep }) {
  await load();
  if (!/^\d{6,14}$/.test(String(ean))) throw new Error('Produto sem código de barras não pode ser monitorado.');
  const existing = db.items.find((i) => i.ean === ean);
  const targetNum = Number(target) > 0 ? round2(Number(target)) : null;
  if (existing) {
    existing.target = targetNum;
    existing.cep = cleanCep(cep);
    await save();
    return existing;
  }
  if (db.items.length >= MAX_WATCHES) throw new Error(`Limite de ${MAX_WATCHES} produtos monitorados.`);
  const item = {
    id: randomUUID(),
    ean: String(ean),
    name: String(name || ean).slice(0, 200),
    image: typeof image === 'string' && /^https:\/\//.test(image) ? image.slice(0, 500) : null,
    target: targetNum,
    cep: cleanCep(cep),
    createdAt: new Date().toISOString(),
    last: null,
    low: null,
  };
  db.items.push(item);
  await save();
  checkItem(item).catch(() => {}); // primeira leitura imediata
  return item;
}

export async function removeWatch(id) {
  await load();
  db.items = db.items.filter((i) => i.id !== id);
  db.alerts = db.alerts.filter((a) => a.itemId !== id);
  await save();
}

export async function listAlerts() {
  await load();
  return db.alerts;
}

export async function markAlertsRead() {
  await load();
  for (const a of db.alerts) a.read = true;
  await save();
}

// Menor custo (preço + frete, se houver CEP) entre as farmácias
async function bestOffer(item) {
  const results = await mapLimit(STORES, 6, async (store) => {
    try {
      const offer = await findByEan(store, item.ean);
      if (!offer) return null;
      let freight = 0;
      let price = offer.price;
      if (item.cep) {
        const s = await simulateOne(store, offer.skuId, offer.sellerId || '1', item.cep);
        if (!s.ok || !s.delivery || s.delivery.price > MAX_FREIGHT) return null;
        freight = s.delivery.price;
        if (s.price != null) price = s.price;
      }
      return { storeId: store.id, storeName: store.name, price: round2(price), freight, total: round2(price + freight), url: offer.url, promos: offer.promos };
    } catch {
      return null;
    }
  });
  const valid = results.filter(Boolean).sort((a, b) => a.total - b.total);
  return { best: valid[0] || null, count: valid.length };
}

// Decide quais alertas disparar (função pura, testável)
export function alertsFor(item, best) {
  if (!best) return [];
  const out = [];
  const prev = item.last?.best?.total;
  const brl = (v) => `R$ ${v.toFixed(2).replace('.', ',')}`;
  const where = `${best.storeName}${best.freight ? ` (com frete ${brl(best.freight)})` : ''}`;
  if (item.target != null && best.total <= item.target && !(prev != null && prev <= item.target)) {
    out.push({ kind: 'target', message: `${item.name} chegou a ${brl(best.total)} na ${where} — seu alvo era ${brl(item.target)}.` });
  }
  if (item.low != null && best.total < item.low.total - 0.009) {
    out.push({ kind: 'low', message: `Menor preço já visto: ${item.name} por ${brl(best.total)} na ${where} (antes ${brl(item.low.total)}).` });
  } else if (prev != null && best.total <= prev * (1 - BIG_DROP)) {
    out.push({ kind: 'drop', message: `${item.name} caiu de ${brl(prev)} para ${brl(best.total)} na ${where}.` });
  }
  return out;
}

async function notify(alert, url) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      body: alert.message,
      headers: { Title: 'Pechinchilina: superoferta!', Tags: 'pill,moneybag', ...(url ? { Click: url } : {}) },
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    console.error('Falha ao enviar notificação:', err.message);
  }
}

export async function checkItem(item) {
  const { best, count } = await bestOffer(item);
  const alerts = alertsFor(item, best);
  const now = new Date().toISOString();
  for (const a of alerts) {
    const alert = { id: randomUUID(), at: now, itemId: item.id, name: item.name, url: best.url, storeId: best.storeId, total: best.total, read: false, ...a };
    db.alerts.unshift(alert);
    notify(alert, best.url);
  }
  db.alerts = db.alerts.slice(0, MAX_ALERTS);
  item.last = { at: now, best, stores: count };
  if (best && (!item.low || best.total < item.low.total)) item.low = { total: best.total, storeId: best.storeId, at: now };
  await save();
  return item;
}

export async function checkAll() {
  await load();
  if (checking) return;
  checking = true;
  try {
    for (const item of db.items) await checkItem(item).catch(() => {});
  } finally {
    checking = false;
  }
}

export async function startWatch() {
  await load();
  const due = () => db.items.some((i) => !i.last || Date.now() - Date.parse(i.last.at) >= INTERVAL_MS);
  const tick = () => {
    if (due()) checkAll().catch((err) => console.error('Falha no monitoramento:', err));
  };
  tick();
  setInterval(tick, 10 * 60 * 1000).unref();
}

export const isChecking = () => checking;

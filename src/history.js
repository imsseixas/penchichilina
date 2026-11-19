// Histórico de preços por EAN, salvo em data/history.json.
// Guarda o menor preço de cada farmácia por dia.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'history.json');
const MAX_POINTS_PER_EAN = 400;

let db = null;
let saveTimer = null;

async function load() {
  if (db) return db;
  try {
    db = JSON.parse(await readFile(FILE, 'utf8'));
  } catch {
    db = {};
  }
  return db;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await mkdir(dirname(FILE), { recursive: true });
      const tmp = FILE + '.tmp';
      await writeFile(tmp, JSON.stringify(db));
      await rename(tmp, FILE);
    } catch (err) {
      console.error('Falha ao salvar histórico:', err.message);
    }
  }, 1000);
}

// data local no formato AAAA-MM-DD (sv-SE usa esse formato)
const today = () => new Date().toLocaleDateString('sv-SE');

export async function record(offers) {
  await load();
  const d = today();
  for (const o of offers) {
    if (!o.ean) continue;
    const entry = (db[o.ean] ||= { name: o.name, points: [] });
    const existing = entry.points.find((p) => p.d === d && p.s === o.storeId);
    if (existing) existing.p = Math.min(existing.p, o.price);
    else entry.points.push({ d, s: o.storeId, p: o.price });
    if (entry.points.length > MAX_POINTS_PER_EAN) entry.points.splice(0, entry.points.length - MAX_POINTS_PER_EAN);
  }
  scheduleSave();
}

export async function summarize(eans) {
  await load();
  const out = {};
  for (const ean of eans) {
    const entry = db[ean];
    if (!entry?.points.length) continue;
    let min = entry.points[0];
    for (const p of entry.points) if (p.p < min.p) min = p;
    const days = new Set(entry.points.map((p) => p.d));
    // menor preço de cada dia, para o mini-gráfico
    const byDay = {};
    for (const p of entry.points) byDay[p.d] = Math.min(byDay[p.d] ?? Infinity, p.p);
    out[ean] = {
      min: min.p,
      minDate: min.d,
      minStore: min.s,
      days: days.size,
      series: Object.entries(byDay)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([d, p]) => ({ d, p })),
    };
  }
  return out;
}

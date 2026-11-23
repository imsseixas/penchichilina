import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize as normalizePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STORES, STORE_BY_ID } from './src/stores.js';
import { searchStore } from './src/vtex.js';
import { record, summarize } from './src/history.js';
import { checkShipping, cleanCep, simulateOne } from './src/shipping.js';
import { getDeals, refreshDeals, startDeals } from './src/deals.js';
import { optimizeCart, MAX_CART_ITEMS } from './src/cart.js';
import { addWatch, checkAll, isChecking, listAlerts, listWatches, markAlertsRead, removeWatch, startWatch } from './src/watch.js';
import { mapLimit } from './src/catalog.js';
import { approxCep, cleanGeo, cleanRadius, nearbyStores } from './src/nearby.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_QUERY_LEN = 100;
const MAX_BODY_BYTES = 100 * 1024;

const cache = new Map(); // `${storeId}|${query}` -> { at, result }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

// Rotas que alteram dados: só JSON e só a partir da própria página do app.
async function readBody(req) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) throw new HttpError(403, 'origem não permitida');
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    throw new HttpError(415, 'envie JSON');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'corpo muito grande');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'JSON inválido');
  }
}

async function cachedSearch(store, query, fresh) {
  const key = `${store.id}|${query.toLowerCase()}`;
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.result, cached: true };
  const result = await searchStore(store, query);
  cache.set(key, { at: Date.now(), result });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return { ...result, cached: false };
}

async function handleSearch(req, res, url) {
  const query = (url.searchParams.get('q') || '').trim().slice(0, MAX_QUERY_LEN);
  if (query.length < 2) return sendJson(res, 400, { error: 'Digite ao menos 2 caracteres.' });
  const fresh = url.searchParams.get('fresh') === '1';
  const geo = cleanGeo(url.searchParams.get('lat'), url.searchParams.get('lng'));
  // só com localização: usa o CEP de uma loja vizinha (a VTEX exige CEP)
  const userCep = cleanCep(url.searchParams.get('cep'));
  const cep = userCep || (geo ? await approxCep(geo) : null);
  const ids = (url.searchParams.get('stores') || '').split(',').filter((id) => STORE_BY_ID[id]);
  const stores = ids.length ? ids.map((id) => STORE_BY_ID[id]) : STORES;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...SECURITY_HEADERS,
  });
  let closed = false;
  req.on('close', () => (closed = true));
  const send = (event, data) => {
    if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('start', { query, cep, approxCep: Boolean(cep && !userCep), geo: Boolean(geo), stores: stores.map((s) => s.id) });
  const started = Date.now();

  await Promise.all(
    stores.map(async (store) => {
      const t0 = Date.now();
      let offers = [];
      try {
        const result = await cachedSearch(store, query, fresh);
        offers = result.offers;
        send('store', { storeId: store.id, ok: true, mode: result.mode, cached: result.cached, ms: Date.now() - t0, offers });
        if (!result.cached) record(offers).catch(() => {});
      } catch (err) {
        send('store', { storeId: store.id, ok: false, error: err.message, ms: Date.now() - t0, offers: [] });
        return;
      }
      // depois dos preços, verifica entrega no CEP (chega num segundo evento)
      if (cep && !closed) {
        const results = await checkShipping(store, offers, cep, geo).catch(() => ({}));
        send('shipping', { storeId: store.id, results });
      }
    }),
  );

  send('done', { ms: Date.now() - started });
  res.end();
}

// Lojas físicas de cada farmácia perto do CEP ou da localização
async function handleNearby(res, url) {
  const geo = cleanGeo(url.searchParams.get('lat'), url.searchParams.get('lng'));
  const cep = cleanCep(url.searchParams.get('cep'));
  if (!geo && !cep) throw new HttpError(400, 'informe CEP ou localização');
  sendJson(res, 200, await nearbyStores({ cep, geo, radiusKm: cleanRadius(url.searchParams.get('radius')) }));
}

async function handleHistory(res, url) {
  const eans = (url.searchParams.get('eans') || '')
    .split(',')
    .filter((e) => /^\d{6,14}$/.test(e))
    .slice(0, 300);
  sendJson(res, 200, await summarize(eans));
}

async function handleSuggest(res, url) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, MAX_QUERY_LEN);
  if (q.length < 2) return sendJson(res, 200, []);
  try {
    const r = await fetch(
      `${STORES[0].base}/api/io/_v/api/intelligent-search/autocomplete_suggestions?query=${encodeURIComponent(q)}&locale=pt-BR`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(4000) },
    );
    const data = await r.json();
    sendJson(res, 200, (data.searches || []).map((s) => s.term).filter(Boolean).slice(0, 8));
  } catch {
    sendJson(res, 200, []);
  }
}

// Verificação de entrega avulsa (usada pelas Superofertas)
async function handleShipping(req, res) {
  const body = await readBody(req);
  const cep = cleanCep(body.cep);
  if (!cep) throw new HttpError(400, 'CEP inválido');
  const items = (Array.isArray(body.items) ? body.items : [])
    .filter((i) => STORE_BY_ID[i.storeId] && /^\d{1,12}$/.test(String(i.skuId)))
    .slice(0, 80);
  const results = await mapLimit(items, 8, async (i) => {
    try {
      const seller = /^[\w-]{1,40}$/.test(String(i.sellerId)) ? String(i.sellerId) : '1';
      return { storeId: i.storeId, skuId: String(i.skuId), result: await simulateOne(STORE_BY_ID[i.storeId], i.skuId, seller, cep) };
    } catch (err) {
      return { storeId: i.storeId, skuId: String(i.skuId), result: { ok: null, error: err.message } };
    }
  });
  sendJson(res, 200, results);
}

async function handleCart(req, res) {
  const body = await readBody(req);
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw new HttpError(400, 'carrinho vazio');
  if (items.length > MAX_CART_ITEMS) throw new HttpError(400, `máximo de ${MAX_CART_ITEMS} itens`);
  const mode = body.mode === 'any' ? 'any' : 'delivery';
  sendJson(res, 200, await optimizeCart(items, cleanCep(body.cep), mode));
}

async function handleWatch(req, res, url) {
  const id = url.pathname.split('/')[3];
  if (req.method === 'GET' && !id) return sendJson(res, 200, { items: await listWatches(), checking: isChecking() });
  if (req.method === 'POST' && !id) {
    const body = await readBody(req);
    try {
      return sendJson(res, 200, await addWatch(body));
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  }
  if (req.method === 'POST' && id === 'check') {
    await readBody(req);
    checkAll().catch(() => {});
    return sendJson(res, 202, { ok: true });
  }
  if (req.method === 'DELETE' && id) {
    await readBody(req);
    await removeWatch(id);
    return sendJson(res, 200, { ok: true });
  }
  throw new HttpError(405, 'método não permitido');
}

async function handleAlerts(req, res, url) {
  if (req.method === 'GET') return sendJson(res, 200, await listAlerts());
  if (req.method === 'POST' && url.pathname === '/api/alerts/read') {
    await readBody(req);
    await markAlertsRead();
    return sendJson(res, 200, { ok: true });
  }
  throw new HttpError(405, 'método não permitido');
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = normalizePath(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + sep)) return sendJson(res, 403, { error: 'proibido' });
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', ...SECURITY_HEADERS });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: 'não encontrado' });
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;
    if (p.startsWith('/api/watch')) return await handleWatch(req, res, url);
    if (p.startsWith('/api/alerts')) return await handleAlerts(req, res, url);
    if (req.method === 'POST') {
      if (p === '/api/shipping') return await handleShipping(req, res);
      if (p === '/api/cart/optimize') return await handleCart(req, res);
      if (p === '/api/deals/refresh') {
        await readBody(req);
        refreshDeals();
        return sendJson(res, 202, { ok: true });
      }
      throw new HttpError(404, 'não encontrado');
    }
    if (req.method !== 'GET') throw new HttpError(405, 'método não permitido');
    switch (p) {
      case '/api/stores':
        return sendJson(res, 200, STORES.map(({ id, name, base, color }) => ({ id, name, base, color })));
      case '/api/search':
        return await handleSearch(req, res, url);
      case '/api/nearby':
        return await handleNearby(res, url);
      case '/api/history':
        return await handleHistory(res, url);
      case '/api/suggest':
        return await handleSuggest(res, url);
      case '/api/deals':
        return sendJson(res, 200, getDeals());
      case '/api/config':
        return sendJson(res, 200, { phoneNotifications: Boolean(process.env.NTFY_TOPIC) });
      default:
        return await serveStatic(res, p);
    }
  } catch (err) {
    if (err instanceof HttpError) return res.headersSent ? res.end() : sendJson(res, err.status, { error: err.message });
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'erro interno' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Pechinchilina rodando em http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  startDeals().catch((err) => console.error('Falha ao iniciar ofertas:', err));
  startWatch().catch((err) => console.error('Falha ao iniciar monitoramento:', err));
});

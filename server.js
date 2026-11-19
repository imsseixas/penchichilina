import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize as normalizePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STORES, STORE_BY_ID } from './src/stores.js';
import { searchStore } from './src/vtex.js';
import { record, summarize } from './src/history.js';
import { checkShipping, cleanCep } from './src/shipping.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_QUERY_LEN = 100;

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

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
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
  const cep = cleanCep(url.searchParams.get('cep'));
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

  send('start', { query, cep, stores: stores.map((s) => s.id) });
  const started = Date.now();

  await Promise.all(
    stores.map(async (store) => {
      const t0 = Date.now();
      let offers = [];
      try {
        const result = await cachedSearch(store, query, fresh);
        offers = result.offers;
        send('store', {
          storeId: store.id,
          ok: true,
          mode: result.mode,
          cached: result.cached,
          ms: Date.now() - t0,
          offers,
        });
        if (!result.cached) record(offers).catch(() => {});
      } catch (err) {
        send('store', { storeId: store.id, ok: false, error: err.message, ms: Date.now() - t0, offers: [] });
        return;
      }
      // depois dos preços, verifica entrega no CEP (chega num segundo evento)
      if (cep && !closed) {
        const results = await checkShipping(store, offers, cep).catch(() => ({}));
        send('shipping', { storeId: store.id, results });
      }
    }),
  );

  send('done', { ms: Date.now() - started });
  res.end();
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
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'método não permitido' });
    switch (url.pathname) {
      case '/api/stores':
        return sendJson(res, 200, STORES.map(({ id, name, base, color }) => ({ id, name, base, color })));
      case '/api/search':
        return await handleSearch(req, res, url);
      case '/api/history':
        return await handleHistory(res, url);
      case '/api/suggest':
        return await handleSuggest(res, url);
      default:
        return await serveStatic(res, url.pathname);
    }
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'erro interno' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Pechinchilina rodando em http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});

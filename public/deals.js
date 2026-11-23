// Superofertas: produtos com preço bem abaixo do que as outras farmácias cobram
// (suplementos, higiene, bebê, remédios sem receita). Atualizado pelo servidor.
import { $, api, brl, bus, esc, fmtAgo, fmtCep, getCep, promoHtml, safeUrl, shipHtml, MAX_FREIGHT, pkgLabel, toast } from './common.js';
import { addToCart } from './cart.js';
import { openWatchDialog } from './watch.js';

const PAGE = 48;
let storeById = {};
let data = null;
let pollTimer = null;
let limit = PAGE;
const filters = { category: '', sort: 'score', realOnly: false, hideUndeliverable: true };
let ship = {}; // `${storeId}|${skuId}` -> resultado da simulação
let shipCep = null;
let shipInFlight = false;

const shipKey = (d) => `${d.best.storeId}|${d.best.skuId}`;

function deliverable(d) {
  if (!shipCep) return true;
  const s = ship[shipKey(d)];
  if (!s || s.ok == null) return null;
  return Boolean(s.ok && ((s.delivery && s.delivery.price <= MAX_FREIGHT) || s.pickup));
}

function visibleDeals() {
  if (!data) return [];
  let list = data.deals.filter(
    (d) =>
      (!filters.category || d.category === filters.category) &&
      (!filters.realOnly || d.realDiscount != null) &&
      !(filters.hideUndeliverable && deliverable(d) === false),
  );
  if (filters.sort === 'price') list = list.slice().sort((a, b) => a.best.bestPrice - b.best.bestPrice);
  else if (filters.sort === 'discount')
    list = list.slice().sort((a, b) => (b.realDiscount ?? b.listDiscount) - (a.realDiscount ?? a.listDiscount));
  return list;
}

function dealCard(d) {
  const o = d.best;
  const img = safeUrl(d.image);
  const url = safeUrl(o.url);
  const store = storeById[o.storeId];
  const badge =
    d.realDiscount != null
      ? `<span class="deal-badge real" title="Comparado ao preço mediano de ${d.storesCount - 1} outras farmácias">${d.realDiscount}% abaixo das outras farmácias</span>`
      : `<span class="deal-badge list" title="Desconto informado pela própria loja (de/por), sem comparação com outras farmácias">-${d.listDiscount}% no site da loja</span>`;
  const ref = d.refPrice != null ? `<div class="deal-ref">outras cobram ~${brl.format(d.refPrice)}</div>` : '';
  const old = o.listPrice > o.price + 0.005 ? `<span class="old">${brl.format(o.listPrice)}</span>` : '';
  const promos = [...(o.promos || []).map(promoHtml), ...(o.highlights || []).map((h) => `<span class="promo">${esc(h)}</span>`)].join(' ');
  const shipLine = shipCep ? `<div class="deal-ship">${shipHtml(ship[shipKey(d)], o.price)}</div>` : '';
  const meta = [d.brand, d.dosage, pkgLabel(d.quantity)].filter(Boolean).map(esc).join(' · ');
  return `<article class="deal" data-key="${esc(d.key)}">
    <div class="deal-top">${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="ci-ph">🛍️</span>'}${badge}</div>
    <h3 class="deal-name">${esc(d.name)}</h3>
    ${meta ? `<div class="deal-meta">${meta}</div>` : ''}
    <div class="deal-price">${brl.format(o.bestPrice)} ${o.bestPrice < o.price - 0.005 ? '<small>cada, na promoção</small>' : old}</div>
    <div class="deal-store"><i style="background:${esc(store?.color || '#999')}"></i>${esc(o.storeName)}</div>
    ${ref}
    ${promos ? `<div class="deal-promos">${promos}</div>` : ''}
    ${shipLine}
    <div class="deal-actions">
      ${url ? `<a class="btn-small" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Ver na loja ↗</a>` : ''}
      <button type="button" class="btn-small ghost" data-cart title="Adicionar ao carrinho">🛒</button>
      ${d.ean ? '<button type="button" class="btn-small ghost" data-watch title="Monitorar preço">🔔</button>' : ''}
    </div>
  </article>`;
}

function render() {
  const head = $('#deals-status');
  if (!data) {
    head.textContent = 'Carregando…';
    return;
  }
  const scanning = data.scanning;
  let status = data.updatedAt ? `Atualizado ${fmtAgo(data.updatedAt)}` : 'Ainda não há ofertas coletadas';
  if (scanning) status += ` · procurando ofertas nas farmácias (${Math.round((scanning.done / scanning.total) * 100)}%)…`;
  head.innerHTML = `${esc(status)}${scanning ? '' : ' · <button type="button" class="link-btn" id="deals-refresh">atualizar agora</button>'}`;

  $('#deal-cats').innerHTML = [{ id: '', name: 'Todas', count: data.deals.length }, ...data.categories]
    .map((c) => `<button type="button" class="chip" data-cat="${esc(c.id)}" aria-pressed="${filters.category === c.id}">${esc(c.name)} <span class="muted">${c.count}</span></button>`)
    .join('');

  const list = visibleDeals();
  const cep = getCep();
  $('#deals-cep').innerHTML = cep
    ? `Entrega no CEP <b>${esc(fmtCep(cep))}</b>${shipInFlight ? ' · verificando…' : ''}`
    : 'Informe seu CEP no topo para ver só o que entrega na sua casa.';
  $('#deals-grid').innerHTML = list.length
    ? list.slice(0, limit).map(dealCard).join('')
    : `<p class="muted">${scanning && !data.deals.length ? 'Primeira varredura em andamento — leva cerca de 1 minuto.' : 'Nenhuma oferta com esses filtros.'}</p>`;
  $('#deals-more').hidden = list.length <= limit;
  checkShipping(list.slice(0, limit));
}

// verifica entrega apenas dos cards visíveis que ainda não foram checados
async function checkShipping(list) {
  const cep = getCep();
  if (cep !== shipCep) {
    ship = {};
    shipCep = cep;
  }
  if (!cep || shipInFlight) return;
  const todo = list.filter((d) => !(shipKey(d) in ship)).slice(0, 60);
  if (!todo.length) return;
  shipInFlight = true;
  try {
    const results = await api('/api/shipping', {
      method: 'POST',
      body: { cep, items: todo.map((d) => ({ storeId: d.best.storeId, skuId: d.best.skuId, sellerId: d.best.sellerId })) },
    });
    if (cep === shipCep) for (const r of results) ship[`${r.storeId}|${r.skuId}`] = r.result;
  } catch {
    for (const d of todo) ship[shipKey(d)] = { ok: null, error: 'falha na verificação' };
  } finally {
    shipInFlight = false;
  }
  render();
}

async function load() {
  try {
    data = await api('/api/deals');
  } catch (err) {
    toast(`Não foi possível carregar as ofertas: ${err.message}`);
    return;
  }
  render();
  clearTimeout(pollTimer);
  if (data.scanning) pollTimer = setTimeout(load, 3000);
}

function dealToItem(d) {
  return {
    key: d.key,
    ean: d.ean,
    name: d.name,
    image: d.image,
    best: d.best.bestPrice,
    offers: [{ storeId: d.best.storeId, skuId: d.best.skuId, sellerId: d.best.sellerId, url: d.best.url }],
  };
}

export function showDeals() {
  load();
}

export function initDeals(stores) {
  storeById = stores;
  $('#deal-cats').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    filters.category = b.dataset.cat;
    limit = PAGE;
    render();
  });
  $('#deals-sort').addEventListener('change', (e) => {
    filters.sort = e.target.value;
    render();
  });
  $('#deals-real').addEventListener('change', (e) => {
    filters.realOnly = e.target.checked;
    limit = PAGE;
    render();
  });
  $('#deals-more').addEventListener('click', () => {
    limit += PAGE;
    render();
  });
  $('#deals-status').addEventListener('click', async (e) => {
    if (!e.target.closest('#deals-refresh')) return;
    await api('/api/deals/refresh', { method: 'POST', body: {} }).catch((err) => toast(err.message));
    setTimeout(load, 500);
  });
  $('#deals-grid').addEventListener('click', (e) => {
    const card = e.target.closest('.deal');
    const d = card && data?.deals.find((x) => x.key === card.dataset.key);
    if (!d) return;
    if (e.target.closest('[data-cart]')) addToCart(dealToItem(d));
    else if (e.target.closest('[data-watch]')) openWatchDialog(dealToItem(d));
  });
  bus.addEventListener('cep-changed', () => {
    if (!$('#view-deals').hidden && data) render();
  });
}

// Pechinchilina — busca (tela principal), roteamento e inicialização
import {
  $, brl, bus, esc, safeUrl, fmtUnit, fmtDate, fmtCep, cleanCep, normalize, storage, pkgLabel, shipHtml as shipCell, MAX_FREIGHT, toast,
  promoHtml, initPanel, api,
} from './common.js';
import { loadNear, saveNear, requestLocation, openState, fmtKm, pointHtml } from './near.js';
import { addToCart, initCart } from './cart.js';
import { initWatch, openWatchDialog } from './watch.js';
import { initDeals, showDeals } from './deals.js';
import { icon, hydrateIcons } from './icons.js';

const PAGE = 30;
const OFFERS_VISIBLE = 4;
const RECENT_KEY = 'pechinchilina:recent';
const CEP_KEY = 'pechinchilina:cep';

const state = {
  stores: [],
  storeById: {},
  status: {},
  offers: [],
  history: {},
  query: '',
  cep: null, // CEP usado na busca atual
  approxCep: false, // CEP derivado da localização (usuário não informou)
  shipping: {}, // storeId -> skuId -> resultado da simulação
  // "perto de mim": ir à farmácia física
  nearOn: false,
  geo: null, // { lat, lng } arredondados
  radius: 3, // km
  nearby: null, // resposta de /api/nearby da busca atual
  nearbyHours: new Map(), // id da loja física -> horários
  searchId: 0,
  source: null,
  limit: PAGE,
  expanded: new Set(),
  groupsByKey: new Map(),
  filters: {
    type: '', dosage: '', pkg: '', promoOnly: false, multiStore: false, loose: false, usePromos: true, sort: 'unit',
    hiddenStores: new Set(), shipMode: 'delivery', hideUndeliverable: true,
    makers: new Set(), // chaves dos fabricantes marcados (vazio = todos)
  },
  makersExpanded: false,
};

const MAKERS_SHOWN = 8;

const effPrice = (o) => (state.filters.usePromos ? o.bestPrice : Math.min(o.price, o.spotPrice ?? Infinity));

// ---------- entrega ----------
const shipOf = (o) => state.shipping[o.storeId]?.[o.skuId];
const storeMode = () => state.filters.shipMode === 'store';
const whereLabel = () => (state.approxCep || (storeMode() && state.geo) ? 'perto de você' : fmtCep(state.cep));

// lojas físicas com o produto dentro do raio (já ordenadas por distância)
function nearPoints(o) {
  return (shipOf(o)?.pickup?.points || []).filter((p) => p.distanceKm != null && p.distanceKm <= state.radius);
}
// a loja para ir: a mais perto que está aberta agora (senão, a mais perto)
function nearPoint(o) {
  const pts = nearPoints(o);
  return pts.find((p) => openState(state.nearbyHours.get(p.id)).open === true) || pts[0] || null;
}

// 0 = sem CEP ou retirada grátis; número = frete; null = ainda verificando
// ou não deu para verificar; Infinity = não atende o CEP
function freightOf(o) {
  if (!state.cep) return 0;
  const s = shipOf(o);
  // ir à farmácia: sem confirmação de estoque (loja já verificada, mas este
  // produto ficou de fora ou deu erro) não conta como disponível
  if (!s || s.ok == null) return storeMode() && state.shipping[o.storeId] ? Infinity : null;
  // ir à farmácia: só vale se uma loja física perto tem o produto
  if (storeMode()) return nearPoint(o) ? 0 : Infinity;
  if (!s.ok) return Infinity;
  if (state.filters.shipMode === 'any' && s.pickup) return 0;
  return s.delivery && s.delivery.price <= MAX_FREIGHT ? s.delivery.price : Infinity;
}

// custo usado para comparar: preço (com promo, se ativado) + frete
function costOf(o) {
  const f = freightOf(o);
  if (f === Infinity) return 1e6 + effPrice(o);
  const s = shipOf(o);
  // diferença entre o preço regional (simulação) e o do catálogo
  const regional = s?.ok && s.price != null ? s.price - o.price : 0;
  return effPrice(o) + regional + (f ?? 0);
}

// ---------- agrupamento ----------
function buildGroups() {
  const f = state.filters;
  const pool = state.offers.filter(
    (o) =>
      (f.loose || o.relevant) &&
      !f.hiddenStores.has(o.storeId) &&
      !(state.cep && f.hideUndeliverable && freightOf(o) === Infinity),
  );

  const map = new Map();
  for (const o of pool) {
    const key = o.ean ? `e:${o.ean}` : `n:${normalize(o.name)}`;
    let g = map.get(key);
    if (!g) map.set(key, (g = { key, ean: o.ean, offers: [] }));
    // uma oferta por farmácia (a mais barata)
    const prev = g.offers.findIndex((x) => x.storeId === o.storeId);
    if (prev === -1) g.offers.push(o);
    else if (costOf(o) < costOf(g.offers[prev])) g.offers[prev] = o;
  }

  const groups = [];
  for (const g of map.values()) {
    const km = (o) => (storeMode() ? nearPoint(o)?.distanceKm ?? 999 : 0);
    g.offers.sort((a, b) => costOf(a) - costOf(b) || km(a) - km(b) || a.price - b.price);
    const withDose = g.offers.filter((o) => o.dosage);
    const named = (withDose.length ? withDose : g.offers).slice().sort((a, b) => a.name.length - b.name.length);
    g.name = named[0].name;
    g.image = g.offers.find((o) => o.image)?.image;
    g.dosage = withDose[0]?.dosage || null;
    g.quantity = g.offers.find((o) => o.quantity)?.quantity || null;
    g.type = g.offers.find((o) => o.type)?.type || null;
    g.brand = g.offers.find((o) => o.brand)?.brand || null;
    g.maker = groupMaker(g.offers);
    g.best = g.offers[0];
    g.min = effPrice(g.best);
    g.freight = freightOf(g.best);
    g.total = costOf(g.best);
    const deliverable = g.offers.filter((o) => freightOf(o) !== Infinity);
    g.max = deliverable.length ? Math.max(...deliverable.map(costOf)) : g.total;
    g.savings = g.max - g.total;
    g.unit = g.quantity ? g.total / g.quantity.qty : null;
    g.maxDiscount = Math.max(...g.offers.map((o) => o.discountPct));
    g.hasPromo = g.offers.some((o) => o.discountPct >= 5 || o.promos.length || o.highlights.length);
    g.noDelivery = state.cep && g.freight === Infinity;
    // distância da loja mostrada no card (a da oferta mais barata)
    g.nearKm = storeMode() ? nearPoint(g.best)?.distanceKm ?? null : null;
    groups.push(g);
  }
  return groups;
}

// O mesmo produto (mesmo EAN) pode vir com fabricante diferente em cada farmácia;
// vale o que a maioria informa, com peso maior para o campo "Fabricante" da loja.
function groupMaker(offers) {
  const votes = new Map();
  for (const o of offers) {
    if (!o.makerKey) continue;
    const v = votes.get(o.makerKey) || { key: o.makerKey, name: o.maker, n: 0 };
    v.n += o.makerSure ? 2 : 1;
    votes.set(o.makerKey, v);
  }
  let best = null;
  for (const v of votes.values()) if (!best || v.n > best.n) best = v;
  return best ? { key: best.key, name: best.name } : null;
}

function applyGroupFilters(groups) {
  const f = state.filters;
  return groups.filter(
    (g) =>
      (!f.type || g.type === f.type) &&
      (!f.makers.size || f.makers.has(g.maker?.key)) &&
      (!f.dosage || g.dosage === f.dosage) &&
      (!f.pkg || pkgLabel(g.quantity) === f.pkg) &&
      (!f.promoOnly || g.hasPromo) &&
      (!f.multiStore || g.offers.length > 1),
  );
}

const SORTERS = {
  unit: (a, b) => (a.unit ?? Infinity) - (b.unit ?? Infinity) || a.total - b.total,
  price: (a, b) => a.total - b.total,
  savings: (a, b) => b.savings - a.savings || a.total - b.total,
  discount: (a, b) => b.maxDiscount - a.maxDiscount || a.total - b.total,
  stores: (a, b) => b.offers.length - a.offers.length || a.total - b.total,
  distance: (a, b) => (a.nearKm ?? Infinity) - (b.nearKm ?? Infinity) || a.total - b.total,
};

// ---------- renderização ----------
function storeShipSummary(storeId) {
  if (!state.shipping[storeId]) return null;
  const checked = state.offers.filter((o) => o.storeId === storeId && o.relevant && shipOf(o) && shipOf(o).ok != null);
  if (!checked.length) return null;
  return { ok: checked.filter((o) => freightOf(o) !== Infinity).length, total: checked.length };
}

function renderStatus() {
  const el = $('#status');
  el.hidden = false;
  el.innerHTML = state.stores
    .filter((s) => state.status[s.id])
    .map((s) => {
      const st = state.status[s.id];
      let info = '';
      let cls = st.state;
      if (st.state === 'ok') info = ` · ${st.count}`;
      if (st.state === 'error') info = ' · falhou';
      let title = st.state === 'error' ? `Erro: ${st.error}` : st.state === 'ok' ? `${st.ms} ms${st.cached ? ' (cache)' : ''}` : 'buscando…';
      if (state.cep && st.state === 'ok' && st.count) {
        const sum = storeShipSummary(s.id);
        const store = storeMode();
        const failed = state.shipping[s.id] && !sum && Object.values(state.shipping[s.id]).some((r) => r.ok == null);
        if (!state.shipping[s.id]) {
          info += store ? ' · vendo estoque nas lojas…' : ' · verificando CEP…';
        } else if (failed) {
          info += ' · não deu para verificar';
          title += ' — a farmácia não respondeu à verificação; tente de novo em alguns minutos';
          cls += ' no-ship';
        } else if (sum && sum.ok === 0) {
          info += store ? ' · sem estoque perto' : ' · não atende seu CEP';
          cls += ' no-ship';
        } else if (sum) {
          const word = store ? 'na loja' : 'entrega';
          info += sum.ok === sum.total ? ` · ${word} ✓` : ` · ${word} ${sum.ok}/${sum.total}`;
          title += store
            ? ` — ${sum.ok} de ${sum.total} produtos em loja a até ${state.radius} km`
            : ` — atende ${sum.ok} de ${sum.total} produtos no CEP ${whereLabel()}`;
        }
      }
      return `<span class="store-pill ${cls}" title="${esc(title)}"><span class="dot"></span>${esc(s.name)}${info}</span>`;
    })
    .join('');
}

function renderFilterOptions(allGroups) {
  const types = [...new Set(allGroups.map((g) => g.type).filter(Boolean))].sort();
  const f = state.filters;
  $('#type-chips').innerHTML = ['', ...types]
    .map((t) => `<button type="button" class="chip" data-type="${esc(t)}" aria-pressed="${f.type === t}">${esc(t || 'Todos')}</button>`)
    .join('');

  const count = (fn) => {
    const m = new Map();
    for (const g of allGroups) {
      const k = fn(g);
      if (k) m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const fillSelect = (sel, entries, current) => {
    sel.innerHTML =
      '<option value="">Todas</option>' +
      entries.map(([k, n]) => `<option value="${esc(k)}"${k === current ? ' selected' : ''}>${esc(k)} (${n})</option>`).join('');
  };
  fillSelect($('#dosage'), count((g) => g.dosage), f.dosage);
  fillSelect(
    $('#package'),
    count((g) => pkgLabel(g.quantity)).sort((a, b) => parseFloat(a[0]) - parseFloat(b[0])),
    f.pkg,
  );

  renderMakerFilter(allGroups);

  const perStore = {};
  for (const o of state.offers) if (f.loose || o.relevant) perStore[o.storeId] = (perStore[o.storeId] || 0) + 1;
  $('#store-filter').innerHTML = state.stores
    .map(
      (s) =>
        `<label><input type="checkbox" data-store="${esc(s.id)}"${f.hiddenStores.has(s.id) ? '' : ' checked'}>` +
        `<span>${esc(s.name)}</span><span class="n">${perStore[s.id] || 0}</span></label>`,
    )
    .join('');

  $('#ship-filters').hidden = !state.cep;
  syncShipControls();
}

function renderMakerFilter(allGroups) {
  const f = state.filters;
  const byKey = new Map();
  for (const g of allGroups) {
    if (!g.maker) continue;
    const e = byKey.get(g.maker.key) || { ...g.maker, n: 0 };
    e.n++;
    byKey.set(g.maker.key, e);
  }
  const makers = [...byKey.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'pt-BR'));
  $('#maker-field').hidden = makers.length < 2 && !f.makers.size;
  // os mais frequentes primeiro; os marcados aparecem mesmo quando a lista está recolhida
  const shown = state.makersExpanded ? makers : makers.filter((m, i) => i < MAKERS_SHOWN || f.makers.has(m.key));
  const rest = makers.length - shown.length;
  $('#maker-filter').innerHTML =
    shown
      .map(
        (m) =>
          `<label><input type="checkbox" data-maker="${esc(m.key)}"${f.makers.has(m.key) ? ' checked' : ''}>` +
          `<span>${esc(m.name)}</span><span class="n">${m.n}</span></label>`,
      )
      .join('') +
    '<div class="maker-actions">' +
    (rest > 0
      ? `<button type="button" class="link-btn" data-maker-more>Ver todos (${makers.length})</button>`
      : state.makersExpanded && makers.length > MAKERS_SHOWN
        ? '<button type="button" class="link-btn" data-maker-less>Mostrar menos</button>'
        : '') +
    (f.makers.size ? '<button type="button" class="link-btn" data-maker-clear>Limpar</button>' : '') +
    '</div>';
}

// controles que mudam no modo "ir à farmácia"
function syncShipControls() {
  const store = storeMode();
  $('#ship-mode').value = state.filters.shipMode;
  $('#ship-legend').textContent = store ? 'Onde comprar' : state.approxCep ? 'Entrega perto de você' : `Entrega no CEP ${fmtCep(state.cep)}`;
  $('#radius-field').hidden = !store;
  $('#radius').value = String(state.radius);
  $('#sort-distance').hidden = !store;
  $('#hide-undeliverable-label').textContent = store ? 'Esconder quem não tem o produto numa loja perto' : 'Esconder quem não atende meu CEP';
  $('#ship-hint').innerHTML = store
    ? 'Mostra a loja física mais perto <strong>com o produto em estoque</strong> (de preferência aberta agora). O preço é o do site para comprar e retirar; no balcão pode ser outro.'
    : 'Com CEP, o ranking compara <strong>preço + frete</strong> (frete de 1 unidade).';
  const btn = $('#near-btn');
  btn.setAttribute('aria-pressed', String(state.nearOn));
  btn.querySelector('span').textContent = state.nearOn && !state.geo ? 'Perto do CEP' : 'Perto de mim';
}

function shipHtml(o) {
  const s = shipOf(o);
  if (!s && state.shipping[o.storeId]) return '<span class="ship pending">não verificado</span>';
  if (!storeMode() || !s || s.ok == null) return shipCell(s, o.price);
  const p = nearPoint(o);
  if (!p) {
    const far = s.pickup?.points?.[0];
    return `<span class="ship"><span class="no">Sem estoque em loja a até ${state.radius} km</span>${
      far ? `<span class="sub">mais perto com estoque: ${esc(fmtKm(far.distanceKm))}</span>` : ''
    }</span>`;
  }
  return pointHtml(p, state.nearbyHours.get(p.id), { extra: nearPoints(o).length - 1 });
}

function sparkline(series) {
  if (series.length < 2) return '';
  const w = 90, h = 24, pad = 2;
  const ps = series.map((s) => s.p);
  const min = Math.min(...ps), max = Math.max(...ps), span = max - min || 1;
  const pts = series
    .map((s, i) => `${(pad + (i / (series.length - 1)) * (w - 2 * pad)).toFixed(1)},${(h - pad - ((s.p - min) / span) * (h - 2 * pad)).toFixed(1)}`)
    .join(' ');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
}

function historyHtml(g) {
  const h = g.ean && state.history[g.ean];
  if (!h || h.days < 2) return '';
  const store = state.storeById[h.minStore]?.name || h.minStore;
  const now = g.best.price;
  const verdict =
    now <= h.min + 0.005
      ? '<span class="good">Menor preço já registrado!</span>'
      : `Menor já visto: ${brl.format(h.min)} em ${esc(store)} (${fmtDate(h.minDate)})`;
  return `<div class="g-hist">${sparkline(h.series)}<span>${verdict} · ${h.days} dias de histórico</span></div>`;
}

function offerRow(o, g, i) {
  const store = state.storeById[o.storeId];
  const url = safeUrl(o.url);
  const old = o.listPrice > o.price + 0.005 ? `<span class="old">${brl.format(o.listPrice)}</span>` : '';
  const off = o.discountPct >= 1 ? `<span class="off">-${o.discountPct}%</span>` : '';
  const promos = [
    ...o.promos.map(promoHtml),
    ...o.highlights.map((h) => `<span class="promo">${esc(h)}</span>`),
    o.spotPrice ? `<span class="promo">À vista: <b>${brl.format(o.spotPrice)}</b></span>` : '',
  ].join(' ');
  const unit = g.quantity ? fmtUnit(o.price / g.quantity.qty, g.quantity.unit) : '';
  const isBest = i === 0 && g.offers.length > 1 && !g.noDelivery;
  return `<tr class="${isBest ? 'best' : ''}">
    <td class="c-store"><span class="store"><i style="background:${esc(store?.color || '#999')}"></i><span>${esc(o.storeName)}${isBest ? '<span class="best-badge">Melhor preço</span>' : ''}${o.sellerName ? `<span class="seller">vendido por ${esc(o.sellerName)}</span>` : ''}</span></span></td>
    <td class="c-price"><span class="price">${brl.format(o.price)}</span>${old || off ? `<span class="was">${old}${off}</span>` : ''}</td>
    <td class="c-promo">${promos}</td>
    ${state.cep ? `<td class="c-ship">${shipHtml(o)}</td>` : ''}
    <td class="c-unit num">${unit}</td>
    <td class="c-link">${url ? `<a class="go" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Ver na loja ${icon('external')}</a>` : ''}</td>
  </tr>`;
}

function freightLine(g) {
  if (!state.cep) return '';
  if (storeMode()) {
    if (g.freight == null) return '<div class="freight">vendo estoque nas lojas…</div>';
    if (g.freight === Infinity) return '<div class="freight">sem estoque em loja perto</div>';
    const p = nearPoint(g.best);
    return `<div class="freight">${icon('store')} ${esc(p.name)} · <b>${esc(fmtKm(p.distanceKm))}</b></div>`;
  }
  if (g.freight == null) return '<div class="freight">verificando frete…</div>';
  if (g.freight === Infinity) return '<div class="freight">nenhuma farmácia atende seu CEP</div>';
  if (g.freight === 0) return `<div class="freight">sem frete (retirada) · total <b>${brl.format(g.total)}</b></div>`;
  return `<div class="freight">+ frete ${brl.format(g.freight)} = <b>${brl.format(g.total)}</b></div>`;
}

function groupHtml(g) {
  const tags = [
    g.type ? `<span class="tag ${g.type === 'Genérico' ? 'generic' : ''}">${esc(g.type)}</span>` : '',
    g.maker ? `<span class="tag" title="Fabricante">${esc(g.maker.name)}</span>` : '',
    g.dosage ? `<span class="tag">${esc(g.dosage)}</span>` : '',
    g.quantity ? `<span class="tag">${esc(pkgLabel(g.quantity))}</span>` : '',
    `<span class="tag">${g.offers.length} ${g.offers.length === 1 ? 'farmácia' : 'farmácias'}</span>`,
  ].join('');

  const img = safeUrl(g.image);
  const imgHtml = img
    ? `<img class="g-img" src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : `<div class="g-img ph">${icon('pill')}</div>`;

  const best = g.best;
  const viaPromo = g.min < best.price - 0.005;
  const save =
    g.offers.length > 1 && g.savings >= 0.01 && !g.noDelivery
      ? `<span class="save">Economize ${brl.format(g.savings)} (${Math.round((g.savings / g.max) * 100)}%)</span>`
      : '';
  const unitLabel = g.unit != null && !g.noDelivery ? `<div class="unit">${fmtUnit(g.unit, g.quantity.unit)}${state.cep && !storeMode() ? ' c/ frete' : ''}</div>` : '';

  const expanded = state.expanded.has(g.key);
  const visible = expanded ? g.offers : g.offers.slice(0, OFFERS_VISIBLE);
  const hiddenCount = g.offers.length - visible.length;
  const actions = `<div class="g-actions">
      <button type="button" class="btn-small" data-cart="${esc(g.key)}">${icon('cart')} Adicionar</button>
      ${g.ean ? `<button type="button" class="btn-small ghost" data-watch="${esc(g.key)}">${icon('bell')} Monitorar</button>` : ''}
    </div>`;

  return `<article class="group" id="g-${esc(g.key)}">
    <div class="g-head">
      ${imgHtml}
      <div>
        <h3 class="g-title">${esc(g.name)}</h3>
        <div class="tags">${tags}</div>
        ${actions}
      </div>
      <div class="g-price">
        <div class="from">${viaPromo ? 'na promoção, por unidade' : g.offers.length > 1 ? 'menor preço' : 'preço'}</div>
        <div class="big">${brl.format(g.min)}</div>
        <div class="where">${esc(best.storeName)}</div>
        ${freightLine(g)}
        ${unitLabel}
        ${save}
      </div>
    </div>
    ${historyHtml(g)}
    <table class="offers">
      <thead><tr><th class="w-store">Farmácia</th><th class="w-price">Preço</th><th>Promoções</th>${state.cep ? `<th class="w-ship">${storeMode() ? `Loja a até ${state.radius} km` : `Entrega (${esc(whereLabel())})`}</th>` : ''}<th class="w-unit">Por unidade</th><th class="w-link"></th></tr></thead>
      <tbody>${visible.map((o, i) => offerRow(o, g, i)).join('')}</tbody>
    </table>
    ${
      g.offers.length > OFFERS_VISIBLE
        ? `<button type="button" class="toggle-more" data-key="${esc(g.key)}">${expanded ? 'Mostrar menos' : `Ver mais ${hiddenCount} ${hiddenCount === 1 ? 'farmácia' : 'farmácias'}`}</button>`
        : ''
    }
  </article>`;
}

function renderHighlights(groups) {
  const usable = groups.filter((g) => !g.noDelivery);
  if (!usable.length) return ($('#highlights').innerHTML = '');
  const pickMin = (arr, fn) => arr.reduce((a, b) => (fn(b) < fn(a) ? b : a));
  const withFreight = state.cep && !storeMode() ? ' (com frete)' : '';
  const cards = [];
  if (storeMode()) {
    // qual farmácia ir primeiro: a mais barata com loja aberta perto
    const opts = usable.map((g) => ({ g, p: nearPoint(g.best) })).filter((x) => x.p);
    if (opts.length) {
      const open = opts.filter((x) => openState(state.nearbyHours.get(x.p.id)).open !== false);
      const first = pickMin(open.length ? open : opts, (x) => x.g.total);
      cards.push({ ic: 'go', k: open.length ? 'Vá primeiro (aberta agora)' : 'Vá primeiro', v: brl.format(first.g.total), d: `${first.p.name} · ${fmtKm(first.p.distanceKm)} · ${first.g.name}`, key: first.g.key });
      const all = usable.flatMap((g) => g.offers.map((o) => ({ g, o, p: nearPoint(o) }))).filter((x) => x.p);
      const closest = pickMin(all, (x) => x.p.distanceKm);
      if (closest.p.id !== first.p.id)
        cards.push({ ic: 'store', k: 'Loja mais perto com o produto', v: fmtKm(closest.p.distanceKm), d: `${closest.p.name} · ${closest.g.name} por ${brl.format(costOf(closest.o))}`, key: closest.g.key });
    }
  } else {
    const cheapest = pickMin(usable, (g) => g.total);
    cards.push({ ic: 'tag', k: `Menor preço${withFreight}`, v: brl.format(cheapest.total), d: `${cheapest.name} · ${cheapest.best.storeName}`, key: cheapest.key });
  }

  const withUnit = usable.filter((g) => g.unit != null);
  if (withUnit.length) {
    const u = pickMin(withUnit, (g) => g.unit);
    cards.push({ ic: 'pill', k: `Menor preço por unidade${withFreight}`, v: fmtUnit(u.unit, u.quantity.unit), d: `${u.name} · ${u.best.storeName}`, key: u.key });
  }

  const multi = usable.filter((g) => g.offers.length > 1);
  if (multi.length) {
    const s = pickMin(multi, (g) => -g.savings);
    const worst = s.offers.filter((o) => freightOf(o) !== Infinity).at(-1);
    if (s.savings >= 0.5 && worst)
      cards.push({ ic: 'swap', k: 'Maior diferença entre lojas', v: brl.format(s.savings), d: `${s.name} · ${s.best.storeName} vs ${worst.storeName}`, key: s.key });
  }

  $('#highlights').innerHTML = cards
    .map((c) => `<button type="button" class="hl" data-jump="${esc(c.key)}"><div class="k">${icon(c.ic)}${esc(c.k)}</div><div class="v">${esc(c.v)}</div><div class="d">${esc(c.d)}</div></button>`)
    .join('');
}

let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const all = buildGroups();
    state.groupsByKey = new Map(all.map((g) => [g.key, g]));
    renderFilterOptions(all);
    const groups = applyGroupFilters(all).sort(SORTERS[state.filters.sort]);
    renderHighlights(groups);

    const loading = Object.values(state.status).some((s) => s.state === 'loading');
    const checkingCep =
      state.cep && state.stores.some((s) => state.status[s.id]?.state === 'ok' && state.status[s.id].count && !state.shipping[s.id]);
    const hiddenByCep =
      state.cep && state.filters.hideUndeliverable
        ? new Set(state.offers.filter((o) => o.relevant && freightOf(o) === Infinity).map((o) => o.storeId)).size
        : 0;
    const nStores = new Set(groups.flatMap((g) => g.offers.map((o) => o.storeId))).size;
    let summary = groups.length
      ? `${groups.length} ${groups.length === 1 ? 'produto' : 'produtos'} em ${nStores} ${nStores === 1 ? 'farmácia' : 'farmácias'}`
      : loading
        ? 'Buscando nas farmácias…'
        : state.offers.length
          ? 'Nenhum produto com esses filtros. Tente afrouxar os filtros ou marcar "Incluir resultados menos exatos".'
          : 'Nada encontrado. Confira a grafia ou tente só o nome do princípio ativo.';
    if (groups.length && loading) summary += ' — ainda buscando…';
    else if (groups.length && checkingCep)
      summary += storeMode() ? ' — vendo estoque nas lojas perto…' : ` — verificando entrega no CEP ${whereLabel()}…`;
    if (hiddenByCep) summary += storeMode() ? ' · produtos sem estoque em loja perto ocultos' : ' · ofertas que não atendem seu CEP ocultas';
    $('#summary').textContent = summary;

    $('#groups').innerHTML = groups.slice(0, state.limit).map(groupHtml).join('');
    $('#more').hidden = groups.length <= state.limit;
    $('#results-area').hidden = false;
    $('#empty-state').hidden = true;
  });
}

// ---------- busca ----------
function readCepInput() {
  const cepInput = $('#cep');
  const cep = cleanCep(cepInput.value);
  if (cepInput.value.trim() && !cep) {
    cepInput.classList.add('invalid');
    cepInput.focus();
    return undefined;
  }
  cepInput.classList.remove('invalid');
  storage(() => (cep ? localStorage.setItem(CEP_KEY, cep) : localStorage.removeItem(CEP_KEY)));
  return cep;
}

// Farmácias com loja física dentro do raio (modo "ir à farmácia")
async function loadNearby(cep, geo) {
  const params = new URLSearchParams({ radius: state.radius });
  if (geo) {
    params.set('lat', geo.lat);
    params.set('lng', geo.lng);
  } else {
    params.set('cep', cep);
  }
  return api(`/api/nearby?${params}`);
}

function renderNearInfo() {
  const el = $('#near-info');
  const nb = state.nearby;
  if (!storeMode() || !nb) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const where = state.geo ? 'de você' : `do CEP ${fmtCep(state.cep)}`;
  const near = nb.stores.filter((s) => s.count > 0).sort((a, b) => a.points[0].distanceKm - b.points[0].distanceKm);
  const wider = [5, 10].filter((r) => r > state.radius);
  const widen = wider.length
    ? ` <button type="button" class="link-btn" data-radius="${wider[0]}">ampliar para ${wider[0]} km</button>`
    : '';
  if (!near.length) {
    el.innerHTML = `${icon('pin')} <b>Nenhuma farmácia com loja física a até ${state.radius} km ${esc(where)}.</b>${widen}
      <span class="muted">Hoje só Drogaria São Paulo, Pacheco, Pague Menos e Extrafarma informam onde ficam suas lojas.</span>`;
    return;
  }
  const list = near
    .map((s) => `<b>${esc(s.storeName)}</b> (${s.count} ${s.count === 1 ? 'loja' : 'lojas'}, a mais perto a ${esc(fmtKm(s.points[0].distanceKm))})`)
    .join(' · ');
  el.innerHTML = `${icon('pin')} Buscando só nas farmácias com loja a até ${state.radius} km ${esc(where)}: ${list}.${widen}
    <span class="muted">As outras não têm loja na região ou não informam onde ficam.</span>`;
}

async function search(query, { fresh = false } = {}) {
  query = query.trim();
  if (query.length < 2) return;
  const cep = readCepInput();
  if (cep === undefined) return;
  const store = storeMode();
  const geo = store ? state.geo : null;
  if (store && !cep && !geo) {
    toast('Informe o CEP ou toque em "Perto de mim".');
    setNear(false);
  }
  showView('search');

  const id = ++state.searchId;
  state.source?.close();
  Object.assign(state, {
    query, cep, approxCep: false, offers: [], shipping: {}, history: {}, limit: PAGE, expanded: new Set(), status: {}, nearby: null,
  });
  Object.assign(state.filters, { type: '', dosage: '', pkg: '' });
  state.filters.makers.clear();
  state.makersExpanded = false;
  saveRecent(query);
  // o CEP e a localização ficam fora da URL para não vazar ao compartilhar o link
  const u = new URL(location.href);
  u.searchParams.set('q', query);
  u.hash = '';
  history.replaceState(null, '', u);
  document.title = `${query} — Pechinchilina`;

  // modo "ir à farmácia": busca só nas redes com loja física perto
  let storeIds = null;
  if (storeMode()) {
    $('#near-info').hidden = false;
    $('#near-info').innerHTML = `${icon('pin')} Procurando farmácias perto de você…`;
    $('#status').hidden = true;
    try {
      const nb = await loadNearby(cep, geo);
      if (id !== state.searchId) return;
      state.nearby = nb;
      state.nearbyHours = new Map(nb.stores.flatMap((s) => s.points.map((p) => [p.id, p.hours])));
      storeIds = nb.stores.filter((s) => s.count > 0).map((s) => s.storeId);
    } catch (err) {
      if (id !== state.searchId) return;
      toast(`Não deu para achar as lojas perto: ${err.message}`);
    }
    renderNearInfo();
    if (storeIds && !storeIds.length) {
      $('#results-area').hidden = true;
      $('#empty-state').hidden = true;
      return;
    }
  } else {
    $('#near-info').hidden = true;
  }

  for (const s of state.stores) if (!storeIds || storeIds.includes(s.id)) state.status[s.id] = { state: 'loading' };
  renderStatus();
  render();

  const params = new URLSearchParams({ q: query });
  if (cep) params.set('cep', cep);
  if (geo) {
    params.set('lat', geo.lat);
    params.set('lng', geo.lng);
  }
  if (storeIds) params.set('stores', storeIds.join(','));
  if (fresh) params.set('fresh', '1');
  const es = new EventSource(`/api/search?${params}`);
  state.source = es;

  es.addEventListener('start', (ev) => {
    const d = JSON.parse(ev.data);
    // só com localização: o servidor usa o CEP de uma loja vizinha
    if (d.cep && !state.cep) Object.assign(state, { cep: d.cep, approxCep: d.approxCep });
  });

  es.addEventListener('store', (ev) => {
    const d = JSON.parse(ev.data);
    state.status[d.storeId] = d.ok
      ? { state: 'ok', count: d.offers.filter((o) => o.relevant).length, ms: d.ms, cached: d.cached }
      : { state: 'error', error: d.error };
    state.offers.push(...d.offers);
    renderStatus();
    render();
  });
  es.addEventListener('shipping', (ev) => {
    const d = JSON.parse(ev.data);
    state.shipping[d.storeId] = d.results;
    renderStatus();
    render();
  });
  es.addEventListener('done', () => {
    es.close();
    // lojas sem ofertas relevantes não recebem verificação: marca como concluídas
    for (const s of state.stores) state.shipping[s.id] ||= {};
    renderStatus();
    loadHistory();
    render();
  });
  es.onerror = () => {
    es.close();
    for (const id of Object.keys(state.status)) {
      if (state.status[id].state === 'loading') state.status[id] = { state: 'error', error: 'conexão interrompida' };
      state.shipping[id] ||= {};
    }
    renderStatus();
    render();
  };
}

async function loadHistory() {
  const eans = [...new Set(state.offers.filter((o) => o.ean && o.relevant).map((o) => o.ean))].slice(0, 300);
  if (!eans.length) return;
  const q = state.query;
  try {
    const r = await fetch(`/api/history?eans=${eans.join(',')}`);
    const data = await r.json();
    if (q === state.query) {
      state.history = data;
      render();
    }
  } catch {
    /* histórico é opcional */
  }
}

// ---------- buscas recentes ----------
function getRecent() {
  return storage(() => JSON.parse(localStorage.getItem(RECENT_KEY)) || [], []);
}
function saveRecent(q) {
  const list = [q, ...getRecent().filter((x) => normalize(x) !== normalize(q))].slice(0, 8);
  storage(() => localStorage.setItem(RECENT_KEY, JSON.stringify(list)));
  renderRecent();
}
function renderRecent() {
  const list = getRecent();
  const el = $('#recent');
  el.hidden = !list.length;
  el.innerHTML = list.length
    ? 'Recentes: ' + list.map((q) => `<button type="button" data-q="${esc(q)}">${esc(q)}</button>`).join('')
    : '';
}

// ---------- perto de mim ----------
function setNear(on, { geo = state.geo } = {}) {
  state.nearOn = on;
  state.geo = on ? geo : null; // desligar esquece a localização
  state.filters.shipMode = on ? 'store' : 'delivery';
  if (!on && state.filters.sort === 'distance') {
    state.filters.sort = 'unit';
    $('#sort').value = 'unit';
  }
  saveNear({ on, geo: state.geo, radius: state.radius });
  syncShipControls();
}

function setRadius(r) {
  state.radius = r;
  saveNear({ on: state.nearOn, geo: state.geo, radius: r });
  syncShipControls();
  if (state.query && storeMode()) search(state.query);
}

async function toggleNear() {
  const btn = $('#near-btn');
  if (state.nearOn) {
    setNear(false);
  } else {
    btn.disabled = true;
    let geo = null;
    try {
      geo = await requestLocation();
    } catch (err) {
      if (!cleanCep($('#cep').value)) {
        toast(`${err.message} Informe o CEP para ver as farmácias perto.`);
        btn.disabled = false;
        return;
      }
      toast(`${err.message} Usando seu CEP.`);
    }
    btn.disabled = false;
    setNear(true, { geo });
    if (!state.query) toast('Agora busque o remédio: mostramos só farmácias com loja perto de você.');
  }
  if (state.query) search(state.query);
}

// ---------- abas ----------
function showView(view) {
  const deals = view === 'deals';
  document.body.dataset.page = view;
  $('#view-search').hidden = deals;
  $('#view-deals').hidden = !deals;
  document.querySelectorAll('a[data-view]').forEach((a) => a.setAttribute('aria-current', String(a.dataset.view === view)));
  if (deals) {
    // Superofertas é a página inicial
    history.replaceState(null, '', location.pathname);
    document.title = 'Pechinchilina — Superofertas';
    showDeals();
  } else {
    const u = new URL(location.href);
    u.hash = '';
    if (state.query) u.searchParams.set('q', state.query);
    history.replaceState(null, '', u);
    document.title = state.query ? `${state.query} — Pechinchilina` : 'Pechinchilina';
    if (!state.query) $('#q').focus();
  }
}

// converte um grupo da busca em item de carrinho/monitoramento
function groupToItem(g) {
  return {
    key: g.key,
    ean: g.ean,
    name: g.name,
    image: g.image,
    best: g.total,
    offers: g.offers.map((o) => ({ storeId: o.storeId, skuId: o.skuId, sellerId: o.sellerId, url: o.url })),
  };
}

// ---------- eventos ----------
function bind() {
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    search($('#q').value);
  });
  $('#recent').addEventListener('click', (e) => {
    const q = e.target.closest('button')?.dataset.q;
    if (q) {
      $('#q').value = q;
      search(q);
    }
  });
  document.querySelectorAll('a[data-view]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      showView(a.dataset.view);
    }),
  );
  window.addEventListener('hashchange', () => showView(location.hash === '#busca' ? 'search' : 'deals'));

  // máscara 00000-000
  $('#cep').addEventListener('input', (e) => {
    const d = e.target.value.replace(/\D/g, '').slice(0, 8);
    e.target.value = d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
    e.target.classList.remove('invalid');
  });
  $('#cep').addEventListener('change', () => {
    const cep = readCepInput();
    if (cep !== undefined) bus.dispatchEvent(new CustomEvent('cep-changed', { detail: cep }));
  });

  let suggestTimer;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(suggestTimer);
    const q = e.target.value.trim();
    if (q.length < 3) return;
    suggestTimer = setTimeout(async () => {
      try {
        const terms = await (await fetch(`/api/suggest?q=${encodeURIComponent(q)}`)).json();
        $('#suggestions').innerHTML = terms.map((t) => `<option value="${esc(t)}"></option>`).join('');
      } catch {
        /* sugestões são opcionais */
      }
    }, 250);
  });

  const f = state.filters;
  const onChange = (fn) => (e) => {
    fn(e);
    state.limit = PAGE;
    render();
  };
  $('#sort').addEventListener('change', onChange((e) => (f.sort = e.target.value)));
  $('#use-promos').addEventListener('change', onChange((e) => (f.usePromos = e.target.checked)));
  $('#promo-only').addEventListener('change', onChange((e) => (f.promoOnly = e.target.checked)));
  $('#multi-store').addEventListener('change', onChange((e) => (f.multiStore = e.target.checked)));
  $('#show-loose').addEventListener('change', onChange((e) => (f.loose = e.target.checked)));
  $('#dosage').addEventListener('change', onChange((e) => (f.dosage = e.target.value)));
  $('#package').addEventListener('change', onChange((e) => (f.pkg = e.target.value)));
  $('#ship-mode').addEventListener('change', (e) => {
    const next = e.target.value;
    // entrar ou sair do modo "ir à farmácia" muda quais farmácias são buscadas
    if (next === 'store' || storeMode()) {
      setNear(next === 'store');
      f.shipMode = next;
      syncShipControls();
      if (state.query) search(state.query);
      return;
    }
    f.shipMode = next;
    state.limit = PAGE;
    renderStatus();
    render();
  });
  $('#radius').addEventListener('change', (e) => setRadius(Number(e.target.value)));
  $('#near-info').addEventListener('click', (e) => {
    const r = e.target.closest('[data-radius]')?.dataset.radius;
    if (r) setRadius(Number(r));
  });
  $('#near-btn').addEventListener('click', toggleNear);
  $('#hide-undeliverable').addEventListener('change', onChange((e) => (f.hideUndeliverable = e.target.checked)));
  $('#type-chips').addEventListener(
    'click',
    onChange((e) => {
      const b = e.target.closest('[data-type]');
      if (b) f.type = b.dataset.type;
    }),
  );
  $('#maker-filter').addEventListener(
    'change',
    onChange((e) => {
      const key = e.target.dataset.maker;
      if (!key) return;
      if (e.target.checked) f.makers.add(key);
      else f.makers.delete(key);
    }),
  );
  $('#maker-filter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-maker-more], [data-maker-less], [data-maker-clear]');
    if (!b) return;
    if ('makerClear' in b.dataset) f.makers.clear();
    else state.makersExpanded = 'makerMore' in b.dataset;
    state.limit = PAGE;
    render();
  });
  $('#store-filter').addEventListener(
    'change',
    onChange((e) => {
      const id = e.target.dataset.store;
      if (!id) return;
      if (e.target.checked) f.hiddenStores.delete(id);
      else f.hiddenStores.add(id);
    }),
  );

  $('#groups').addEventListener('click', (e) => {
    const cartKey = e.target.closest('[data-cart]')?.dataset.cart;
    const watchKey = e.target.closest('[data-watch]')?.dataset.watch;
    const toggleKey = e.target.closest('.toggle-more')?.dataset.key;
    if (cartKey) {
      const g = state.groupsByKey.get(cartKey);
      if (g) addToCart(groupToItem(g));
    } else if (watchKey) {
      const g = state.groupsByKey.get(watchKey);
      if (g) openWatchDialog(groupToItem(g));
    } else if (toggleKey) {
      if (state.expanded.has(toggleKey)) state.expanded.delete(toggleKey);
      else state.expanded.add(toggleKey);
      render();
    }
  });
  $('#highlights').addEventListener('click', (e) => {
    const key = e.target.closest('[data-jump]')?.dataset.jump;
    const el = key && document.getElementById(`g-${key}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  });
  $('#more').addEventListener('click', () => {
    state.limit += PAGE;
    render();
  });

  if (matchMedia('(max-width: 860px)').matches) $('#filters-details').open = false;
}

async function init() {
  hydrateIcons();
  bind();
  initPanel();
  renderRecent();
  const savedCep = storage(() => localStorage.getItem(CEP_KEY), null);
  if (savedCep) $('#cep').value = fmtCep(savedCep);
  const near = loadNear();
  state.radius = near.radius;
  if (near.on) {
    Object.assign(state, { nearOn: true, geo: near.geo });
    state.filters.shipMode = 'store';
  }
  syncShipControls();
  // atualiza a localização salva sem perguntar de novo (só se já houver permissão)
  if (near.on && near.geo) {
    navigator.permissions
      ?.query({ name: 'geolocation' })
      .then((p) => p.state === 'granted' && requestLocation().then((geo) => setNear(true, { geo })))
      .catch(() => {});
  }
  try {
    state.stores = await (await fetch('/api/stores')).json();
  } catch {
    state.stores = [];
    toast('Não foi possível falar com o servidor.');
  }
  state.storeById = Object.fromEntries(state.stores.map((s) => [s.id, s]));
  initCart(state.storeById);
  initWatch(state.storeById);
  initDeals(state.storeById);

  const params = new URLSearchParams(location.search);
  const q = params.get('q');
  // ?cep= na URL é aceito só para pré-preencher (e é removido em seguida)
  const urlCep = cleanCep(params.get('cep'));
  if (urlCep) {
    $('#cep').value = fmtCep(urlCep);
    storage(() => localStorage.setItem(CEP_KEY, urlCep));
    const u = new URL(location.href);
    u.searchParams.delete('cep');
    history.replaceState(null, '', u);
  }
  if (q) {
    $('#q').value = q;
    search(q);
  } else {
    // página inicial: Superofertas (#busca abre direto a busca; #ofertas segue valendo)
    showView(location.hash === '#busca' ? 'search' : 'deals');
  }
}

init();

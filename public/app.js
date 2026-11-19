// Pechinchilina — frontend
const $ = (sel) => document.querySelector(sel);
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const PAGE = 30;
const OFFERS_VISIBLE = 4;
const RECENT_KEY = 'pechinchilina:recent';
const CEP_KEY = 'pechinchilina:cep';
// frete acima disso (ex.: R$ 1.000 em 30 dias) conta como "não atende na prática"
const MAX_FREIGHT = 100;

const state = {
  stores: [],
  storeById: {},
  status: {},
  offers: [],
  history: {},
  query: '',
  cep: null, // CEP usado na busca atual
  shipping: {}, // storeId -> skuId -> resultado da simulação
  source: null,
  limit: PAGE,
  expanded: new Set(),
  filters: {
    type: '', dosage: '', pkg: '', promoOnly: false, multiStore: false, loose: false, usePromos: true, sort: 'unit',
    hiddenStores: new Set(), shipMode: 'delivery', hideUndeliverable: true,
  },
};

// ---------- utilidades ----------
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function safeUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}
function fmtUnit(v, unit) {
  if (v == null) return '';
  const digits = v < 0.1 ? 3 : 2;
  return `${v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: digits, maximumFractionDigits: digits })}/${unit}`;
}
function fmtDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y.slice(2)}`;
}
// "3bd" -> "3 dias úteis", "60m" -> "60 min", "2h" -> "2 h", "1d" -> "1 dia"
function fmtEta(est) {
  const m = String(est || '').match(/^(\d+)(bd|d|h|m)$/);
  if (!m) return '';
  const n = Number(m[1]);
  if (m[2] === 'bd') return `${n} ${n === 1 ? 'dia útil' : 'dias úteis'}`;
  if (m[2] === 'd') return `${n} ${n === 1 ? 'dia' : 'dias'}`;
  if (m[2] === 'h') return `${n} h`;
  return `${n} min`;
}
function fmtCep(c) {
  return c ? `${c.slice(0, 5)}-${c.slice(5)}` : '';
}
function cleanCep(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length === 8 ? d : null;
}
function normalize(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}
function storage(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
const pkgLabel = (q) => (q ? `${q.qty.toLocaleString('pt-BR')} ${q.unit}` : '');
const effPrice = (o) => (state.filters.usePromos ? o.bestPrice : Math.min(o.price, o.spotPrice ?? Infinity));

// ---------- entrega ----------
const shipOf = (o) => state.shipping[o.storeId]?.[o.skuId];

// 0 = sem CEP ou retirada grátis; número = frete; null = ainda verificando
// ou não deu para verificar; Infinity = não atende o CEP
function freightOf(o) {
  if (!state.cep) return 0;
  const s = shipOf(o);
  if (!s || s.ok == null) return null;
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
    g.offers.sort((a, b) => costOf(a) - costOf(b) || a.price - b.price);
    const withDose = g.offers.filter((o) => o.dosage);
    const named = (withDose.length ? withDose : g.offers).slice().sort((a, b) => a.name.length - b.name.length);
    g.name = named[0].name;
    g.image = g.offers.find((o) => o.image)?.image;
    g.dosage = withDose[0]?.dosage || null;
    g.quantity = g.offers.find((o) => o.quantity)?.quantity || null;
    g.type = g.offers.find((o) => o.type)?.type || null;
    g.brand = g.offers.find((o) => o.brand)?.brand || null;
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
    groups.push(g);
  }
  return groups;
}

function applyGroupFilters(groups) {
  const f = state.filters;
  return groups.filter(
    (g) =>
      (!f.type || g.type === f.type) &&
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
};

// ---------- renderização ----------
function storeShipSummary(storeId) {
  const results = state.shipping[storeId];
  if (!results) return null;
  const list = Object.values(results).filter((r) => r.ok != null);
  if (!list.length) return null;
  const ok = list.filter(
    (r) => r.ok && ((r.delivery && r.delivery.price <= MAX_FREIGHT) || (state.filters.shipMode === 'any' && r.pickup)),
  );
  return { ok: ok.length, total: list.length };
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
        if (!state.shipping[s.id]) {
          info += ' · verificando CEP…';
        } else if (sum && sum.ok === 0) {
          info += ' · não atende seu CEP';
          cls += ' no-ship';
        } else if (sum) {
          info += sum.ok === sum.total ? ' · entrega ✓' : ` · entrega ${sum.ok}/${sum.total}`;
          title += ` — atende ${sum.ok} de ${sum.total} produtos no CEP ${fmtCep(state.cep)}`;
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
  $('#cep-label').textContent = state.cep ? fmtCep(state.cep) : '';
}

function promoHtml(p) {
  // se o texto já diz o preço ("pague R$ 7,99 cada"), não repete
  const unit =
    p.unitPrice == null || /R\$/.test(p.label) ? '' : ` → <b>${brl.format(p.unitPrice)}</b> cada levando ${p.minQty}`;
  return `<span class="promo">${esc(p.label)}${unit}</span>`;
}

function shipHtml(o) {
  const s = shipOf(o);
  if (!s) {
    return state.shipping[o.storeId]
      ? '<span class="ship pending">não verificado</span>'
      : '<span class="ship pending">verificando…</span>';
  }
  if (s.ok == null) return '<span class="ship pending" title="' + esc(s.error || '') + '">não foi possível verificar</span>';
  if (!s.ok) return `<span class="ship no" title="${esc(s.reason || '')}">Não atende seu CEP</span>`;

  const parts = [];
  if (s.delivery && s.delivery.price > MAX_FREIGHT) {
    parts.push(
      `<span class="no">Frete ${brl.format(s.delivery.price)}</span> · ${esc(fmtEta(s.delivery.estimate))}<span class="sub">inviável — tratado como “não atende”</span>`,
    );
  } else if (s.delivery) {
    const fee = s.delivery.price > 0 ? `<span class="fee">Frete ${brl.format(s.delivery.price)}</span>` : '<span class="free">Frete grátis</span>';
    parts.push(`${fee} · ${esc(fmtEta(s.delivery.estimate))}`);
    if (s.fastest) parts.push(`<span class="sub">ou ${brl.format(s.fastest.price)} em ${esc(fmtEta(s.fastest.estimate))}</span>`);
  } else {
    parts.push('<span class="no">Sem entrega em casa</span>');
  }
  if (s.pickup) {
    const km = s.pickup.distanceKm != null ? ` · ${s.pickup.distanceKm.toLocaleString('pt-BR')} km` : '';
    const where = s.pickup.nearest ? ` title="${esc(`Mais próxima: ${s.pickup.nearest}`)}"` : '';
    parts.push(`<span class="sub"${where}><span class="free">Retirada grátis</span> em ${esc(fmtEta(s.pickup.estimate))}${km}</span>`);
  }
  if (s.price != null && Math.abs(s.price - o.price) >= 0.01) {
    parts.push(`<span class="sub">Preço no seu CEP: <b>${brl.format(s.price)}</b></span>`);
  }
  return `<span class="ship">${parts.join('')}</span>`;
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
    <td class="c-store"><span class="store"><i style="background:${esc(store?.color || '#999')}"></i><span>${esc(o.storeName)}${o.sellerName ? `<span class="seller">vendido por ${esc(o.sellerName)}</span>` : ''}</span></span></td>
    <td class="c-price"><span class="price">${brl.format(o.price)}</span>${old || off ? `<span class="was">${old}${off}</span>` : ''}</td>
    <td class="c-promo">${promos}</td>
    ${state.cep ? `<td class="c-ship">${shipHtml(o)}</td>` : ''}
    <td class="c-unit num">${unit}</td>
    <td class="c-link">${url ? `<a class="go" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Ver na loja ↗</a>` : ''}</td>
  </tr>`;
}

function freightLine(g) {
  if (!state.cep) return '';
  if (g.freight == null) return '<div class="freight">verificando frete…</div>';
  if (g.freight === Infinity) return '<div class="freight">nenhuma farmácia atende seu CEP</div>';
  if (g.freight === 0) return `<div class="freight">sem frete (retirada) · total <b>${brl.format(g.total)}</b></div>`;
  return `<div class="freight">+ frete ${brl.format(g.freight)} = <b>${brl.format(g.total)}</b></div>`;
}

function groupHtml(g) {
  const tags = [
    g.type ? `<span class="tag ${g.type === 'Genérico' ? 'generic' : ''}">${esc(g.type)}</span>` : '',
    g.brand ? `<span class="tag">${esc(g.brand)}</span>` : '',
    g.dosage ? `<span class="tag">${esc(g.dosage)}</span>` : '',
    g.quantity ? `<span class="tag">${esc(pkgLabel(g.quantity))}</span>` : '',
    `<span class="tag">${g.offers.length} ${g.offers.length === 1 ? 'farmácia' : 'farmácias'}</span>`,
  ].join('');

  const img = safeUrl(g.image);
  const imgHtml = img
    ? `<img class="g-img" src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : '<div class="g-img ph">💊</div>';

  const best = g.best;
  const viaPromo = g.min < best.price - 0.005;
  const save =
    g.offers.length > 1 && g.savings >= 0.01 && !g.noDelivery
      ? `<span class="save">Economize ${brl.format(g.savings)} (${Math.round((g.savings / g.max) * 100)}%)</span>`
      : '';
  const unitLabel = g.unit != null && !g.noDelivery ? `<div class="unit">${fmtUnit(g.unit, g.quantity.unit)}${state.cep ? ' c/ frete' : ''}</div>` : '';

  const expanded = state.expanded.has(g.key);
  const visible = expanded ? g.offers : g.offers.slice(0, OFFERS_VISIBLE);
  const hiddenCount = g.offers.length - visible.length;

  return `<article class="group" id="g-${esc(g.key)}">
    <div class="g-head">
      ${imgHtml}
      <div>
        <h3 class="g-title">${esc(g.name)}</h3>
        <div class="tags">${tags}</div>
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
      <thead><tr><th class="w-store">Farmácia</th><th class="w-price">Preço</th><th>Promoções</th>${state.cep ? `<th class="w-ship">Entrega (${esc(fmtCep(state.cep))})</th>` : ''}<th class="w-unit">Por unidade</th><th class="w-link"></th></tr></thead>
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
  const withFreight = state.cep ? ' (com frete)' : '';
  const cards = [];
  const cheapest = pickMin(usable, (g) => g.total);
  cards.push({ k: `Menor preço${withFreight}`, v: brl.format(cheapest.total), d: `${cheapest.name} · ${cheapest.best.storeName}`, key: cheapest.key });

  const withUnit = usable.filter((g) => g.unit != null);
  if (withUnit.length) {
    const u = pickMin(withUnit, (g) => g.unit);
    cards.push({ k: `Menor preço por unidade${withFreight}`, v: fmtUnit(u.unit, u.quantity.unit), d: `${u.name} · ${u.best.storeName}`, key: u.key });
  }

  const multi = usable.filter((g) => g.offers.length > 1);
  if (multi.length) {
    const s = pickMin(multi, (g) => -g.savings);
    const worst = s.offers.filter((o) => freightOf(o) !== Infinity).at(-1);
    if (s.savings >= 0.5 && worst)
      cards.push({ k: 'Maior diferença entre lojas', v: brl.format(s.savings), d: `${s.name} · ${s.best.storeName} vs ${worst.storeName}`, key: s.key });
  }

  $('#highlights').innerHTML = cards
    .map((c) => `<button type="button" class="hl" data-jump="${esc(c.key)}"><div class="k">${esc(c.k)}</div><div class="v">${esc(c.v)}</div><div class="d">${esc(c.d)}</div></button>`)
    .join('');
}

let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const all = buildGroups();
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
    else if (groups.length && checkingCep) summary += ` — verificando entrega no CEP ${fmtCep(state.cep)}…`;
    if (hiddenByCep) summary += ` · ofertas que não atendem seu CEP ocultas`;
    $('#summary').textContent = summary;

    $('#groups').innerHTML = groups.slice(0, state.limit).map(groupHtml).join('');
    $('#more').hidden = groups.length <= state.limit;
    $('#results-area').hidden = false;
    $('#empty-state').hidden = true;
  });
}

// ---------- busca ----------
function search(query, { fresh = false } = {}) {
  query = query.trim();
  if (query.length < 2) return;
  const cepInput = $('#cep');
  const cep = cleanCep(cepInput.value);
  if (cepInput.value.trim() && !cep) {
    cepInput.classList.add('invalid');
    cepInput.focus();
    return;
  }
  cepInput.classList.remove('invalid');
  storage(() => (cep ? localStorage.setItem(CEP_KEY, cep) : localStorage.removeItem(CEP_KEY)));

  state.source?.close();
  Object.assign(state, { query, cep, offers: [], shipping: {}, history: {}, limit: PAGE, expanded: new Set(), status: {} });
  Object.assign(state.filters, { type: '', dosage: '', pkg: '' });
  for (const s of state.stores) state.status[s.id] = { state: 'loading' };
  renderStatus();
  render();
  saveRecent(query);
  // o CEP fica fora da URL para não vazar ao compartilhar o link
  const u = new URL(location.href);
  u.searchParams.set('q', query);
  history.replaceState(null, '', u);
  document.title = `${query} — Pechinchilina`;

  const params = new URLSearchParams({ q: query });
  if (cep) params.set('cep', cep);
  if (fresh) params.set('fresh', '1');
  const es = new EventSource(`/api/search?${params}`);
  state.source = es;

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

  // máscara 00000-000
  $('#cep').addEventListener('input', (e) => {
    const d = e.target.value.replace(/\D/g, '').slice(0, 8);
    e.target.value = d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
    e.target.classList.remove('invalid');
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
    f.shipMode = e.target.value;
    state.limit = PAGE;
    renderStatus();
    render();
  });
  $('#hide-undeliverable').addEventListener('change', onChange((e) => (f.hideUndeliverable = e.target.checked)));
  $('#type-chips').addEventListener(
    'click',
    onChange((e) => {
      const b = e.target.closest('[data-type]');
      if (b) f.type = b.dataset.type;
    }),
  );
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
    const key = e.target.closest('.toggle-more')?.dataset.key;
    if (!key) return;
    if (state.expanded.has(key)) state.expanded.delete(key);
    else state.expanded.add(key);
    render();
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
  bind();
  renderRecent();
  const savedCep = storage(() => localStorage.getItem(CEP_KEY), null);
  if (savedCep) $('#cep').value = fmtCep(savedCep);
  try {
    state.stores = await (await fetch('/api/stores')).json();
  } catch {
    state.stores = [];
  }
  state.storeById = Object.fromEntries(state.stores.map((s) => [s.id, s]));
  $('#store-count').textContent = String(state.stores.length);

  const params = new URLSearchParams(location.search);
  const q = params.get('q');
  // ?cep= na URL é aceito só para pré-preencher (e é removido em seguida)
  const urlCep = cleanCep(params.get('cep'));
  if (urlCep) {
    $('#cep').value = fmtCep(urlCep);
    const u = new URL(location.href);
    u.searchParams.delete('cep');
    history.replaceState(null, '', u);
  }
  if (q) {
    $('#q').value = q;
    search(q);
  }
}

init();

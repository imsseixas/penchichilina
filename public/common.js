// Utilitários compartilhados pelos módulos do frontend
export const $ = (sel) => document.querySelector(sel);
export const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const bus = new EventTarget(); // eventos entre módulos: 'cart-changed', 'watch-changed'
export const MAX_FREIGHT = 100; // frete acima disso conta como "não atende na prática"

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
export function safeUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}
export function fmtUnit(v, unit) {
  if (v == null) return '';
  const digits = v < 0.1 ? 3 : 2;
  return `${v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: digits, maximumFractionDigits: digits })}/${unit}`;
}
export function fmtDate(iso) {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y.slice(2)}`;
}
export function fmtAgo(iso) {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  return `há ${Math.round(h / 24)} dia(s)`;
}
// "3bd" -> "3 dias úteis", "60m" -> "60 min", "2h" -> "2 h", "1d" -> "1 dia"
export function fmtEta(est) {
  const m = String(est || '').match(/^(\d+)(bd|d|h|m)$/);
  if (!m) return '';
  const n = Number(m[1]);
  if (m[2] === 'bd') return `${n} ${n === 1 ? 'dia útil' : 'dias úteis'}`;
  if (m[2] === 'd') return `${n} ${n === 1 ? 'dia' : 'dias'}`;
  if (m[2] === 'h') return `${n} h`;
  return `${n} min`;
}
export const fmtCep = (c) => (c ? `${c.slice(0, 5)}-${c.slice(5)}` : '');
export function cleanCep(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length === 8 ? d : null;
}
export const getCep = () => cleanCep($('#cep')?.value);
export function normalize(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}
export function storage(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
export const pkgLabel = (q) => (q ? `${q.qty.toLocaleString('pt-BR')} ${q.unit}` : '');

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

// ---------- painel lateral (carrinho / monitorados) ----------
export function openPanel(tab) {
  const panel = $('#side-panel');
  panel.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
  document.body.classList.add('panel-open');
  for (const t of ['cart', 'watch']) {
    $(`#tab-${t}`).hidden = t !== tab;
    document.querySelector(`[data-tab="${t}"]`).setAttribute('aria-selected', String(t === tab));
  }
  bus.dispatchEvent(new CustomEvent('panel-tab', { detail: tab }));
}
export function closePanel() {
  $('#side-panel').classList.remove('open');
  $('#side-panel').setAttribute('aria-hidden', 'true');
  document.body.classList.remove('panel-open');
}
export function initPanel() {
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => openPanel(b.dataset.tab)));
  document.querySelectorAll('[data-open]').forEach((b) =>
    b.addEventListener('click', () => {
      const tab = b.dataset.open;
      const isOpen = $('#side-panel').classList.contains('open') && !$(`#tab-${tab}`).hidden;
      if (isOpen) closePanel();
      else openPanel(tab);
    }),
  );
  $('#side-panel .sp-close').addEventListener('click', closePanel);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.querySelector('dialog[open]')) closePanel();
  });
}

let toastTimer;
export function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

export function promoHtml(p) {
  // se o texto já diz o preço ("pague R$ 7,99 cada"), não repete
  const unit =
    p.unitPrice == null || /R\$/.test(p.label) ? '' : ` → <b>${brl.format(p.unitPrice)}</b> cada levando ${p.minQty}`;
  return `<span class="promo">${esc(p.label)}${unit}</span>`;
}

// Resumo de entrega de uma simulação (mesmo formato do servidor)
export function shipHtml(s, price) {
  if (!s) return '<span class="ship pending">verificando…</span>';
  if (s.ok == null) return `<span class="ship pending" title="${esc(s.error || '')}">não foi possível verificar</span>`;
  if (!s.ok) return `<span class="ship no" title="${esc(s.reason || '')}">Não atende seu CEP</span>`;
  const parts = [];
  if (s.delivery && s.delivery.price > MAX_FREIGHT) {
    parts.push(`<span class="no">Frete ${brl.format(s.delivery.price)}</span> · ${esc(fmtEta(s.delivery.estimate))}<span class="sub">inviável — tratado como “não atende”</span>`);
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
  if (price != null && s.price != null && Math.abs(s.price - price) >= 0.01) {
    parts.push(`<span class="sub">Preço no seu CEP: <b>${brl.format(s.price)}</b></span>`);
  }
  return `<span class="ship">${parts.join('')}</span>`;
}

// Carrinho: guarda os produtos no navegador e pede ao servidor o melhor lugar
// para comprar tudo (uma farmácia só ou dividido em duas), com frete do CEP.
import { $, api, brl, bus, esc, fmtCep, fmtEta, getCep, openPanel, safeUrl, storage, toast } from './common.js';

const KEY = 'pechinchilina:cart';
const MAX_ITEMS = 15;
let items = load();
let storeById = {};
let result = null; // última otimização
let stale = false;
let calculating = false;
let mode = 'delivery';

function load() {
  return storage(() => JSON.parse(localStorage.getItem(KEY)) || [], []);
}
function save() {
  storage(() => localStorage.setItem(KEY, JSON.stringify(items)));
  if (result) stale = true;
  renderBadge();
  render();
  bus.dispatchEvent(new Event('cart-changed'));
}

export function addToCart(item) {
  const existing = items.find((i) => i.key === item.key);
  if (existing) {
    existing.qty = Math.min(existing.qty + 1, 20);
    toast(`Mais 1 unidade: ${existing.qty}× ${item.name}`);
  } else {
    if (items.length >= MAX_ITEMS) return toast(`O carrinho aceita até ${MAX_ITEMS} produtos.`);
    items.push({ key: item.key, ean: item.ean || null, name: item.name, image: item.image || null, qty: 1, offers: item.offers || [] });
    toast('Adicionado ao carrinho');
  }
  save();
  openPanel('cart');
}

function renderBadge() {
  const n = items.reduce((s, i) => s + i.qty, 0);
  for (const el of document.querySelectorAll('.cart-badge')) {
    el.textContent = n ? String(n) : '';
    el.hidden = !n;
  }
}

function linesHtml(lines, itemsByKey) {
  return `<ul class="cr-lines">${lines
    .map((l) => {
      const it = itemsByKey[l.key];
      const url = safeUrl(l.url);
      const name = `${it?.qty || 1}× ${esc(it?.name || l.key)}`;
      const price = l.available ? brl.format(l.total) : '<span class="no">indisponível</span>';
      return `<li>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${name} ↗</a>` : name}<span>${price}</span></li>`;
    })
    .join('')}</ul>`;
}

function deliveryText(plan, s) {
  if (!result.cep) return 'sem frete (informe o CEP para calcular)';
  if (plan.via === 'pickup') return 'retirada grátis na loja';
  return `frete ${brl.format(plan.freight)} · ${esc(fmtEta(s.freight?.estimate))}`;
}

function resultHtml() {
  if (calculating) return '<p class="muted">Calculando nas farmácias… (simulando o carrinho em cada uma)</p>';
  if (!result) return '';
  const itemsByKey = Object.fromEntries(items.map((i) => [i.key, i]));
  const storesById = Object.fromEntries(result.stores.map((s) => [s.storeId, s]));
  let html = stale ? '<p class="warn">O carrinho ou o CEP mudou — recalcule.</p>' : '';

  const best = result.singles[0];
  if (best) {
    const s = storesById[best.storeId];
    html += `<div class="cr-card best">
      <div class="cr-k">Melhor numa farmácia só</div>
      <div class="cr-v">${brl.format(best.total)} <small>na ${esc(s.storeName)}</small></div>
      <div class="cr-d">itens ${brl.format(s.subtotal)} · ${deliveryText(best, s)}</div>
      ${linesHtml(s.lines, itemsByKey)}
    </div>`;
  } else {
    html += `<div class="cr-card"><div class="cr-k">Nenhuma farmácia tem tudo${result.cep ? ' e entrega no seu CEP' : ''}</div></div>`;
  }

  if (result.split) {
    html += `<div class="cr-card split">
      <div class="cr-k">Dividindo em 2 farmácias</div>
      <div class="cr-v">${brl.format(result.split.total)}${result.savingsVsSingle ? ` <small class="good">economiza ${brl.format(result.savingsVsSingle)}</small>` : ''}</div>
      ${result.split.parts
        .map(
          (p) => `<div class="cr-part"><b>${esc(p.storeName)}</b> — ${brl.format(p.plan.total)}
            <div class="cr-d">itens ${brl.format(p.subtotal)} · ${deliveryText(p.plan, p)}</div>
            ${linesHtml(p.lines, itemsByKey)}</div>`,
        )
        .join('')}
      <p class="hint">São 2 pedidos separados${result.cep ? ', cada um com seu frete e prazo' : ''}.</p>
    </div>`;
  }

  // tabela com todas as farmácias
  const rows = result.stores
    .map((s) => {
      const plan = result.singles.find((x) => x.storeId === s.storeId);
      const have = s.lines.filter((l) => l.available).length;
      let status;
      if (s.error) status = '<span class="no">erro</span>';
      else if (plan) status = `<b>${brl.format(plan.total)}</b>`;
      else if (have < items.length) status = `<span class="muted">tem ${have}/${items.length}</span>`;
      else status = '<span class="no">não atende o CEP</span>';
      return { s, plan, html: `<tr><td>${esc(s.storeName)}</td><td class="num">${status}</td></tr>` };
    })
    .sort((a, b) => (a.plan?.total ?? Infinity) - (b.plan?.total ?? Infinity));
  html += `<details class="cr-all"><summary>Todas as farmácias</summary><table>${rows.map((r) => r.html).join('')}</table></details>`;
  html += '<p class="hint">Promoções de quantidade (ex.: leve 3 pague 2) já aplicadas pela própria loja. Os links abrem cada produto para você montar o carrinho no site da farmácia.</p>';
  return html;
}

function render() {
  const el = $('#tab-cart');
  if (!items.length) {
    el.innerHTML = '<div class="sp-empty"><p><b>Seu carrinho está vazio.</b></p><p class="muted">Use “🛒 Adicionar” nos resultados ou nas Superofertas. Depois calculamos onde sai mais barato comprar tudo, com frete.</p></div>';
    return;
  }
  const cep = getCep();
  el.innerHTML = `
    <ul class="cart-items">${items
      .map((i) => {
        const img = safeUrl(i.image);
        return `<li class="ci" data-key="${esc(i.key)}">
          ${img ? `<img src="${esc(img)}" alt="" referrerpolicy="no-referrer" loading="lazy">` : '<span class="ci-ph">💊</span>'}
          <span class="ci-name">${esc(i.name)}</span>
          <span class="qty"><button type="button" data-dec aria-label="Diminuir">−</button><span>${i.qty}</span><button type="button" data-inc aria-label="Aumentar">+</button></span>
          <button type="button" class="ci-rm" data-rm aria-label="Remover">×</button>
        </li>`;
      })
      .join('')}</ul>
    <div class="cart-opts">
      <div class="muted">${cep ? `Entrega no CEP <b>${esc(fmtCep(cep))}</b>` : 'Informe o CEP no topo para incluir o frete.'}</div>
      ${cep ? `<select id="cart-mode" aria-label="Como receber"><option value="delivery"${mode === 'delivery' ? ' selected' : ''}>Receber em casa</option><option value="any"${mode === 'any' ? ' selected' : ''}>Em casa ou retirar na loja</option></select>` : ''}
      <button type="button" class="btn-primary block" id="cart-calc"${calculating ? ' disabled' : ''}>${calculating ? 'Calculando…' : 'Calcular onde comprar'}</button>
      <button type="button" class="link-btn" id="cart-clear">Esvaziar carrinho</button>
    </div>
    <div id="cart-result">${resultHtml()}</div>`;
}

async function calculate() {
  if (!items.length || calculating) return;
  calculating = true;
  render();
  try {
    result = await api('/api/cart/optimize', {
      method: 'POST',
      body: {
        cep: getCep(),
        mode,
        items: items.map(({ key, ean, name, qty, offers }) => ({ key, ean, name, qty, offers })),
      },
    });
    stale = false;
  } catch (err) {
    toast(`Não foi possível calcular: ${err.message}`);
  } finally {
    calculating = false;
    render();
  }
}

export function initCart(stores) {
  storeById = stores;
  renderBadge();
  render();
  const el = $('#tab-cart');
  el.addEventListener('click', (e) => {
    const li = e.target.closest('.ci');
    const item = li && items.find((i) => i.key === li.dataset.key);
    if (item && e.target.closest('[data-inc]')) {
      item.qty = Math.min(item.qty + 1, 20);
      save();
    } else if (item && e.target.closest('[data-dec]')) {
      item.qty = Math.max(item.qty - 1, 1);
      save();
    } else if (item && e.target.closest('[data-rm]')) {
      items = items.filter((i) => i !== item);
      save();
    } else if (e.target.closest('#cart-calc')) {
      calculate();
    } else if (e.target.closest('#cart-clear')) {
      items = [];
      result = null;
      save();
    }
  });
  el.addEventListener('change', (e) => {
    if (e.target.id === 'cart-mode') {
      mode = e.target.value;
      if (result) stale = true;
      render();
    }
  });
  bus.addEventListener('cep-changed', () => {
    if (result) stale = true;
    render();
  });
}

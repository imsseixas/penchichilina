// Monitorados: produtos que o servidor verifica periodicamente, com alertas
// de superoferta (alvo atingido, menor preço já visto, queda forte).
import { $, api, brl, esc, fmtAgo, fmtCep, getCep, openPanel, safeUrl, storage, toast } from './common.js';

const SEEN_KEY = 'pechinchilina:alerts-seen';
const POLL_MS = 2 * 60 * 1000;
let storeById = {};
let watches = [];
let alerts = [];
let checking = false;
let config = { phoneNotifications: false };
let pending = null; // item sendo adicionado no diálogo

function unread() {
  return alerts.filter((a) => !a.read);
}

function renderBadge() {
  const n = unread().length;
  for (const el of document.querySelectorAll('.alert-badge')) {
    el.textContent = n ? String(n) : '';
    el.hidden = !n;
  }
}

function render() {
  const el = $('#tab-watch');
  const intro = `<p class="muted">Verificamos os produtos monitorados a cada 6 horas em todas as farmácias e avisamos quando o preço atinge seu alvo, bate o menor valor já visto ou cai 10% ou mais.</p>`;
  const phone = config.phoneNotifications
    ? '<p class="hint">📱 Notificações no celular ativadas (ntfy).</p>'
    : '<p class="hint">📱 Quer receber no celular? Instale o app <b>ntfy</b>, assine um tópico secreto e inicie o servidor com <code>NTFY_TOPIC=seu-topico</code>.</p>';

  const alertsHtml = alerts.length
    ? `<div class="w-alerts">
        <div class="w-row"><b>Alertas</b>${unread().length ? '<button type="button" class="link-btn" id="alerts-read">marcar como lidos</button>' : ''}</div>
        <ul>${alerts
          .slice(0, 20)
          .map((a) => {
            const url = safeUrl(a.url);
            return `<li class="${a.read ? '' : 'unread'}"><span class="w-when">${esc(fmtAgo(a.at))}</span> ${esc(a.message)}${url ? ` <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Ver ↗</a>` : ''}</li>`;
          })
          .join('')}</ul>
      </div>`
    : '';

  const list = watches.length
    ? `<ul class="w-items">${watches
        .map((w) => {
          const img = safeUrl(w.image);
          const best = w.last?.best;
          const now = best
            ? `Agora: <b>${brl.format(best.total)}</b> na ${esc(best.storeName)}${best.freight ? ` (frete ${brl.format(best.freight)})` : ''}`
            : w.last
              ? '<span class="no">Nenhuma farmácia disponível agora</span>'
              : '<span class="muted">aguardando 1ª verificação…</span>';
          const low = w.low ? ` · menor visto ${brl.format(w.low.total)}` : '';
          const reached = best && w.target != null && best.total <= w.target ? ' <span class="good">✓ alvo atingido</span>' : '';
          return `<li class="w-item" data-id="${esc(w.id)}">
            ${img ? `<img src="${esc(img)}" alt="" referrerpolicy="no-referrer" loading="lazy">` : '<span class="ci-ph">💊</span>'}
            <div>
              <div class="ci-name">${esc(w.name)}</div>
              <div class="w-meta">${w.target != null ? `Alvo: ${brl.format(w.target)}` : 'Sem alvo'}${w.cep ? ` · CEP ${esc(fmtCep(w.cep))}` : ''}${reached}</div>
              <div class="w-meta">${now}${low}</div>
              ${w.last ? `<div class="w-meta muted">verificado ${esc(fmtAgo(w.last.at))}</div>` : ''}
              <div class="w-actions"><button type="button" class="link-btn" data-search="${esc(w.name)}">ver preços</button><button type="button" class="link-btn danger" data-remove>parar de monitorar</button></div>
            </div>
          </li>`;
        })
        .join('')}</ul>
      <button type="button" class="btn-secondary block" id="watch-check"${checking ? ' disabled' : ''}>${checking ? 'Verificando…' : 'Verificar agora'}</button>`
    : '<div class="sp-empty"><p><b>Nenhum produto monitorado.</b></p><p class="muted">Use “🔔 Monitorar” num produto da busca ou das Superofertas.</p></div>';

  el.innerHTML = alertsHtml + list + intro + phone;
}

async function refresh() {
  try {
    const [w, a] = await Promise.all([api('/api/watch'), api('/api/alerts')]);
    watches = w.items;
    checking = w.checking;
    notifyNew(a);
    alerts = a;
  } catch {
    /* servidor fora do ar: tenta de novo no próximo ciclo */
  }
  renderBadge();
  render();
}

// notificação do navegador para alertas que ainda não vimos
function notifyNew(list) {
  const seen = new Set(storage(() => JSON.parse(localStorage.getItem(SEEN_KEY)) || [], []));
  const fresh = list.filter((a) => !a.read && !seen.has(a.id));
  if (fresh.length && 'Notification' in window && Notification.permission === 'granted') {
    for (const a of fresh.slice(0, 3)) {
      const n = new Notification('Pechinchilina: superoferta!', { body: a.message, tag: a.id });
      n.onclick = () => {
        window.focus();
        openPanel('watch');
      };
    }
  }
  storage(() => localStorage.setItem(SEEN_KEY, JSON.stringify(list.map((a) => a.id).slice(0, 300))));
}

export function openWatchDialog(item) {
  pending = item;
  const dlg = $('#watch-dialog');
  $('#wd-name').textContent = item.name;
  const best = Number(item.best);
  $('#wd-now').textContent = best > 0 ? `Melhor preço agora: ${brl.format(best)}` : '';
  $('#wd-target').value = '';
  $('#wd-target').placeholder = best > 0 ? (Math.floor(best * 0.85 * 100) / 100).toFixed(2).replace('.', ',') : 'ex.: 9,90';
  const cep = getCep();
  $('#wd-cep').textContent = cep ? `Preço com frete para o CEP ${fmtCep(cep)}.` : 'Sem CEP: compara só o preço do produto.';
  dlg.showModal();
}

async function submitWatch(e) {
  e.preventDefault();
  if (!pending) return;
  const raw = $('#wd-target').value.trim().replace(/\./g, '').replace(',', '.');
  const target = raw ? Number(raw) : null;
  if (raw && !(target > 0)) {
    $('#wd-target').focus();
    return toast('Preço-alvo inválido.');
  }
  // pedir permissão ainda dentro do clique (navegadores exigem gesto do usuário)
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  try {
    await api('/api/watch', {
      method: 'POST',
      body: { ean: pending.ean, name: pending.name, image: pending.image, target, cep: getCep() },
    });
    $('#watch-dialog').close();
    toast('Monitorando! Primeira verificação em andamento.');
    openPanel('watch');
    await refresh();
    setTimeout(refresh, 8000);
  } catch (err) {
    toast(err.message);
  }
}

export function initWatch(stores) {
  storeById = stores;
  api('/api/config').then((c) => (config = c)).catch(() => {}).finally(render);
  refresh();
  setInterval(refresh, POLL_MS);

  $('#watch-form').addEventListener('submit', submitWatch);
  $('#wd-cancel').addEventListener('click', () => $('#watch-dialog').close());

  $('#tab-watch').addEventListener('click', async (e) => {
    const li = e.target.closest('.w-item');
    if (e.target.closest('[data-remove]') && li) {
      await api(`/api/watch/${encodeURIComponent(li.dataset.id)}`, { method: 'DELETE', body: {} }).catch((err) => toast(err.message));
      refresh();
    } else if (e.target.closest('[data-search]')) {
      $('#q').value = e.target.closest('[data-search]').dataset.search;
      $('#search-form').requestSubmit();
    } else if (e.target.closest('#watch-check')) {
      checking = true;
      render();
      await api('/api/watch/check', { method: 'POST', body: {} }).catch((err) => toast(err.message));
      setTimeout(refresh, 6000);
      setTimeout(refresh, 20000);
    } else if (e.target.closest('#alerts-read')) {
      await api('/api/alerts/read', { method: 'POST', body: {} }).catch(() => {});
      refresh();
    }
  });
}

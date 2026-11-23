// "Perto de mim": localização do usuário, horário das lojas e link de mapa.
// A localização é arredondada (~100 m), fica só neste navegador e vai para as
// farmácias apenas para achar as lojas físicas próximas.
import { esc, fmtEta, storage } from './common.js';

const KEY = 'pechinchilina:near';
const round = (v) => Math.round(v * 1000) / 1000;

export function loadNear() {
  const n = storage(() => JSON.parse(localStorage.getItem(KEY)), null) || {};
  const geo = Number.isFinite(n.geo?.lat) && Number.isFinite(n.geo?.lng) ? { lat: n.geo.lat, lng: n.geo.lng } : null;
  return { on: Boolean(n.on), geo, radius: [1, 2, 3, 5, 10].includes(n.radius) ? n.radius : 3 };
}

export function saveNear({ on, geo, radius }) {
  storage(() => localStorage.setItem(KEY, JSON.stringify({ on, geo, radius })));
}

export function requestLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Seu navegador não informa a localização.'));
    if (!window.isSecureContext) return reject(new Error('A localização só funciona em https ou em localhost.'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: round(pos.coords.latitude), lng: round(pos.coords.longitude) }),
      (err) =>
        reject(
          new Error(
            err.code === err.PERMISSION_DENIED
              ? 'Você não permitiu o acesso à localização.'
              : 'Não foi possível descobrir sua localização agora.',
          ),
        ),
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 10 * 60 * 1000 },
    );
  });
}

// ---------- horário de funcionamento ----------
const DAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const toMin = (t) => {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const fmtTime = (t) => {
  const [h, m] = t.split(':');
  return `${Number(h)}h${m !== '00' ? m : ''}`;
};

// hours: [{ day: 0..6, open: '07:00', close: '22:00' }] -> { open: bool|null, text }
export function openState(hours, now = new Date()) {
  if (!Array.isArray(hours) || !hours.length) return { open: null, text: '' };
  const byDay = new Map(hours.map((h) => [h.day, h]));
  const today = byDay.get(now.getDay());
  const minutes = now.getHours() * 60 + now.getMinutes();
  // turno que começou ontem e passa da meia-noite
  const yesterday = byDay.get((now.getDay() + 6) % 7);
  if (yesterday) {
    const o = toMin(yesterday.open);
    const c = toMin(yesterday.close);
    if (o != null && c != null && c < o && minutes < c) return { open: true, text: `aberta até ${fmtTime(yesterday.close)}` };
  }
  if (today) {
    const o = toMin(today.open);
    const c = toMin(today.close);
    if (o != null && c != null) {
      if (o === 0 && c >= 23 * 60 + 59) return { open: true, text: 'aberta 24 h' };
      const overnight = c <= o;
      if (minutes >= o && (overnight || minutes < c)) return { open: true, text: `aberta até ${fmtTime(today.close)}` };
      if (minutes < o) return { open: false, text: `fechada · abre às ${fmtTime(today.open)}` };
    }
  }
  for (let i = 1; i <= 7; i++) {
    const d = byDay.get((now.getDay() + i) % 7);
    if (d && toMin(d.open) != null) {
      return { open: false, text: `fechada · abre ${i === 1 ? 'amanhã' : DAYS[d.day]} às ${fmtTime(d.open)}` };
    }
  }
  return { open: false, text: 'fechada' };
}

export const fmtKm = (km) => (km < 1 ? `${Math.round(km * 1000 / 10) * 10} m` : `${km.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} km`);

export function mapsUrl(p) {
  if (p.lat == null || p.lng == null) return null;
  return `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;
}

// Célula "loja perto" de uma oferta: point vem da simulação (tem o produto),
// hours vem da lista de lojas próximas (/api/nearby).
export function pointHtml(point, hours, { extra = 0 } = {}) {
  const st = openState(hours);
  const map = mapsUrl(point);
  const status = st.text ? `<span class="${st.open ? 'free' : 'closed'}">${esc(st.text)}</span> · ` : '';
  return `<span class="ship store-pt">
    <span class="pt-name">🏪 ${esc(point.name)}</span>
    <span class="sub"><b>${esc(fmtKm(point.distanceKm))}</b>${point.address ? ` · ${esc(point.address)}` : ''}</span>
    <span class="sub">${status}retire em ${esc(fmtEta(point.estimate) || '—')} comprando no site${map ? ` · <a href="${esc(map)}" target="_blank" rel="noopener noreferrer">mapa ↗</a>` : ''}</span>
    ${extra > 0 ? `<span class="sub muted">+ ${extra} ${extra === 1 ? 'outra loja' : 'outras lojas'} com estoque perto</span>` : ''}
  </span>`;
}

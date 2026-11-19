// Funções puras de normalização: extraem dosagem, quantidade, tipo de
// medicamento, relevância e o preço efetivo das promoções.

export function normalize(text = '') {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/(\d)\s+(mg|mcg|g|ml|ui)\b/g, '$1$2')
    .replace(/[^a-z0-9%.,/+ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'com', 'e', 'para', 'o', 'a', 'em']);

export function queryTokens(query) {
  return normalize(query)
    .split(' ')
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Todos os termos da busca precisam aparecer (como início de palavra) no
// nome, marca ou princípio ativo. Evita que "50mg" case com "150mg".
export function matchesQuery(tokens, haystack) {
  const h = ' ' + normalize(haystack);
  return tokens.every((t) => new RegExp('[^a-z0-9]' + escapeRe(t)).test(h));
}

const COUNT_UNITS =
  'comprimidos?|comp\\b|cpr|capsulas?|caps\\b|drageas?|unidades|und?\\b|saches?|envelopes?|ampolas?|adesivos?|pastilhas?|tabletes?|flaconetes?|seringas?|canetas?|doses|tiras|frascos?|gomas?|ovulos?|supositorios?';

const COUNT_LABEL = [
  [/^comp|^cpr|^tablete/, 'comp'],
  [/^caps/, 'cáps'],
  [/^drage/, 'drág'],
  [/^sache|^envelope/, 'sachê'],
  [/^ampola/, 'amp'],
  [/^adesivo/, 'adesivo'],
  [/^pastilha/, 'past'],
];

function countLabel(word) {
  for (const [re, label] of COUNT_LABEL) if (re.test(word)) return label;
  return 'un';
}

// Retorna { qty, unit } — ex.: { qty: 30, unit: 'comp' } ou { qty: 20, unit: 'ml' }
export function parseQuantity(name) {
  const n = normalize(name);
  let m = n.match(new RegExp(`(\\d+)\\s*(?:x\\s*)?(${COUNT_UNITS})`));
  if (m && !/^(mg|ml|g)/.test(m[2])) return { qty: Number(m[1]), unit: countLabel(m[2]) };

  m = n.match(/(?<![/\d.,])(\d+(?:[.,]\d+)?)ml\b/g);
  if (m) {
    const v = Number(m[m.length - 1].replace('ml', '').replace(',', '.'));
    if (v > 0) return { qty: v, unit: 'ml' };
  }

  m = n.match(/(?:c\/|com|cx)\s*(\d+)\b/);
  if (m) return { qty: Number(m[1]), unit: 'un' };

  m = n.match(/(?<![/\d.,])(\d+(?:[.,]\d+)?)g\b/g);
  if (m) {
    const v = Number(m[m.length - 1].replace('g', '').replace(',', '.'));
    if (v >= 5) return { qty: v, unit: 'g' };
  }
  return null;
}

// "600mg+70mg+100mg", "500mg/ml", "1g"
export function parseDosage(name) {
  const n = normalize(name);
  const re = /(\d+(?:[.,]\d+)?)(mg|mcg|ui|g|%)(?:\s*\/\s*(ml|g|dose|gota))?\b/g;
  const parts = [];
  for (const m of n.matchAll(re)) {
    const value = Number(m[1].replace(',', '.'));
    if (m[2] === 'g' && !m[3] && value > 2) continue; // 30g é quantidade de pomada, não dose
    parts.push(m[1].replace('.', ',') + m[2] + (m[3] ? '/' + m[3] : ''));
  }
  return parts.length ? [...new Set(parts)].join(' + ') : null;
}

export function detectType(name, props = []) {
  const prop = props.join(' ');
  const h = normalize(name + ' ' + prop);
  if (/\bgenerico/.test(h)) return 'Genérico';
  if (/\breferencia/.test(h)) return 'Referência';
  if (/\bsimilar/.test(h)) return 'Similar';
  return null;
}

function money(str) {
  // "7,99" | "7.99" | "1.234,56"
  const s = String(str).trim();
  if (/,\d{1,2}$/.test(s)) return Number(s.replace(/\./g, '').replace(',', '.'));
  return Number(s.replace(/,/g, ''));
}

// Converte o teaser da VTEX em algo legível e, quando possível, calcula o
// preço por unidade ao levar a quantidade mínima.
export function parsePromo(teaser, price) {
  const label = String(teaser.name || '').replace(/\s*-\s*\d{3,}\s*$/, '').trim();
  const minQty = Number(teaser.minQty) || 1;
  const effects = teaser.effects || {};
  const n = normalize(label);
  let unitPrice = null;

  const rs = label.match(/R\$\s*([\d.,]+)/i);
  if (rs) unitPrice = money(rs[1]);

  if (unitPrice == null && effects.MaximumUnitPriceDiscount) {
    unitPrice = Number(effects.MaximumUnitPriceDiscount) / 100;
  }

  if (unitPrice == null) {
    const lp = n.match(/leve\s*(\d+)\s*(?:e\s*)?pague\s*(\d+)\b/);
    if (lp && Number(lp[1]) > Number(lp[2])) unitPrice = (price * Number(lp[2])) / Number(lp[1]);
  }

  if (unitPrice == null) {
    const nth = n.match(/(\d+(?:[.,]\d+)?)\s*%\s*(?:off|de desconto)?\s*na\s*(\d+)/);
    if (nth) {
      const pct = Number(nth[1].replace(',', '.')) / 100;
      const k = Number(nth[2]);
      if (k >= 2 && pct > 0 && pct <= 1) unitPrice = (price * (k - pct)) / k;
    }
  }

  if (unitPrice != null && !(unitPrice > 0 && unitPrice < price - 0.005)) unitPrice = null;
  return {
    label: label || 'Promoção',
    minQty,
    unitPrice: unitPrice != null ? Math.round(unitPrice * 100) / 100 : null,
  };
}

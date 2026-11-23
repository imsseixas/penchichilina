import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreDeals } from '../src/deals.js';
import { summarizeCart, sameStoreUrl } from '../src/cart.js';

test('carrinho: só aceita links da própria loja', () => {
  const store = { base: 'https://www.drogariasaopaulo.com.br' };
  assert.equal(sameStoreUrl('https://www.drogariasaopaulo.com.br/x/p', store), 'https://www.drogariasaopaulo.com.br/x/p');
  assert.equal(sameStoreUrl('https://secure.consultaremedios.com.br/x/p', { base: 'https://consultaremedios.com.br' }), 'https://secure.consultaremedios.com.br/x/p');
  assert.equal(sameStoreUrl('https://evil.example/drogariasaopaulo.com.br', store), null);
  assert.equal(sameStoreUrl('javascript:alert(1)', store), null);
  assert.equal(sameStoreUrl(undefined, store), null);
});
import { alertsFor } from '../src/watch.js';

const offer = (storeId, price, extra = {}) => ({
  storeId, storeName: storeId, skuId: '1', ean: '789', name: 'Ômega 3 60 cáps', relevant: true,
  price, bestPrice: price, listPrice: price, promos: [], highlights: [], ...extra,
});

test('superofertas: desconto real contra a mediana das outras farmácias', () => {
  const entries = ['a', 'b', 'c', 'd'].map((s, i) => ({ category: 'suplementos', offer: offer(s, [16, 40, 42, 50][i]) }));
  const [deal] = scoreDeals(entries);
  assert.equal(deal.best.storeId, 'a');
  assert.equal(deal.refPrice, 42);
  assert.equal(deal.realDiscount, 62);
  assert.equal(deal.storesCount, 4);
});

test('superofertas: preço parecido entre lojas não é oferta, mesmo com "de/por" inflado', () => {
  const entries = ['a', 'b', 'c'].map((s, i) => ({ category: 'mip', offer: offer(s, [3.59, 3.79, 3.99][i], { listPrice: 22 }) }));
  assert.equal(scoreDeals(entries).length, 0);
});

test('superofertas: sem comparação, exige 40% no site da loja e pesa menos', () => {
  const strong = scoreDeals([{ category: 'beleza', offer: offer('a', 10, { ean: '1', listPrice: 25 }) }]);
  assert.equal(strong.length, 1);
  assert.equal(strong[0].realDiscount, null);
  assert.equal(strong[0].listDiscount, 60);
  assert.equal(strong[0].score, 0.3);
  assert.equal(scoreDeals([{ category: 'beleza', offer: offer('a', 10, { ean: '1', listPrice: 14 }) }]).length, 0);
});

test('carrinho: soma itens com promoção e frete único do pedido', () => {
  const data = {
    items: [
      { id: '196991', quantity: 2, availability: 'available', priceDefinition: { total: 718 } },
      { id: '196991', quantity: 1, availability: 'available', priceDefinition: { total: 0 } }, // leve 3 pague 2
      { id: '139033', quantity: 1, availability: 'available', priceDefinition: { total: 499 } },
    ],
    logisticsInfo: [
      { itemIndex: 0, slas: [{ name: 'NORMAL', deliveryChannel: 'delivery', price: 246, shippingEstimate: '5bd' }, { name: 'Loja', deliveryChannel: 'pickup-in-point', price: 0, shippingEstimate: '1h' }] },
      { itemIndex: 1, slas: [{ name: 'NORMAL', deliveryChannel: 'delivery', price: 122, shippingEstimate: '5bd' }, { name: 'Loja', deliveryChannel: 'pickup-in-point', price: 0, shippingEstimate: '1h' }] },
      { itemIndex: 2, slas: [{ name: 'NORMAL', deliveryChannel: 'delivery', price: 122, shippingEstimate: '5bd' }, { name: 'Loja', deliveryChannel: 'pickup-in-point', price: 0, shippingEstimate: '1h' }] },
    ],
  };
  const r = summarizeCart(data, [{ key: 'los', skuId: '196991' }, { key: 'dor', skuId: '139033' }]);
  assert.deepEqual(r.lines, [{ key: 'los', available: true, total: 7.18 }, { key: 'dor', available: true, total: 4.99 }]);
  assert.equal(r.subtotal, 12.17);
  assert.deepEqual(r.freight, { name: 'NORMAL', price: 4.9, estimate: '5bd' });
  assert.equal(r.pickup, true);
});

test('carrinho: item que não entrega fica indisponível', () => {
  const r = summarizeCart(
    { items: [{ id: '1', quantity: 1, availability: 'cannotBeDelivered', sellingPrice: 500 }], logisticsInfo: [{ itemIndex: 0, slas: [] }] },
    [{ key: 'x', skuId: '1' }],
  );
  assert.deepEqual(r.lines, [{ key: 'x', available: false, total: null }]);
  assert.equal(r.freight, null);
});

test('alertas: alvo, menor preço e queda forte', () => {
  const best = { total: 8, storeName: 'Pague Menos', freight: 0 };
  const item = { name: 'Losartana', target: 9, last: { best: { total: 12 } }, low: { total: 10 } };
  const kinds = alertsFor(item, best).map((a) => a.kind);
  assert.deepEqual(kinds, ['target', 'low']);
  // alvo já atingido na checagem anterior não repete
  assert.deepEqual(alertsFor({ ...item, last: { best: { total: 8.5 } }, low: { total: 7 } }, best).map((a) => a.kind), []);
  // queda de 10%+ sem ser recorde
  assert.deepEqual(alertsFor({ name: 'X', target: null, last: { best: { total: 10 } }, low: { total: 5 } }, { ...best, total: 8.9 }).map((a) => a.kind), ['drop']);
  // primeira checagem não gera alerta sem alvo
  assert.deepEqual(alertsFor({ name: 'X', target: null, last: null, low: null }, best), []);
});

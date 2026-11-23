import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanCep, estimateToMinutes, summarizeSimulation } from '../src/shipping.js';

test('CEP', () => {
  assert.equal(cleanCep('41760-150'), '41760150');
  assert.equal(cleanCep(' 41760150 '), '41760150');
  assert.equal(cleanCep('4176015'), null);
  assert.equal(cleanCep(''), null);
});

test('prazo', () => {
  assert.equal(estimateToMinutes('60m'), 60);
  assert.equal(estimateToMinutes('2h'), 120);
  assert.ok(estimateToMinutes('1d') < estimateToMinutes('3bd'));
  assert.equal(estimateToMinutes('???'), null);
});

const sla = (name, price, est, channel = 'delivery', extra = {}) => ({ name, price, shippingEstimate: est, deliveryChannel: channel, ...extra });

test('entrega: escolhe o frete mais barato e o mais rápido', () => {
  const r = summarizeSimulation({
    items: [{ id: '1', sellingPrice: 359 }],
    logisticsInfo: [{ slas: [sla('NORMAL', 230, '2bd'), sla('NORMAL 1', 163, '5bd'), sla('SUPER EXPRESSA', 264, '60m')] }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.price, 3.59);
  assert.deepEqual(r.delivery, { name: 'NORMAL 1', price: 1.63, estimate: '5bd' });
  assert.deepEqual(r.fastest, { name: 'SUPER EXPRESSA', price: 2.64, estimate: '60m' });
  assert.equal(r.pickup, null);
});

test('retirada na loja', () => {
  const r = summarizeSimulation({
    items: [{ id: '1', sellingPrice: 549 }],
    logisticsInfo: [{
      slas: [
        sla('Retire A', 0, '2h', 'pickup-in-point', { pickupDistance: 5.21, pickupStoreInfo: { friendlyName: 'Loja A' } }),
        sla('Retire B', 0, '60m', 'pickup-in-point', { pickupDistance: 1.04, pickupStoreInfo: { friendlyName: 'Loja B' } }),
      ],
    }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.delivery, null);
  const { points, ...summary } = r.pickup;
  assert.deepEqual(summary, { count: 2, estimate: '60m', nearest: 'Loja B', distanceKm: 1 });
  assert.deepEqual(points.map((p) => p.name), ['Loja B', 'Loja A']);
});

test('não entrega no CEP', () => {
  const r = summarizeSimulation({
    items: [{ id: '1', sellingPrice: 699, availability: 'cannotBeDelivered' }],
    logisticsInfo: [{ slas: [] }],
    messages: [{ text: 'O item X não pode ser entregue para as coordenadas selecionadas' }],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /não pode ser entregue/);
});

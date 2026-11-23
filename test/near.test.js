import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanGeo, haversineKm, summarizePoints } from '../src/nearby.js';
import { summarizeSimulation } from '../src/shipping.js';
import { openState } from '../public/near.js';

test('localização: arredonda a ~100 m e rejeita fora do Brasil', () => {
  assert.deepEqual(cleanGeo('-12.98123', '-38.45678'), { lat: -12.981, lng: -38.457 });
  assert.equal(cleanGeo('48.85', '2.35'), null);
  assert.equal(cleanGeo('abc', '-38'), null);
  assert.equal(cleanGeo(null, null), null);
});

test('lojas perto: distância medida da localização, nome e endereço limpos', () => {
  const data = {
    items: [
      { distance: 9, pickupPoint: { id: 'b', friendlyName: 'Loja B - ', isActive: true, address: { street: 'Rua X ', number: '10', neighborhood: 'Stiep', postalCode: '41770-095', geoCoordinates: [-38.46, -12.99] } } },
      { distance: 9, pickupPoint: { id: 'a', friendlyName: 'Pague Menos - Shopping, (Loja 995). ', isActive: true, address: { street: 'Av. Y', number: '2915', geoCoordinates: [-38.4501, -12.9801] }, businessHours: [{ DayOfWeek: 1, OpeningTime: '09:00:00', ClosingTime: '22:00:00' }] } },
      { distance: 1, pickupPoint: { id: 'c', friendlyName: 'Inativa', isActive: false, address: {} } },
    ],
  };
  const pts = summarizePoints(data, { lat: -12.98, lng: -38.45 });
  assert.deepEqual(pts.map((p) => p.id), ['a', 'b']);
  assert.equal(pts[0].name, 'Pague Menos - Shopping, (Loja 995)');
  assert.ok(pts[0].distanceKm < 0.05);
  assert.deepEqual(pts[0].hours, [{ day: 1, open: '09:00', close: '22:00' }]);
  assert.equal(pts[1].address, 'Rua X, 10 - Stiep');
  assert.equal(pts[1].postalCode, '41770095');
  assert.ok(Math.abs(haversineKm({ lat: -12.98, lng: -38.45 }, { lat: -12.99, lng: -38.46 }) - 1.53) < 0.05);
});

test('simulação: lista as lojas com estoque da mais perto para a mais longe', () => {
  const sla = (id, km, est) => ({
    name: id, deliveryChannel: 'pickup-in-point', price: 0, shippingEstimate: est, pickupPointId: id, pickupDistance: km,
    pickupStoreInfo: { friendlyName: `Filial ${id} -`, address: { street: 'Rua', number: '1', geoCoordinates: [-38.4, -12.9] } },
  });
  const s = summarizeSimulation({
    items: [{ id: '1', sellingPrice: 999 }],
    logisticsInfo: [{ slas: [sla('far', 2.5, '60m'), sla('near', 0.23, '30m')] }],
  });
  assert.equal(s.ok, true);
  assert.deepEqual(s.pickup.points.map((p) => [p.id, p.name, p.distanceKm, p.lat]), [['near', 'Filial near', 0.23, -12.9], ['far', 'Filial far', 2.5, -12.9]]);
});

test('horário: aberta, fechada, abre amanhã, madrugada', () => {
  const week = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '09:00', close: '22:00' }));
  const at = (d, h, m = 0) => new Date(2026, 10, 15 + d, h, m); // 15/11/2026 é domingo
  assert.deepEqual(openState(week, at(1, 10)), { open: true, text: 'aberta até 22h' });
  assert.deepEqual(openState(week, at(1, 7, 30)), { open: false, text: 'fechada · abre às 9h' });
  assert.deepEqual(openState(week, at(1, 23)), { open: false, text: 'fechada · abre amanhã às 9h' });
  const late = [{ day: 1, open: '18:00', close: '02:00' }];
  assert.equal(openState(late, at(2, 1)).open, true);
  assert.deepEqual(openState([{ day: 1, open: '00:00', close: '23:59' }], at(1, 3)), { open: true, text: 'aberta 24 h' });
  assert.deepEqual(openState(null), { open: null, text: '' });
});

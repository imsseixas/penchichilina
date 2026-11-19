import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesQuery, parseDosage, parsePromo, parseQuantity, queryTokens, detectType } from '../src/parse.js';

test('quantidade: comprimidos, ml e gramas', () => {
  assert.deepEqual(parseQuantity('Losartana Potássica 50mg Genérico EMS 30 Comprimidos'), { qty: 30, unit: 'comp' });
  assert.deepEqual(parseQuantity('Dorflex Max 600mg + 70mg + 100mg 16 Comprimidos'), { qty: 16, unit: 'comp' });
  assert.deepEqual(parseQuantity('Dipirona Monoidratada 500mg/ml Neo Química 20ml Gotas'), { qty: 20, unit: 'ml' });
  assert.deepEqual(parseQuantity('Omeprazol 20mg 28 Cápsulas'), { qty: 28, unit: 'cáps' });
  assert.deepEqual(parseQuantity('Bepantol Derma Creme 30g'), { qty: 30, unit: 'g' });
  assert.deepEqual(parseQuantity('Dorflex Max Dipirona 600mg - 4 Unidades'), { qty: 4, unit: 'un' });
  assert.deepEqual(parseQuantity('Dorflex Dip 1g 10 Comprimidos'), { qty: 10, unit: 'comp' });
});

test('dosagem', () => {
  assert.equal(parseDosage('Losartana 50 mg 30 comprimidos'), '50mg');
  assert.equal(parseDosage('Dorflex Max 600mg + 70mg + 100mg 16 Comprimidos'), '600mg + 70mg + 100mg');
  assert.equal(parseDosage('Dipirona 500mg/ml 20ml'), '500mg/ml');
  assert.equal(parseDosage('Dorflex Dip 1g 10 Comprimidos'), '1g');
  assert.equal(parseDosage('Bepantol Creme 30g'), null);
});

test('relevância: 50mg não casa com 150mg', () => {
  const t = queryTokens('Losartana 50 mg');
  assert.deepEqual(t, ['losartana', '50mg']);
  assert.ok(matchesQuery(t, 'Losartana Potássica 50mg 30 Comprimidos'));
  assert.ok(!matchesQuery(t, 'Losartana Potássica 150mg 30 Comprimidos'));
  assert.ok(matchesQuery(queryTokens('losart'), 'Losartana'));
  assert.ok(matchesQuery(queryTokens('dipirona'), 'Novalgina 1g Sanofi Dipirona Monoidratada'));
});

test('tipo de medicamento', () => {
  assert.equal(detectType('Losartana 50mg Genérico EMS'), 'Genérico');
  assert.equal(detectType('Aradois 50mg', ['Referência']), 'Referência');
  assert.equal(detectType('Dorflex'), null);
});

test('promoções', () => {
  const p = (name, minQty, effects = {}, price = 10) => parsePromo({ name, minQty, effects }, price);
  assert.equal(p('LEVE 3 PAGUE 2', 3).unitPrice, 6.67);
  assert.equal(p('Leve 3 e Pague 2', 3, {}, 3.59).unitPrice, 2.39);
  assert.equal(p('LEVE 3 E PAGUE R$7,99 EM CADA - 38209', 3, {}, 10.39).unitPrice, 7.99);
  assert.equal(p('LEVE 3 E PAGUE R$7,99 EM CADA - 38209', 3, {}, 10.39).label, 'LEVE 3 E PAGUE R$7,99 EM CADA');
  assert.equal(p('Na compra de 2 unidades Pague R$ 1.99 cada.', 2, {}, 2.59).unitPrice, 1.99);
  assert.equal(p('COMPRE2 GANHE DESCONTO', 2, { MaximumUnitPriceDiscount: '649' }, 7.39).unitPrice, 6.49);
  assert.equal(p('60% OFF NA 2° UNIDADE', 2, {}, 8.49).unitPrice, 5.94);
  assert.equal(p('38% OFF na 2ª Unidade', 2, {}, 7.99).unitPrice, 6.47);
  // promoção que não reduz o preço é ignorada no cálculo
  assert.equal(p('PAGUE R$ 12,00 CADA', 2, {}, 10).unitPrice, null);
  assert.equal(p('Frete grátis', 1).unitPrice, null);
});

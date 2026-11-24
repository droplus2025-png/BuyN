import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExpr, termsToLines } from './calc.js';

test('the reference example: 14+3×5+5×2+18', () => {
  const r = parseExpr('14+3×5+5×2+18=');
  assert.equal(r.terms.length, 4);
  const lines = termsToLines(r.terms, ['b', 'b']);
  assert.deepEqual(lines.map((l) => [l.name, l.price, l.qty]), [['produit 1', '14', '1'], ['produit 2', '3', '5'], ['produit 3', '5', '2'], ['produit 4', '18', '1']]);
});
test('quantity can be the first number', () => {
  const lines = termsToLines(parseExpr('3×5').terms, ['a']);
  assert.deepEqual([lines[0].price, lines[0].qty], ['5', '3']);
});
test('minus and division are plain arithmetic inside a term', () => {
  assert.equal(parseExpr('20-5').terms[0].amount, '15');
  assert.equal(parseExpr('10÷4').terms[0].amount, '2.5');
  assert.equal(parseExpr('2×3×4').terms[0].amount, '24');
});
test('errors', () => {
  assert.equal(parseExpr('').error, 'EMPTY');
  assert.equal(parseExpr('5-9').error, 'NEGATIVE');
  assert.equal(parseExpr('5÷0').error, 'DIV0');
  assert.equal(parseExpr('5++').error, 'BAD');
  assert.equal(parseExpr('×5').error, 'BAD');
});
test('decimals', () => {
  const l = termsToLines(parseExpr('.5×4+2.').terms, ['b']);
  assert.deepEqual(l.map((x) => [x.price, x.qty]), [['0.5', '4'], ['2', '1']]);
});

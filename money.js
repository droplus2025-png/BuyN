// Exact arithmetic: NO floating point is ever used for money or quantities.
//   money        -> integer cents            (scale C = 100)
//   quantity     -> integer thousandths      (scale Q = 1000)
//   unit price / cost -> integer 1/10000     (scale P = 10000)
// Rounding is half-up, identical to PostgreSQL round() on positive numbers.
import { fail } from './errors.js';

export const C = 100, Q = 1000, P = 10000;

const roundDiv = (num, den) => Number((num + den / 2n) / den);   // BigInt, num >= 0

// Parse "12", "12.5", "12,5" or a number into an integer with `decimals` digits.
export function parseScaled(value, decimals, label = 'value') {
  let s;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('BAD_NUMBER', `${label} is not a number`);
    const scaled = value * 10 ** decimals;
    if (Math.abs(scaled - Math.round(scaled)) > 1e-6) fail('TOO_MANY_DECIMALS', `${label}: max ${decimals} decimals`, { value });
    s = value.toFixed(decimals);
  } else {
    s = String(value ?? '').trim().replace(',', '.');
  }
  if (!/^\d+(\.\d+)?$/.test(s)) fail('BAD_NUMBER', `${label} is not a valid positive number`, { value });
  const [int, frac = ''] = s.split('.');
  if (frac.length > decimals) fail('TOO_MANY_DECIMALS', `${label}: max ${decimals} decimals`, { value });
  return Number(int) * 10 ** decimals + Number(frac.padEnd(decimals, '0') || 0);
}
export const parseMoney = (v, label = 'amount') => parseScaled(v, 2, label);        // -> cents
export const parseQty   = (v, label = 'quantity') => parseScaled(v, 3, label);      // -> thousandths
export const parsePrice = (v, label = 'price') => parseScaled(v, 4, label);         // -> 1/10000

// line = round(qty * price, 2 decimals)  ->  cents
export const lineCents = (qtyQ, price4) => roundDiv(BigInt(qtyQ) * BigInt(price4), 100000n);

// weighted-average cost (WAC), identical to the database trigger:
//   (max(oldQty,0)*oldCost + inQty*inCost) / (max(oldQty,0) + inQty)    (cost in 1/10000)
export function wac(oldQtyQ, oldCost4, inQtyQ, inCost4) {
  const base = BigInt(Math.max(oldQtyQ, 0));
  const num = base * BigInt(oldCost4) + BigInt(inQtyQ) * BigInt(inCost4);
  return roundDiv(num, base + BigInt(inQtyQ));
}

// quick sale cost = amount * (100 - pct)/100   (pct with 2 decimals, e.g. 20 or 12.5)
export const quickCost4 = (price4, pctHundredths) => roundDiv(BigInt(price4) * BigInt(10000 - pctHundredths), 10000n);

// display helpers
export const fmtMoney = (cents) => {
  const neg = cents < 0, a = Math.abs(cents);
  const s = `${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
  return (neg ? '-' : '') + s.replace(/\.00$/, '');
};
export const fmtQty = (q) => {
  const s = `${Math.floor(Math.abs(q) / 1000)}.${String(Math.abs(q) % 1000).padStart(3, '0')}`.replace(/\.?0+$/, '');
  return (q < 0 ? '-' : '') + s;
};
export const fmtPrice = (p4) => {
  const s = `${Math.floor(p4 / 10000)}.${String(p4 % 10000).padStart(4, '0')}`.replace(/0+$/, '').replace(/\.$/, '');
  return s;
};

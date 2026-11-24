// Calculator parser for the quick-sale screen:  "14+3×5+5×2+18"  ->  terms separated by "+".
//   a single number      -> one line, price = number, qty = 1
//   "a×b"                -> one line, the employee says which number is the quantity (the other is the unit price)
//   anything else (−, ÷, a×b×c) -> evaluated as ordinary arithmetic, one line with qty 1
// Pure functions (no DOM): unit-tested in calc.test.js.
const NUM = /^(\d+\.?\d*|\.\d+)$/;
const norm = (s) => { const n = s.startsWith('.') ? `0${s}` : s; return n.endsWith('.') ? n.slice(0, -1) : n; };
const round4 = (x) => Math.round((x + Number.EPSILON) * 1e4) / 1e4;

function evalPlain(tokens) {                                  // tokens: numbers and × ÷ -   (× ÷ first, then −)
  const nums = [], ops = [];
  for (let i = 0; i < tokens.length; i++) (i % 2 ? ops : nums).push(i % 2 ? tokens[i] : Number(tokens[i]));
  const m = [nums[0]], mo = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i] === '×') m[m.length - 1] *= nums[i + 1];
    else if (ops[i] === '÷') { if (nums[i + 1] === 0) return NaN; m[m.length - 1] /= nums[i + 1]; }
    else { mo.push('-'); m.push(nums[i + 1]); }
  }
  return m.slice(1).reduce((a, v) => a - v, m[0]);
}

// -> { terms:[{kind:'single', amount:'15'} | {kind:'mul', a:'3', b:'5'}], error?:'EMPTY'|'BAD'|'NEGATIVE'|'DIV0' }
export function parseExpr(text) {
  const src = String(text || '').replace(/=+$/, '').replace(/[*xX]/g, '×').replace(/\//g, '÷').replace(/−/g, '-').replace(/\s+/g, '').replace(/,/g, '.');
  if (!src) return { terms: [], error: 'EMPTY' };
  const terms = [];
  for (const part of src.split('+')) {
    const tokens = part.match(/\d+\.?\d*|\.\d+|[×÷-]/g) || [];
    if (!part || tokens.join('') !== part) return { terms: [], error: 'BAD' };
    const ok = tokens.every((t, i) => (i % 2 === 0 ? NUM.test(t) : /^[×÷-]$/.test(t))) && tokens.length % 2 === 1;
    if (!ok) return { terms: [], error: 'BAD' };
    if (tokens.length === 3 && tokens[1] === '×') { terms.push({ kind: 'mul', a: norm(tokens[0]), b: norm(tokens[2]) }); continue; }
    if (tokens.length === 1) { terms.push({ kind: 'single', amount: norm(tokens[0]) }); continue; }
    const v = evalPlain(tokens.map((t, i) => (i % 2 ? t : norm(t))));
    if (Number.isNaN(v)) return { terms: [], error: 'DIV0' };
    if (!(v > 0)) return { terms: [], error: 'NEGATIVE' };
    terms.push({ kind: 'single', amount: String(round4(v)) });
  }
  return { terms };
}

// choices: for each 'mul' term, 'a' or 'b' = which number is the QUANTITY (default: the second, as in 3×5 = 5 pieces at 3)
export function termsToLines(terms, choices = [], startNo = 1) {
  let m = 0, no = startNo;
  return terms.map((t) => {
    const name = `produit ${no++}`;
    if (t.kind === 'single') return { name, price: t.amount, qty: '1' };
    const side = choices[m++] || 'b';
    return side === 'a' ? { name, price: t.b, qty: t.a } : { name, price: t.a, qty: t.b };
  });
}

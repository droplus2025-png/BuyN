// THE ONLY place that writes an invoice and its ledgers.
// Every operation (sale, purchase, return, payment...) builds a "draft" and calls postInvoice().
// Before commit, checkInvoice() re-verifies every figure (same rules as the database triggers):
// any difference -> the whole transaction is rolled back.
import { fail } from './errors.js';
import { lineCents, wac } from './money.js';
import { nextInvoiceNo, uniqueInvoiceNo } from './invoice-number.js';

const STOCK_SIGN = { sale: -1, quick_detail: -1, purchase: 1, return_customer: 1, return_supplier: -1 };
export const GOODS_TYPES = new Set(['sale', 'quick_sale', 'quick_detail', 'purchase', 'return_customer', 'return_supplier']);
const DEBT_TYPES = new Set(['sale', 'purchase', 'opening_debt_customer', 'opening_debt_supplier']);
const INCOMING = new Set(['purchase', 'initial', 'import']);

export const getSetting = async (tx, key, dflt) => { const s = await tx.get('settings', key); return s ? s.value : dflt; };

export async function audit(ctx, tx, action, entity, entityId, oldData = null, newData = null) {
  await tx.insert('audit_log', { id: ctx.ids(), at: ctx.now().toISOString(), user_id: ctx.userId ?? null,
    action, entity, entity_id: entityId ?? null, old_data: oldData, new_data: newData });
}

// qty and weighted-average cost move ONLY here (like the database trigger on stock_movements)
export async function applyMovement(ctx, tx, m) {
  const p = await tx.get('products', m.product_id);
  if (!p) fail('UNKNOWN_PRODUCT', 'Unknown product', { product_id: m.product_id });
  let cost = p.purchase_price;
  if (INCOMING.has(m.reason)) {
    if (!(m.qty_delta > 0) || m.unit_cost == null) fail('BAD_MOVEMENT', 'Incoming stock needs a positive quantity and a cost');
    cost = wac(p.qty, p.purchase_price, m.qty_delta, m.unit_cost);
  }
  const qty_after = p.qty + m.qty_delta;
  await tx.update('products', p.id, { qty: qty_after, purchase_price: cost, updated_at: ctx.now().toISOString() });
  await tx.insert('stock_movements', { id: ctx.ids(), product_id: p.id, invoice_id: m.invoice_id ?? null,
    line_id: m.line_id ?? null, reason: m.reason, qty_delta: m.qty_delta, unit_cost: m.unit_cost ?? null,
    qty_after, cost_before: p.purchase_price, cost_after: cost, user_id: ctx.userId ?? null,
    device_id: ctx.deviceId ?? null, created_at: ctx.now().toISOString() });
  return { qty_after, cost_after: cost };
}

export async function postInvoice(ctx, tx, d) {
  ctx.access.requirePost(d.type);
  if (d.paid + d.credit_amount !== d.total) fail('UNBALANCED', 'paid + credit must equal total', { paid: d.paid, credit: d.credit_amount, total: d.total });
  const t = ctx.now();
  const nos = (await tx.all('invoices')).map(i => i.invoice_no);
  const tz = await getSetting(tx, 'timezone', 'Africa/Casablanca');
  const invoice = {
    id: ctx.ids(), invoice_no: uniqueInvoiceNo(nos, d.invoice_no || nextInvoiceNo(nos, t, tz)), type: d.type,
    created_at: t.toISOString(), user_id: ctx.userId ?? null, device_id: ctx.deviceId ?? null,
    customer_id: d.customer_id ?? null, supplier_id: d.supplier_id ?? null, parent_invoice_id: d.parent_invoice_id ?? null,
    total: d.total, paid: d.paid, credit_amount: d.credit_amount, cash_effect: d.cash_effect,
    cost_total: d.cost_total ?? 0, profit: d.profit ?? 0, profit_pct_applied: d.profit_pct_applied ?? null,
    note: d.note ?? null, is_modified: false, sent_at: null, updated_at: t.toISOString(),
  };
  await tx.insert('invoices', invoice);

  const lines = [];
  for (let i = 0; i < (d.lines || []).length; i++) {
    const l = d.lines[i];
    const row = { id: ctx.ids(), invoice_id: invoice.id, line_no: i + 1, kind: l.kind, product_id: l.product_id ?? null,
      origin_line_id: l.origin_line_id ?? null, name: l.name, qty: l.qty, unit_price: l.unit_price, unit_cost: l.unit_cost ?? 0,
      line_total: lineCents(l.qty, l.unit_price), line_cost: lineCents(l.qty, l.unit_cost ?? 0) };
    await tx.insert('invoice_lines', row.product_id && !row.cat ? { ...row, cat: ((await tx.get('products', row.product_id))?.sku || '0')[0] } : row);
    lines.push(row);
  }
  for (const m of d.stock || []) await applyMovement(ctx, tx, { ...m, invoice_id: invoice.id, line_id: m.line != null ? lines[m.line].id : null });
  if (d.cash_effect !== 0) await tx.insert('cash_ledger', { id: ctx.ids(), invoice_id: invoice.id, amount: d.cash_effect,
    user_id: ctx.userId ?? null, device_id: ctx.deviceId ?? null, created_at: t.toISOString() });
  for (const x of d.debt || []) await tx.insert('debt_ledger', { id: ctx.ids(), customer_id: x.customer_id ?? null,
    supplier_id: x.supplier_id ?? null, invoice_id: invoice.id, amount: x.amount, user_id: ctx.userId ?? null,
    device_id: ctx.deviceId ?? null, created_at: t.toISOString() });
  for (const s of d.settlements || []) await tx.insert('invoice_settlements', { id: ctx.ids(), source_invoice_id: invoice.id,
    target_invoice_id: s.target_invoice_id, amount: s.amount, kind: s.kind, created_at: t.toISOString() });

  const targets = (d.settlements || []).map(s => s.target_invoice_id);
  tx.beforeCommit(async (tx2) => { await checkInvoice(tx2, invoice.id); for (const id of targets) await checkInvoice(tx2, id); });
  return { invoice, lines };
}

// ------------------------------------------------------------------ what is still owed on an invoice
export async function remainingDebt(tx, inv) {
  if (!DEBT_TYPES.has(inv.type)) return 0;
  const set = await tx.find('invoice_settlements', s => s.target_invoice_id === inv.id);
  return inv.credit_amount - set.reduce((a, s) => a + s.amount, 0);
}

// open invoices of a party, oldest first (FIFO)
export async function openInvoices(tx, { customer_id, supplier_id }) {
  const types = customer_id ? ['sale', 'opening_debt_customer'] : ['purchase', 'opening_debt_supplier'];
  const invs = (await tx.find('invoices', i => types.includes(i.type) && i.credit_amount > 0
    && (customer_id ? i.customer_id === customer_id : i.supplier_id === supplier_id)))
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.invoice_no.localeCompare(b.invoice_no));
  const out = [];
  for (const inv of invs) { const r = await remainingDebt(tx, inv); if (r > 0) out.push({ invoice: inv, remaining: r }); }
  return out;
}

export async function allocateFifo(tx, party, amount) {
  const open = await openInvoices(tx, party);
  const owed = open.reduce((a, o) => a + o.remaining, 0);
  if (amount > owed) fail('OVERPAYMENT', 'The amount exceeds the debt', { owed, amount });
  let left = amount; const out = [];
  for (const o of open) {
    if (left <= 0) break;
    const take = Math.min(left, o.remaining);
    out.push({ target_invoice_id: o.invoice.id, amount: take, kind: 'payment' });
    left -= take;
  }
  return out;
}

// ------------------------------------------------------------------ the safety net (mirrors fn_check_invoice)
export async function checkInvoice(tx, id) {
  const i = await tx.get('invoices', id);
  if (!i) return;
  const no = i.invoice_no;
  const lines = await tx.find('invoice_lines', l => l.invoice_id === id);
  const sumLines = lines.reduce((a, l) => a + l.line_total, 0);
  if (GOODS_TYPES.has(i.type)) {
    if (!lines.length) fail('CHECK_FAILED', `Invoice ${no} has no lines`);
    if (sumLines !== i.total) fail('CHECK_FAILED', `Invoice ${no}: total ${i.total} <> sum of lines ${sumLines}`);
  } else if (lines.length) fail('CHECK_FAILED', `Invoice ${no} of this type cannot have lines`);

  const cash = (await tx.find('cash_ledger', c => c.invoice_id === id)).reduce((a, c) => a + c.amount, 0);
  if (cash !== i.cash_effect) fail('CHECK_FAILED', `Invoice ${no}: cash ledger ${cash} <> cash_effect ${i.cash_effect}`);

  const expDebt = (i.type === 'sale' || i.type === 'purchase' || i.type.startsWith('opening_debt')) ? i.credit_amount
    : (i.type === 'collect' || i.type === 'pay_supplier') ? -i.paid
    : (i.type === 'return_customer' || i.type === 'return_supplier') ? -i.credit_amount : 0;
  const debts = await tx.find('debt_ledger', d => d.invoice_id === id);
  if (debts.reduce((a, d) => a + d.amount, 0) !== expDebt) fail('CHECK_FAILED', `Invoice ${no}: debt ledger does not match`);
  if (debts.some(d => (d.customer_id ?? null) !== i.customer_id || (d.supplier_id ?? null) !== i.supplier_id)) fail('CHECK_FAILED', `Invoice ${no}: debt entry on the wrong party`);

  const sign = STOCK_SIGN[i.type] || 0;
  const want = new Map(), got = new Map();
  for (const l of lines) if (l.kind === 'product') want.set(l.product_id, (want.get(l.product_id) || 0) + l.qty * sign);
  for (const m of await tx.find('stock_movements', m => m.invoice_id === id)) got.set(m.product_id, (got.get(m.product_id) || 0) + m.qty_delta);
  for (const k of new Set([...want.keys(), ...got.keys()])) if ((want.get(k) || 0) !== (got.get(k) || 0)) fail('CHECK_FAILED', `Invoice ${no}: stock movements do not match the lines`);

  const red = (i.type === 'collect' || i.type === 'pay_supplier') ? i.paid : (i.type.startsWith('return_')) ? i.credit_amount : 0;
  const src = (await tx.find('invoice_settlements', s => s.source_invoice_id === id)).reduce((a, s) => a + s.amount, 0);
  if (src > red) fail('CHECK_FAILED', `Invoice ${no}: settlements exceed the amount available`);
  const tgt = (await tx.find('invoice_settlements', s => s.target_invoice_id === id)).reduce((a, s) => a + s.amount, 0);
  if (tgt > (DEBT_TYPES.has(i.type) ? i.credit_amount : 0)) fail('CHECK_FAILED', `Invoice ${no}: settled more than its debt`);
}

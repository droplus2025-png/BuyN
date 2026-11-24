// Returns: a separate invoice linked to the original (which stays frozen, only flagged "معدلة").
// Valued at the ORIGINAL price and cost. The debt of the original is reduced first, the rest goes through the till.
import { fail } from './errors.js';
import { parseQty, lineCents } from './money.js';
import { postInvoice, remainingDebt } from './post.js';

async function loadParent(tx, ref, allowed) {
  const inv = (await tx.find('invoices', i => i.id === ref || i.invoice_no === ref))[0];
  if (!inv) fail('INVOICE_NOT_FOUND', 'Original invoice not found');
  if (inv.type === 'quick_sale') {                           // a detailed quick sale is returned through its detail lines
    const d = (await tx.find('invoices', i => i.type === 'quick_detail' && i.parent_invoice_id === inv.id))[0];
    if (d) return d;
  }
  if (!allowed.includes(inv.type)) fail('BAD_PARENT', 'This invoice cannot be returned this way', { type: inv.type });
  return inv;
}
async function buildReturnLines(tx, parent, input) {
  if (!input.lines?.length) fail('EMPTY_CART', 'Nothing to return');
  const lines = [], taken = new Map();
  for (const r of input.lines) {
    const o = (await tx.find('invoice_lines', l => l.id === r.originLineId && l.invoice_id === parent.id))[0];
    if (!o) fail('LINE_NOT_FOUND', 'Line does not belong to the original invoice', { originLineId: r.originLineId });
    const qty = parseQty(r.qty, 'qty');
    if (qty <= 0) fail('BAD_NUMBER', 'Quantity must be positive');
    const already = (await tx.find('invoice_lines', l => l.origin_line_id === o.id)).reduce((a, l) => a + l.qty, 0) + (taken.get(o.id) || 0);
    if (already + qty > o.qty) fail('RETURN_EXCEEDS', 'Returned quantity exceeds the original', { available: o.qty - already, originLineId: o.id });
    taken.set(o.id, (taken.get(o.id) || 0) + qty);
    lines.push({ kind: o.kind, product_id: o.product_id, origin_line_id: o.id, name: o.name, qty, unit_price: o.unit_price, unit_cost: o.unit_cost });
  }
  return lines;
}
const markModified = (ctx, tx, parent) => tx.update('invoices', parent.id, { is_modified: true, updated_at: ctx.now().toISOString() });

export function returnsApi(ctx) {
  const { store } = ctx;
  return {
    // input: { invoice: <id or number>, lines:[{originLineId, qty}] }   (sale and quick sale)
    async customerReturn(input) {
      ctx.access.require('return_customer');
      return store.transaction(async (tx) => {
        const parent = await loadParent(tx, input.invoice, ['sale', 'quick_sale', 'quick_detail']);
        const lines = await buildReturnLines(tx, parent, input);
        const total = lines.reduce((a, l) => a + lineCents(l.qty, l.unit_price), 0);
        const costTotal = lines.reduce((a, l) => a + lineCents(l.qty, l.unit_cost), 0);
        const open = await remainingDebt(tx, parent);
        const credit = Math.min(total, open), refund = total - credit;
        const stock = lines.map((l, i) => l.kind === 'product' ? { line: i, product_id: l.product_id, reason: 'return_customer', qty_delta: l.qty } : null).filter(Boolean);
        const res = await postInvoice(ctx, tx, {
          type: 'return_customer', customer_id: parent.customer_id, parent_invoice_id: parent.id,
          total, paid: refund, credit_amount: credit, cash_effect: -refund,
          cost_total: costTotal, profit: -(total - costTotal), lines, stock,
          debt: credit > 0 ? [{ customer_id: parent.customer_id, amount: -credit }] : [],
          settlements: credit > 0 ? [{ target_invoice_id: parent.id, amount: credit, kind: 'return' }] : [],
        });
        await markModified(ctx, tx, parent);
        return { ...res, debt_reduced: credit, refunded: refund };
      });
    },

    // input: { invoice, lines:[{originLineId, qty}] }   (purchase). Blocked if the stock is not there.
    async supplierReturn(input) {
      ctx.access.require('return_supplier');
      return store.transaction(async (tx) => {
        const parent = await loadParent(tx, input.invoice, ['purchase']);
        const lines = await buildReturnLines(tx, parent, input);
        const need = new Map();
        for (const l of lines) need.set(l.product_id, (need.get(l.product_id) || 0) + l.qty);
        for (const [pid, q] of need) {
          const p = await tx.get('products', pid);
          if (p.qty < q) fail('STOCK_INSUFFICIENT', 'Not enough stock to return to the supplier', { sku: p.sku, available: p.qty, needed: q });
        }
        const total = lines.reduce((a, l) => a + lineCents(l.qty, l.unit_price), 0);
        const open = await remainingDebt(tx, parent);
        const credit = Math.min(total, open), refund = total - credit;
        const stock = lines.map((l, i) => ({ line: i, product_id: l.product_id, reason: 'return_supplier', qty_delta: -l.qty }));
        const res = await postInvoice(ctx, tx, {
          type: 'return_supplier', supplier_id: parent.supplier_id, parent_invoice_id: parent.id,
          total, paid: refund, credit_amount: credit, cash_effect: refund, lines, stock,
          debt: credit > 0 ? [{ supplier_id: parent.supplier_id, amount: -credit }] : [],
          settlements: credit > 0 ? [{ target_invoice_id: parent.id, amount: credit, kind: 'return' }] : [],
        });
        await markModified(ctx, tx, parent);
        return { ...res, debt_reduced: credit, refunded: refund };
      });
    },
  };
}

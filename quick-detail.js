// Quick sale -> product details added AFTER the sale (once), total untouched.
// Same freedom as a normal sale: choose products, external products, edit price and quantity.
// The products are those REALLY sold, at the price they were REALLY sold: nothing is shared out
// automatically. The lines must add up to the total exactly, otherwise the invoice stays undetailed.
// The original invoice stays frozen. A linked detail record carries the lines, takes the stock out,
// takes the cost of external items out of the till, and replaces the flat quick-sale profit % by the
// REAL profit:   detail.profit = (total - real costs) - flat profit    ->  original + detail = real.
import { fail } from './errors.js';
import { lineCents } from './money.js';
import { postInvoice } from './post.js';
import { findOrCreateParty } from './parties.js';
import { buildCartLines } from './cart.js';

// input: { invoice, lines:[{productId, qty, price?} | {external:{name,cost,price,qty}}], allowBelowCost?, customer?:{name,phone} (optional) }
async function build(ctx, tx, input) {
  const parent = (await tx.find('invoices', (i) => i.id === input.invoice || i.invoice_no === input.invoice))[0];
  if (!parent) fail('INVOICE_NOT_FOUND', 'Invoice not found');
  if (parent.type !== 'quick_sale') fail('BAD_PARENT', 'Only a quick sale can be detailed', { type: parent.type });
  if ((await tx.find('invoices', (i) => i.type === 'quick_detail' && i.parent_invoice_id === parent.id)).length) fail('ALREADY_DETAILED', 'This quick sale already has its details');
  if ((await tx.find('invoices', (i) => i.type === 'return_customer' && i.parent_invoice_id === parent.id)).length) fail('HAS_RETURNS', 'A returned quick sale cannot be detailed');
  if (!input.lines?.length) fail('EMPTY_CART', 'Add at least one product');

  const { lines, stock, warnings, below } = await buildCartLines(ctx, tx, input.lines, { blankPriceIsDefault: true });
  const lineTotals = lines.map((l) => lineCents(l.qty, l.unit_price));
  const distributed = lineTotals.reduce((a, b) => a + b, 0);
  const costTotal = lines.reduce((a, l) => a + lineCents(l.qty, l.unit_cost), 0);
  const externalCost = lines.filter((l) => l.kind === 'external').reduce((a, l) => a + lineCents(l.qty, l.unit_cost), 0);
  return { parent, lines, stock, lineTotals, distributed, remaining: parent.total - distributed, costTotal, externalCost,
    realProfit: parent.total - costTotal, warnings, below };
}

export function quickDetailApi(ctx) {
  const { store } = ctx;
  return {
    // what the screen needs while the employee types: how much is distributed, what remains, the real profit
    async previewQuickDetail(input) {
      ctx.access.require('quick_sale');
      return store.transaction(async (tx) => {
        const b = await build(ctx, tx, input);
        return { total: b.parent.total, distributed: b.distributed, remaining: b.remaining,
          lines: b.lines.map((l, i) => ({ ...l, line_total: b.lineTotals[i] })), cost_total: b.costTotal,
          real_profit: b.realProfit, flat_profit: b.parent.profit, warnings: b.warnings, below_cost: b.below };
      });
    },
    async detailQuickSale(input) {
      ctx.access.require('quick_sale');                       // whoever can make a quick sale can (and must) detail it
      return store.transaction(async (tx) => {
        const b = await build(ctx, tx, input);
        if (b.remaining !== 0) fail('DETAIL_TOTAL_MISMATCH', 'The lines must add up to the invoice total', { total: b.parent.total, distributed: b.distributed, remaining: b.remaining });
        const warnings = [...b.warnings];
        if (b.below.length) {                                  // same alert as a normal sale
          ctx.access.require('sell_below_cost');
          if (!input.allowBelowCost) fail('BELOW_COST', 'Selling below cost: confirm to continue', { items: b.below });
          warnings.push({ type: 'BELOW_COST', items: b.below });
        }
        // optional customer typed while detailing: stored on the detail record (a quick sale is paid in full: no debt)
        const c = input.customer && (input.customer.name || input.customer.phone) && !b.parent.customer_id
          ? await findOrCreateParty(ctx, tx, 'customers', input.customer) : null;
        const res = await postInvoice(ctx, tx, {
          type: 'quick_detail', customer_id: c?.id, invoice_no: `${b.parent.invoice_no}-D`, parent_invoice_id: b.parent.id,
          total: b.parent.total, paid: b.parent.total, credit_amount: 0,
          cash_effect: -b.externalCost,                         // an external item's cost leaves the till (as in a normal sale)
          cost_total: b.costTotal, profit: b.realProfit - b.parent.profit,        // the flat % is cancelled
          lines: b.lines, stock: b.stock,
        });
        await tx.update('invoices', b.parent.id, { is_modified: true, updated_at: ctx.now().toISOString() });
        return { ...res, real_profit: b.realProfit, flat_profit: b.parent.profit, warnings };
      });
    },
  };
}

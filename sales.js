// Sale (cart with products + external "on order" items) and quick sale (keypad).
import { fail } from './errors.js';
import { parseMoney, parseQty, parsePrice, parseScaled, lineCents, quickCost4 } from './money.js';
import { postInvoice, getSetting } from './post.js';
import { findOrCreateParty } from './parties.js';
import { buildCartLines } from './cart.js';

export function salesApi(ctx) {
  const { store } = ctx;
  return {
    // input: { lines:[{productId, qty, price?} | {external:{name, cost, price, qty}}],
    //          paid?, customer?:{name,phone}, allowBelowCost?, note? }
    async sale(input) {
      ctx.access.require('sell');
      return store.transaction(async (tx) => {
        if (!input.lines?.length) fail('EMPTY_CART', 'The cart is empty');
        const { lines, stock, warnings, below } = await buildCartLines(ctx, tx, input.lines);
        if (below.length) {
          ctx.access.require('sell_below_cost');
          if (!input.allowBelowCost) fail('BELOW_COST', 'Selling below cost: confirm to continue', { items: below });   // UI alert: continue or go back
          warnings.push({ type: 'BELOW_COST', items: below });
        }

        const total = lines.reduce((a, l) => a + lineCents(l.qty, l.unit_price), 0);
        const costTotal = lines.reduce((a, l) => a + lineCents(l.qty, l.unit_cost), 0);
        const externalCost = lines.filter(l => l.kind === 'external').reduce((a, l) => a + lineCents(l.qty, l.unit_cost), 0);
        const asked = input.paid === undefined || input.paid === null || input.paid === '' ? total : parseMoney(input.paid, 'paid');
        const paid = Math.min(asked, total);                      // change given back is not recorded
        const credit = total - paid;

        let customer = null;
        if (input.customer && (input.customer.phone || input.customer.name)) customer = await findOrCreateParty(ctx, tx, 'customers', input.customer);
        if (credit > 0 && !customer) fail('CUSTOMER_REQUIRED', 'Name and phone are required for a credit sale');

        const res = await postInvoice(ctx, tx, {
          type: 'sale', customer_id: customer?.id, total, paid, credit_amount: credit,
          cash_effect: paid - externalCost,                       // external item: its cost leaves the till now
          cost_total: costTotal, profit: total - costTotal, note: input.note, lines, stock,
          debt: credit > 0 ? [{ customer_id: customer.id, amount: credit }] : [],
        });
        return { ...res, customer, change: Math.max(0, asked - total), warnings };
      });
    },

    // keypad sale: only an amount. Nothing is deducted from the till; the whole price is added.
    // Only the configured % (Administration) counts as profit in the reports.
    async quickSale(amount, customer) {
      ctx.access.require('quick_sale');
      return store.transaction(async (tx) => {
        const total = parseMoney(amount, 'amount');
        if (total <= 0) fail('BAD_NUMBER', 'Amount must be positive');
        const pct = await getSetting(tx, 'quick_sale_profit_pct', 20);
        const pctH = parseScaled(pct, 2, 'profit %');
        const price4 = total * 100;
        const cost4 = quickCost4(price4, pctH);
        const costTotal = lineCents(1000, cost4);
        // optional customer (name + phone typed on the sale screen): only for the archive, a quick sale is always paid in full
        const cust = customer && customer.name && customer.phone ? await findOrCreateParty(ctx, tx, 'customers', customer) : null;
        return postInvoice(ctx, tx, {
          type: 'quick_sale', customer_id: cust?.id, total, paid: total, credit_amount: 0, cash_effect: total,
          cost_total: costTotal, profit: total - costTotal, profit_pct_applied: pctH / 100,
          lines: [{ kind: 'quick', name: 'بيع سريع', qty: 1000, unit_price: price4, unit_cost: cost4 }],
        });
      });
    },

    // calculator sale (quick-sale screen as a calculator): several lines typed as  14+3×5+5×2+18 .
    // Same accounting as the keypad quick sale (paid in full, flat profit % from the settings), but the invoice keeps one
    // line per term (name "produit n", price, quantity) so the details can be completed later with the least effort.
    // input: { lines:[{name?, qty, price}], customer?:{name,phone} }
    async calcSale(input) {
      ctx.access.require('quick_sale');
      return store.transaction(async (tx) => {
        if (!input.lines?.length) fail('EMPTY_CART', 'Add at least one line');
        const pct = await getSetting(tx, 'quick_sale_profit_pct', 20);
        const pctH = parseScaled(pct, 2, 'profit %');
        const lines = input.lines.map((l, i) => {
          const qty = parseQty(l.qty ?? 1, 'qty'), price4 = parsePrice(l.price, 'price');
          if (qty <= 0 || price4 <= 0) fail('BAD_NUMBER', 'Price and quantity must be positive');
          const name = String(l.name || '').trim() || `produit ${i + 1}`;
          return { kind: 'quick', name, qty, unit_price: price4, unit_cost: quickCost4(price4, pctH) };
        });
        const total = lines.reduce((a, l) => a + lineCents(l.qty, l.unit_price), 0);
        if (total <= 0) fail('BAD_NUMBER', 'Amount must be positive');
        const costTotal = lines.reduce((a, l) => a + lineCents(l.qty, l.unit_cost), 0);
        const c = input.customer;
        const cust = c && c.name && c.phone ? await findOrCreateParty(ctx, tx, 'customers', c) : null;
        return postInvoice(ctx, tx, {
          type: 'quick_sale', customer_id: cust?.id, total, paid: total, credit_amount: 0, cash_effect: total,
          cost_total: costTotal, profit: total - costTotal, profit_pct_applied: pctH / 100, lines,
        });
      });
    },
  };
}

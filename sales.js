// Sale (cart with products + external "on order" items) and quick sale (keypad).
import { fail } from './errors.js';
import { parseMoney, parseQty, parsePrice, parseScaled, lineCents, quickCost4 } from './money.js';
import { postInvoice, getSetting } from './post.js';
import { findOrCreateParty } from './parties.js';
import { cashBalance } from './queries.js';

export function salesApi(ctx) {
  const { store } = ctx;
  return {
    // input: { lines:[{productId, qty, price?} | {external:{name, cost, price, qty}}],
    //          paid?, customer?:{name,phone}, allowBelowCost?, note? }
    async sale(input) {
      ctx.access.require('sell');
      return store.transaction(async (tx) => {
        if (!input.lines?.length) fail('EMPTY_CART', 'The cart is empty');
        const lines = [], warnings = [], below = [], stock = [];
        const used = new Map();                                  // qty already taken per product in this cart
        for (const l of input.lines) {
          if (l.external) {
            ctx.access.require('external_product');
            const e = l.external;
            if (!e.name || !String(e.name).trim()) fail('NAME_REQUIRED', 'External product needs a name');
            const qty = parseQty(e.qty ?? 1, 'qty');
            if (qty <= 0) fail('BAD_NUMBER', 'Quantity must be positive');
            lines.push({ kind: 'external', name: String(e.name).trim(), qty, unit_price: parsePrice(e.price, 'sale price'), unit_cost: parsePrice(e.cost ?? 0, 'purchase price') });
            continue;
          }
          const p = await tx.get('products', l.productId);
          if (!p || p.deleted_at) fail('UNKNOWN_PRODUCT', 'Unknown product', { productId: l.productId });
          const qty = parseQty(l.qty ?? 1, 'qty');
          if (qty <= 0) fail('BAD_NUMBER', 'Quantity must be positive');
          const price = l.price === undefined ? p.sale_price : parsePrice(l.price, 'price');
          if (price !== p.sale_price) ctx.access.require('edit_sale_price');
          lines.push({ kind: 'product', product_id: p.id, name: p.name, qty, unit_price: price, unit_cost: p.purchase_price });
          stock.push({ line: lines.length - 1, product_id: p.id, reason: 'sale', qty_delta: -qty });
          const after = p.qty - (used.get(p.id) || 0) - qty;
          used.set(p.id, (used.get(p.id) || 0) + qty);
          if (after < 0) warnings.push({ type: 'NEGATIVE_STOCK', sku: p.sku, name: p.name, qty_after: after });
        }
        for (const l of lines) if (l.unit_price < l.unit_cost) below.push({ name: l.name, price: l.unit_price, cost: l.unit_cost });
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
export { cashBalance };

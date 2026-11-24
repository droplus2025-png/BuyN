// Purchase: stock in, weighted-average cost, supplier debt for the unpaid part.
import { fail } from './errors.js';
import { parseMoney, parseQty, parsePrice, lineCents } from './money.js';
import { postInvoice } from './post.js';
import { findOrCreateParty } from './parties.js';
import { cashBalance } from './queries.js';

export function purchasesApi(ctx) {
  const { store } = ctx;
  return {
    // input: { supplier:{name,phone}, lines:[{productId, qty, price, salePrice?}], paid? }
    async purchase(input) {
      ctx.access.require('purchase');
      return store.transaction(async (tx) => {
        if (!input.lines?.length) fail('EMPTY_CART', 'No product to buy');
        const supplier = await findOrCreateParty(ctx, tx, 'suppliers', input.supplier || {});
        const lines = [], stock = [], newSale = [], warnings = [];
        for (const l of input.lines) {
          const p = await tx.get('products', l.productId);
          if (!p || p.deleted_at) fail('UNKNOWN_PRODUCT', 'Unknown product', { productId: l.productId });
          const qty = parseQty(l.qty, 'qty'), price = parsePrice(l.price, 'purchase price');
          if (qty <= 0) fail('BAD_NUMBER', 'Quantity must be positive');
          if (price !== p.purchase_price) ctx.access.require('edit_purchase_price');
          lines.push({ kind: 'product', product_id: p.id, name: p.name, qty, unit_price: price, unit_cost: price });
          stock.push({ line: lines.length - 1, product_id: p.id, reason: 'purchase', qty_delta: qty, unit_cost: price });
          if (l.salePrice !== undefined && l.salePrice !== '') { ctx.access.require('edit_sale_price'); newSale.push([p, parsePrice(l.salePrice, 'sale price')]); }
        }
        const total = lines.reduce((a, l) => a + lineCents(l.qty, l.unit_price), 0);
        const paid = input.paid === undefined || input.paid === null || input.paid === '' ? total : parseMoney(input.paid, 'paid');
        if (paid > total) fail('OVERPAYMENT', 'Payment cannot exceed the invoice', { total, paid });   // never pay more than the bill
        const credit = total - paid;
        if ((await cashBalance(tx)) - paid < 0) warnings.push({ type: 'CASH_NEGATIVE' });          // allowed, but flagged

        const res = await postInvoice(ctx, tx, { type: 'purchase', supplier_id: supplier.id, total, paid, credit_amount: credit,
          cash_effect: -paid, note: input.note, lines, stock, debt: credit > 0 ? [{ supplier_id: supplier.id, amount: credit }] : [] });

        for (const [p, sale] of newSale) {                        // sale price edited on the purchase page
          const cur = await tx.get('products', p.id);
          if (cur.sale_price === sale) continue;
          const u = await tx.update('products', p.id, { sale_price: sale, updated_at: ctx.now().toISOString() });
          await tx.insert('price_history', { id: ctx.ids(), product_id: p.id, old_purchase_price: cur.purchase_price, new_purchase_price: u.purchase_price,
            old_sale_price: cur.sale_price, new_sale_price: sale, changed_by: ctx.userId ?? null, changed_at: ctx.now().toISOString() });
        }
        return { ...res, supplier, warnings };
      });
    },
  };
}

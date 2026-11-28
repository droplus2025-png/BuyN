// Cart lines shared by the normal sale and the product details of a quick sale (one definition of the rules).
// input line: {productId, qty, price?} | {external:{name, cost, price, qty}}.  Stock may go negative: it only warns.
// blankPriceIsDefault: an empty price field means "the product's own price" (details screen); otherwise it is an error (sale).
import { fail } from './errors.js';
import { parseQty, parsePrice } from './money.js';

export async function buildCartLines(ctx, tx, inputLines, { blankPriceIsDefault = false } = {}) {
  const lines = [], stock = [], warnings = [], used = new Map();     // used: quantity already taken per product in this cart
  for (const l of inputLines) {
    if (l.external) {                                          // an item bought for this customer, not in stock
      ctx.access.require('external_product');
      const e = l.external;
      if (!e.name || !String(e.name).trim()) fail('NAME_REQUIRED', 'External product needs a name');
      const qty = parseQty(e.qty ?? 1, 'qty');
      if (qty <= 0) fail('BAD_NUMBER', 'Quantity must be positive');
      const ePrice = parsePrice(e.price, 'sale price');
      if (ePrice <= 0) fail('ZERO_PRICE', 'This product has no sale price', { name: String(e.name).trim() });
      lines.push({ kind: 'external', name: String(e.name).trim(), qty, unit_price: ePrice, unit_cost: parsePrice(e.cost ?? 0, 'purchase price') });
      continue;
    }
    const p = await tx.get('products', l.productId);
    if (!p || p.deleted_at) fail('UNKNOWN_PRODUCT', 'Unknown product', { productId: l.productId });
    const qty = parseQty(l.qty ?? 1, 'qty');
    if (qty <= 0) fail('BAD_NUMBER', 'Quantity must be positive');
    const blank = l.price === undefined || (blankPriceIsDefault && l.price === '');
    const price = blank ? p.sale_price : parsePrice(l.price, 'price');
    if (price <= 0) fail('ZERO_PRICE', 'This product has no sale price', { sku: p.sku, name: p.name });
    if (price !== p.sale_price) ctx.access.require('edit_sale_price');
    lines.push({ kind: 'product', product_id: p.id, name: p.name, qty, unit_price: price, unit_cost: p.purchase_price });
    stock.push({ line: lines.length - 1, product_id: p.id, reason: 'sale', qty_delta: -qty });
    const after = p.qty - (used.get(p.id) || 0) - qty;
    used.set(p.id, (used.get(p.id) || 0) + qty);
    if (after < 0) warnings.push({ type: 'NEGATIVE_STOCK', sku: p.sku, name: p.name, qty_after: after });
  }
  const below = lines.filter((l) => l.unit_price < l.unit_cost).map((l) => ({ name: l.name, price: l.unit_price, cost: l.unit_cost }));
  return { lines, stock, warnings, below };
}

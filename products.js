// Products: SKU never reused, price history, stock only through movements.
import { fail } from './errors.js';
import { parseScaled, parsePrice, parseQty, fmtPrice, fmtQty, latinDigits } from './money.js';
import { audit, applyMovement } from './post.js';

const cleanName = (s) => String(s).replace(/\s+/g, ' ').trim();
const nameKey = (s) => cleanName(s).toLowerCase();

// Paste text (Excel / ;) -> import rows. A line with ONE column (or names-only mode) is a bare product name: qty and prices stay 0.
// Full lines are: code ; product ; purchase ; sale ; qty  (a first cell that is not a code makes the line a bare name, never shifts columns).
const HEAD_CELLS = new Set(['sku', 'code', 'produit', 'name', 'product', 'الرقم', 'الكود', 'المنتج', 'الاسم', 'اسم المنتج']);
export function parsePasteRows(text, { namesOnly = false } = {}) {
  const rows = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const c = line.split(/\t|;/).map((x) => x.trim().replace(/^"(.*)"$/, '$1').trim());
    if (c.length > 1 && /^[\d\u0660-\u0669\u06F0-\u06F9]+$/.test(c[0])) c[0] = latinDigits(c[0]);          // code typed with Arabic digits
    if (!c.some(Boolean)) continue;
    if (c.some((x) => HEAD_CELLS.has(x.toLowerCase())) && c.length > 1) continue;     // header line
    const bare = namesOnly || c.length === 1 || !/^\d+$/.test(c[0]);
    if (bare) {
      const name = c.find(Boolean);
      if (!name || (c.length === 1 && HEAD_CELLS.has(name.toLowerCase()))) continue;
      rows.push({ name, purchasePrice: '0', salePrice: '0', qty: '0' });
      continue;
    }
    if (!c[1]) continue;
    rows.push({ sku: c[0], name: c[1], purchasePrice: c[2] || '0', salePrice: c[3] || '0', qty: c[4] || '0' });
  }
  return rows;
}
// sale price: max 2 decimals (like the database column)
const parseSalePrice = (v, label) => parseScaled(v, 2, label) * 100;

// Product code = ONE category digit (0-9) + product number (1, 2, 3 ... no leading zero, no product 0). Stored as text.
const CODE_RE = /^[0-9][1-9][0-9]*$/;
export const catOf = (code) => String(code)[0];
const numOf = (code) => Number(String(code).slice(1));
const skuCmp = (a, b) => (catOf(a) - catOf(b)) || (numOf(a) - numOf(b));
async function nextSku(tx, cat = '0') {
  const used = new Set((await tx.all('sku_registry')).map(r => r.sku));
  let n = 1; while (used.has(`${cat}${n}`)) n++;
  return `${cat}${n}`;
}
async function reserveSku(ctx, tx, sku, productId) {
  const r = await tx.get('sku_registry', sku);
  if (r && r.product_id !== productId) fail('SKU_TAKEN', `SKU ${sku} already belongs to another product`, { sku });
  if (!r) await tx.insert('sku_registry', { sku, product_id: productId });
}
async function assertNameFree(tx, name, exceptId) {
  const dup = (await tx.find('products', p => !p.deleted_at && nameKey(p.name) === nameKey(name) && p.id !== exceptId))[0];
  if (dup) fail('PRODUCT_EXISTS', 'هذا المنتج موجود', { sku: dup.sku, name: dup.name });
}

export function productsApi(ctx) {
  const { store } = ctx;
  return {
    async create({ name, purchasePrice = 0, salePrice = 0, sku, qty = 0, cat = '0' }) {
      ctx.access.require('add_product');
      const q = parseQty(qty, 'qty');
      if (q > 0) ctx.access.require('manage_stock');          // initial stock = owner job by default
      return store.transaction(async (tx) => {
        if (!name || !String(name).trim()) fail('NAME_REQUIRED', 'Product name is required');
        await assertNameFree(tx, name);
        if (!/^[0-9]$/.test(String(cat))) fail('BAD_CATEGORY', 'Category is one digit 0-9');
        const wanted = sku == null ? await nextSku(tx, String(cat)) : String(sku);
        if (!CODE_RE.test(wanted)) fail('BAD_SKU', 'Code = category digit + product number (1, 2, 3...)');
        if ((await tx.find('products', p => p.sku === wanted))[0]) fail('SKU_TAKEN', `SKU ${wanted} is used`, { sku: wanted });
        const t = ctx.now().toISOString();
        const p = await tx.insert('products', { id: ctx.ids(), sku: wanted, cat: catOf(wanted), num: numOf(wanted), name: cleanName(name),
          purchase_price: parsePrice(purchasePrice, 'purchase price'), sale_price: parseSalePrice(salePrice, 'sale price'),
          qty: 0, deleted_at: null, origin_device: ctx.deviceId ?? null, created_at: t, updated_at: t });
        await reserveSku(ctx, tx, wanted, p.id);
        await audit(ctx, tx, 'insert', 'products', p.id, null, p);
        if (q > 0) await applyMovement(ctx, tx, { product_id: p.id, reason: 'initial', qty_delta: q, unit_cost: p.purchase_price });
        return tx.get('products', p.id);
      });
    },

    // smallest free code of a category (numbers of deleted products stay reserved); `taken` = codes already planned elsewhere
    async nextCode(cat = '0', taken = []) {
      if (!/^[0-9]$/.test(String(cat))) fail('BAD_CATEGORY', 'Category is one digit 0-9');
      const skip = new Set(taken.map(String));
      return store.transaction(async (tx) => {
        const used = new Set((await tx.all('sku_registry')).map((r) => r.sku));
        let n = 1; while (used.has(`${cat}${n}`) || skip.has(`${cat}${n}`)) n++;
        return `${cat}${n}`;
      });
    },
    // the product with this name (same spelling rules as the "name is free" check), or null
    async byName(name) { return store.transaction(async (tx) => (await tx.find('products', (p) => !p.deleted_at && nameKey(p.name) === nameKey(name)))[0] || null); },

    // prices and name: every change is journaled; SKU change / delete need manage_stock
    async update(id, { name, purchasePrice, salePrice, sku }) {
      return store.transaction(async (tx) => {
        const p = await tx.get('products', id);
        if (!p || p.deleted_at) fail('UNKNOWN_PRODUCT', 'Unknown product');
        const patch = {};
        if (name !== undefined) { await assertNameFree(tx, name, id); patch.name = cleanName(name); }
        if (purchasePrice !== undefined) { ctx.access.require('edit_purchase_price'); patch.purchase_price = parsePrice(purchasePrice, 'purchase price'); }
        if (salePrice !== undefined) { ctx.access.require('edit_sale_price'); patch.sale_price = parseSalePrice(salePrice, 'sale price'); }
        if (sku !== undefined && String(sku) !== p.sku) {
          ctx.access.require('manage_stock');
          const n = String(sku);
          if (!CODE_RE.test(n)) fail('BAD_SKU', 'Code = category digit + product number (1, 2, 3...)');
          if ((await tx.find('products', x => x.sku === n && x.id !== id))[0]) fail('SKU_TAKEN', `SKU ${n} is used`, { sku: n });
          await reserveSku(ctx, tx, n, id);
          patch.sku = n; patch.cat = catOf(n); patch.num = numOf(n);
        }
        if (!Object.keys(patch).length) return p;
        patch.updated_at = ctx.now().toISOString();
        const u = await tx.update('products', id, patch);
        if ((patch.purchase_price ?? p.purchase_price) !== p.purchase_price || (patch.sale_price ?? p.sale_price) !== p.sale_price) {
          await tx.insert('price_history', { id: ctx.ids(), product_id: id, old_purchase_price: p.purchase_price,
            new_purchase_price: u.purchase_price, old_sale_price: p.sale_price, new_sale_price: u.sale_price,
            changed_by: ctx.userId ?? null, changed_at: ctx.now().toISOString() });
        }
        await audit(ctx, tx, 'update', 'products', id, p, u);
        return u;
      });
    },

    async remove(id) {                                         // soft delete: the SKU stays reserved
      ctx.access.require('manage_stock');
      return store.transaction(async (tx) => {
        const p = await tx.get('products', id);
        if (!p || p.deleted_at) fail('UNKNOWN_PRODUCT', 'Unknown product');
        const u = await tx.update('products', id, { deleted_at: ctx.now().toISOString(), updated_at: ctx.now().toISOString() });
        await audit(ctx, tx, 'update', 'products', id, p, u);
      });
    },

    // a deleted product is only hidden: its number stays reserved and it can always come back, with its quantity and prices
    async listDeleted() {
      ctx.access.require('manage_stock');
      return store.transaction(async (tx) => (await tx.find('products', (p) => !!p.deleted_at)).sort((a, b) => skuCmp(a.sku, b.sku)));
    },
    async restore(id) {
      ctx.access.require('manage_stock');
      return store.transaction(async (tx) => {
        const p = await tx.get('products', id);
        if (!p || !p.deleted_at) fail('UNKNOWN_PRODUCT', 'Unknown product');
        await assertNameFree(tx, p.name, id);                                     // another product took the name meanwhile
        const u = await tx.update('products', id, { deleted_at: null, updated_at: ctx.now().toISOString() });
        await audit(ctx, tx, 'update', 'products', id, p, u);
        return u;
      });
    },
    // every deleted product whose name is still free comes back; the others are reported
    async restoreAll() {
      ctx.access.require('manage_stock');
      return store.transaction(async (tx) => {
        const report = { restored: 0, skipped: [] };
        for (const p of (await tx.find('products', (x) => !!x.deleted_at)).sort((a, b) => skuCmp(a.sku, b.sku))) {
          if ((await tx.find('products', (x) => !x.deleted_at && nameKey(x.name) === nameKey(p.name)))[0]) { report.skipped.push({ sku: p.sku, name: p.name, reason: 'exists' }); continue; }
          const u = await tx.update('products', p.id, { deleted_at: null, updated_at: ctx.now().toISOString() });
          await audit(ctx, tx, 'update', 'products', p.id, p, u);
          report.restored++;
        }
        return report;
      });
    },

    // manual correction of the quantity (damage, inventory count): journaled movement
    async adjustStock(id, delta, reason = 'adjustment') {
      ctx.access.require('manage_stock');
      if (!['adjustment', 'damage'].includes(reason)) fail('BAD_REASON', 'Reason must be adjustment or damage');
      const d = Number(delta) < 0 ? -parseQty(String(delta).replace('-', '')) : parseQty(delta);
      if (d === 0) fail('BAD_NUMBER', 'Nothing to adjust');
      return store.transaction(async (tx) => applyMovement(ctx, tx, { product_id: id, reason, qty_delta: d }));
    },

    // the owner corrects a quantity (inventory count): journaled as an adjustment movement
    async setQty(id, newQty) {
      ctx.access.require('manage_stock');
      const target = parseQty(newQty, 'qty');
      return store.transaction(async (tx) => {
        const p = await tx.get('products', id);
        if (!p || p.deleted_at) fail('UNKNOWN_PRODUCT', 'Unknown product');
        if (target === p.qty) return p;
        await applyMovement(ctx, tx, { product_id: id, reason: 'adjustment', qty_delta: target - p.qty });
        return tx.get('products', id);
      });
    },

    // CSV for Excel: Sku;Produit;PA;AV;Qte  (same order the paste/import expects)
    async exportCsv() {
      ctx.access.require('manage_stock');
      const cell = (v) => { const s = String(v); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      return store.transaction(async (tx) => {
        const rows = (await tx.find('products', (p) => !p.deleted_at)).sort((a, b) => skuCmp(a.sku, b.sku));
        return ['Sku;Produit;PA;AV;Qte', ...rows.map((p) => [p.sku, cell(p.name), fmtPrice(p.purchase_price), fmtPrice(p.sale_price), fmtQty(p.qty)].join(';'))].join('\r\n');
      });
    },

    // import rows (CSV / paste): blank lines ignored, same name or SKU twice -> one line kept,
    // empty prices/qty -> 0, existing products are reported, never duplicated
    async import(rows) {
      ctx.access.require('manage_stock');
      return store.transaction(async (tx) => {
        const seenNames = new Set(), seenSkus = new Set();
        const report = { created: 0, skipped: [] };
        for (const r of rows) {
          const name = String(r.name ?? '').trim();
          if (!name) continue;
          const sku = r.sku === undefined || r.sku === '' || r.sku === null ? null : String(r.sku).trim();
          if (sku && !CODE_RE.test(sku)) { report.skipped.push({ name, reason: 'bad_code' }); continue; }
          if (seenNames.has(nameKey(name)) || (sku && seenSkus.has(sku))) { report.skipped.push({ name, reason: 'duplicate_in_file' }); continue; }
          seenNames.add(nameKey(name)); if (sku) seenSkus.add(sku);
          if ((await tx.find('products', p => !p.deleted_at && nameKey(p.name) === nameKey(name)))[0]) { report.skipped.push({ name, reason: 'exists' }); continue; }
          if (sku && (await tx.find('products', p => p.sku === sku))[0]) { report.skipped.push({ name, reason: 'sku_taken' }); continue; }
          if (!sku && !/^[0-9]$/.test(String(r.cat ?? '0'))) fail('BAD_CATEGORY', 'Category is one digit 0-9');
          const wanted = sku || await nextSku(tx, String(r.cat ?? '0'));
          const t = ctx.now().toISOString();
          const cost = parsePrice(r.purchasePrice ?? 0, 'purchase price');
          const p = await tx.insert('products', { id: ctx.ids(), sku: wanted, cat: catOf(wanted), num: numOf(wanted), name, purchase_price: cost,
            sale_price: parseSalePrice(r.salePrice ?? 0, 'sale price'), qty: 0, deleted_at: null,
            origin_device: ctx.deviceId ?? null, created_at: t, updated_at: t });
          await reserveSku(ctx, tx, wanted, p.id);
          const q = parseQty(r.qty ?? 0, 'qty');
          if (q > 0) await applyMovement(ctx, tx, { product_id: p.id, reason: 'import', qty_delta: q, unit_cost: cost });
          report.created++;
        }
        await audit(ctx, tx, 'import', 'products', null, null, { created: report.created, skipped: report.skipped.length });
        return report;
      });
    },

    // search: digits = SKU only, letters = name only
    async search(text, limit = 30) {
      ctx.access.require('view_stock');
      const q = String(text ?? '').trim().toLowerCase();
      return store.transaction(async (tx) => {
        const all = (await tx.find('products', p => !p.deleted_at));
        const hit = !q ? all : /^\d+$/.test(q) ? all.filter(p => p.sku.startsWith(q)) : all.filter(p => p.name.toLowerCase().includes(q));
        return hit.sort((a, b) => skuCmp(a.sku, b.sku)).slice(0, limit);
      });
    },
  };
}

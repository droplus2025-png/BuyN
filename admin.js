// Owner reset (for tests): wipes operations, KEEPS products and their stock and cost.
// Stock is restored through 'initial' movements. SKUs stay reserved. The audit log is kept.
import { applyMovement, audit } from './post.js';
import { buildBackup, verifyBackup } from './backup.js';
import { fail } from './errors.js';

export function adminApi(ctx) {
  const { store } = ctx;
  return {
    // owner: the whole database as one file (the date of the last backup is remembered)
    async backup() {
      ctx.access.requireOwner();
      const file = buildBackup(store, { device_id: ctx.deviceId });
      await store.transaction(async (tx) => {
        const cur = await tx.get('settings', 'last_backup_at'), row = { value: file.exported_at, updated_at: ctx.now().toISOString() };
        if (cur) await tx.update('settings', 'last_backup_at', row); else await tx.insert('settings', { key: 'last_backup_at', ...row });
      });
      return file;
    },
    async lastBackupAt() { return store.transaction(async (tx) => (await tx.get('settings', 'last_backup_at'))?.value ?? null); },
    verifyBackup: (file) => { ctx.access.requireOwner(); return verifyBackup(file); },
    // replaces EVERYTHING by the content of a verified backup. The caller must log in again afterwards.
    async restoreBackup(file) {
      ctx.access.requireOwner();
      const v = await verifyBackup(file);
      if (!v.ok) fail('BACKUP_CORRUPT', 'The backup file does not add up and was refused', { problems: v.problems.slice(0, 5) });
      await store.replaceAll(file.state);
      return v.counts;
    },
    // owner: empties the whole stock (products, quantities, prices history) and frees the SKU numbers, so a list kept in Excel
    // can be imported again with the same numbers. Refused while invoices still point to products (reset the operations first).
    async resetStock() {
      ctx.access.requireOwner();
      return store.transaction(async (tx) => {
        if ((await tx.all('invoice_lines')).some((l) => l.product_id)) fail('STOCK_HAS_HISTORY', 'توجد فواتير مرتبطة بالمنتجات: صفّر العمليات أولاً');
        const n = (await tx.find('products', (p) => !p.deleted_at)).length;
        for (const t of ['stock_movements', 'price_history', 'products', 'sku_registry']) await tx.deleteAll(t);
        await audit(ctx, tx, 'reset', 'stock', null, null, { products_removed: n });
        return { products_removed: n };
      }, { allowReset: true });
    },
    async resetOperations() {
      ctx.access.requireOwner();
      return store.transaction(async (tx) => {
        const keep = (await tx.find('products', p => p.qty > 0 && !p.deleted_at)).map(p => ({ id: p.id, qty: p.qty, cost: p.purchase_price }));
        for (const t of ['invoice_settlements', 'debt_ledger', 'cash_ledger', 'stock_movements', 'price_history',
          'cash_sessions', 'invoice_lines', 'invoices', 'customers', 'suppliers']) await tx.deleteAll(t);
        for (const p of await tx.all('products')) if (p.qty !== 0) await tx.update('products', p.id, { qty: 0 });
        for (const k of keep) await applyMovement(ctx, tx, { product_id: k.id, reason: 'initial', qty_delta: k.qty, unit_cost: k.cost });
        await audit(ctx, tx, 'reset', 'operations', null, null, { products_kept: keep.length });
        return { products_kept: keep.length };
      }, { allowReset: true });
    },
  };
}

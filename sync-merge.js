// Merging what other devices did into this device. Pure function: no I/O, easy to test.
//  - ledgers (append-only): a row is inserted if absent, never replaced
//  - other tables: last writer wins, EXCEPT a row of ours that is still waiting to be sent and is newer
//  - products.qty is a cache of the ledger: recomputed from stock_movements after every merge
//  - two devices made the same SKU / the same invoice number offline: the LATER one changes (suffix -1, -2 for
//    invoices, next free number for products), and only its own device does it, so nobody renames twice
import { uniqueInvoiceNo } from './invoice-number.js';

const ms = (x) => (x ? Date.parse(x) || 0 : 0);
const laterFirst = (a, b) => (a.created_at || '').localeCompare(b.created_at || '') || String(a.id).localeCompare(String(b.id));   // > 0 when a is later

export function mergeRemote(state, rows, { dirty, deviceId, nowIso, pk, appendOnly }) {
  const applied = new Map();        // key -> [table, row]   written as "remote" (nothing to send back)
  const local = new Map();          // key -> [table, row]   our own corrections (they ARE sent)
  const settled = [];               // outbox keys the remote version replaced
  const touched = new Set();        // products whose qty must be recomputed

  for (const { t, d: row, u } of rows) {
    if (!state[t] || !row) continue;
    const id = row[pk(t)];
    if (id == null) continue;
    const k = `${t}|${id}`;
    const i = state[t].findIndex((x) => x[pk(t)] === id);
    if (appendOnly.has(t)) {
      if (i < 0) { state[t].push(row); applied.set(k, [t, row]); if (t === 'stock_movements') touched.add(row.product_id); }
      continue;
    }
    if (i >= 0 && JSON.stringify(state[t][i]) === JSON.stringify(row)) continue;       // nothing new
    const du = dirty.get(k);
    if (du && ms(du) > ms(u)) continue;                                                   // ours is newer and not sent yet
    if (i >= 0) state[t][i] = row; else state[t].push(row);
    applied.set(k, [t, row]);
    if (du) settled.push(k);
    if (t === 'products') touched.add(row.id);
  }

  if (touched.size) {
    const sums = new Map();
    for (const m of state.stock_movements) if (touched.has(m.product_id)) sums.set(m.product_id, (sums.get(m.product_id) || 0) + m.qty_delta);
    for (const p of state.products) if (touched.has(p.id)) {
      const s = sums.get(p.id) || 0;
      if (p.qty !== s) { p.qty = s; applied.set(`products|${p.id}`, ['products', p]); }
    }
  }

  // same SKU on two products
  for (const [t, row] of [...applied.values()]) {
    if (t !== 'products') continue;
    const other = state.products.find((p) => p.id !== row.id && p.sku === row.sku);
    if (!other) continue;
    const loser = laterFirst(row, other) >= 0 ? row : other;
    if (loser.origin_device !== deviceId) continue;
    const used = new Set([...state.products.map((p) => p.sku), ...state.sku_registry.map((r) => r.sku)]);
    const c = String(loser.sku)[0]; let k = 1; while (used.has(`${c}${k}`)) k++;
    const n = `${c}${k}`; loser.num = k;
    loser.sku = n; loser.updated_at = nowIso;
    const reg = { sku: n, product_id: loser.id };
    state.sku_registry.push(reg);
    applied.delete(`products|${loser.id}`);
    local.set(`products|${loser.id}`, ['products', loser]);
    local.set(`sku_registry|${n}`, ['sku_registry', reg]);
  }

  // same invoice number on two invoices
  for (const [t, row] of [...applied.values()]) {
    if (t !== 'invoices') continue;
    const other = state.invoices.find((x) => x.id !== row.id && x.invoice_no === row.invoice_no);
    if (!other) continue;
    const loser = laterFirst(row, other) >= 0 ? row : other;
    if (loser.device_id !== deviceId) continue;
    loser.invoice_no = uniqueInvoiceNo(state.invoices.map((x) => x.invoice_no), String(loser.invoice_no).split('-')[0]);
    loser.updated_at = nowIso;
    applied.delete(`invoices|${loser.id}`);
    local.set(`invoices|${loser.id}`, ['invoices', loser]);
  }

  return { applied: [...applied.values()], local: [...local.values()], settled };
}

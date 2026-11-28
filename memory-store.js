// Local store with real transactions: either everything is written, or nothing.
// Same async API as the future IndexedDB store (find/get/insert/update inside transaction()).
// Ledgers are append-only; invoices are frozen except a few harmless fields.
import { fail } from './errors.js';
import { mergeRemote } from './sync-merge.js';

const PK = { settings: 'key', sku_registry: 'sku' };           // every other table uses `id`
export const TABLES = ['app_users', 'settings', 'products', 'sku_registry', 'price_history',
  'customers', 'suppliers', 'invoices', 'invoice_lines', 'stock_movements', 'cash_ledger',
  'debt_ledger', 'invoice_settlements', 'cash_sessions', 'audit_log'];
const APPEND_ONLY = new Set(['invoice_lines', 'stock_movements', 'cash_ledger', 'debt_ledger',
  'invoice_settlements', 'price_history', 'audit_log', 'sku_registry']);
const INVOICE_MUTABLE = new Set(['is_modified', 'sent_at', 'note', 'updated_at']);

const clone = (x) => (x === undefined ? x : structuredClone(x));
const pk = (t) => PK[t] || 'id';

export function createMemoryStore(initial, { persist } = {}) {
  let state = Object.fromEntries(TABLES.map(t => [t, []]));
  if (initial) for (const t of TABLES) if (initial[t]) state[t] = clone(initial[t]);
  let queue = Promise.resolve();
  const listeners = [];
  // table -> Map(primary key -> live row), built on first use: reading a row by its key is O(1) instead of scanning the table
  let idx = {};
  const index = (t) => (idx[t] ||= new Map(state[t].map((r) => [r[pk(t)], r])));

  function makeTx(opts) {
    const before = [];
    const undo = [];                                            // how to put everything back if the operation fails (no copy of the database)
    const touched = new Map();                                  // `${table}|${pk}` -> [table, pk]
    const cleared = new Set();
    const touch = (t, id) => touched.set(`${t}|${id}`, [t, id]);
    const tx = {
      beforeCommit: (fn) => { before.push(fn); },
      async get(t, id) { return clone(index(t).get(id)); },
      async find(t, pred = () => true) { return state[t].filter(pred).map(clone); },
      async all(t) { return state[t].map(clone); },
      async column(t, key) { return state[t].map((r) => r[key]); },      // one field of every row, without copying the rows
      async insert(t, row) {
        const id = row[pk(t)];
        if (index(t).has(id)) fail('DUPLICATE_ID', `${t}: duplicate ${pk(t)}`, { id });
        const r = clone(row);
        state[t].push(r); index(t).set(id, r);
        undo.push(() => { state[t].pop(); idx[t]?.delete(id); });
        touch(t, id);
        return clone(row);
      },
      async update(t, id, patch) {
        if (APPEND_ONLY.has(t)) fail('APPEND_ONLY', `${t} is append-only`);
        const r = index(t).get(id);
        if (!r) fail('NOT_FOUND', `${t}: ${id} not found`);
        if (t === 'invoices') for (const k of Object.keys(patch)) if (!INVOICE_MUTABLE.has(k)) fail('INVOICE_FROZEN', `Invoice field ${k} is frozen`);
        if (t === 'cash_sessions' && r.closed_at) fail('SESSION_CLOSED', 'A closed cash session cannot change');
        const old = Object.keys(patch).map((k) => [k, k in r, r[k]]);
        Object.assign(r, clone(patch));
        undo.push(() => { for (const [k, had, v] of old) { if (had) r[k] = v; else delete r[k]; } });
        touch(t, id);
        return clone(r);
      },
      async deleteAll(t) {                                       // only for the owner reset
        if (!opts.allowReset) fail('APPEND_ONLY', 'Deleting is forbidden');
        const prev = state[t];
        state[t] = []; idx[t] = null;
        undo.push(() => { state[t] = prev; idx[t] = null; });
        cleared.add(t);
        for (const k of [...touched.keys()]) if (k.startsWith(`${t}|`)) touched.delete(k);
      },
    };
    tx._before = before;
    tx._rollback = () => { for (let i = undo.length - 1; i >= 0; i--) undo[i](); };
    tx._changes = () => [
      ...[...cleared].map(table => ({ op: 'clear', table })),
      ...[...touched.values()].map(([table, id]) => ({ op: 'put', table, row: clone(index(table).get(id)) })),
    ];
    return tx;
  }

  // serialised: two operations never interleave
  const serial = (run) => { const p = queue.then(run, run); queue = p.catch(() => {}); return p; };

  return {
    // either everything is written, or nothing (memory AND disk)
    transaction(fn, opts = {}) {
      return serial(async () => {
        const tx = makeTx(opts);
        try {
          const result = await fn(tx);
          for (const check of tx._before) await check(tx);       // consistency checks before commit
          if (persist) { const ch = tx._changes(); if (ch.length) await persist(ch); }   // durable BEFORE we answer
          listeners.forEach(l => l(state));
          return result;
        } catch (e) {
          tx._rollback();                                        // rollback: nothing was written
          throw e;
        }
      });
    },
    // restore a backup: everything replaced in ONE step (memory and disk), or nothing
    replaceAll(newState) {
      return serial(async () => {
        const snap = state;
        try {
          state = Object.fromEntries(TABLES.map(t => [t, clone(newState[t] || [])])); idx = {};
          if (persist) await persist([{ op: 'wipe' }, ...TABLES.flatMap(table => state[table].map(row => ({ op: 'put', table, row })))]);
          listeners.forEach(l => l(state));
        } catch (e) { state = snap; idx = {}; throw e; }
      });
    },
    // rows coming from other devices (sync): merged in ONE serialised step, written to disk as "remote" (not re-sent),
    // our own corrections (renamed duplicate SKU / invoice number) are written as normal changes (they get sent)
    applyRemote(rows, dirty, { deviceId, now = () => new Date() } = {}) {
      return serial(async () => {
        // rows we already hold unchanged are dropped FIRST (the sync re-reads the latest rows every time on purpose): usually nothing is left to do
        const fresh = rows.filter(({ t, d: row }) => {
          if (!state[t] || !row || row[pk(t)] == null) return false;
          const cur = index(t).get(row[pk(t)]);
          return !cur || (!APPEND_ONLY.has(t) && JSON.stringify(cur) !== JSON.stringify(row));
        });
        if (!fresh.length) return { applied: 0, local: 0, settled: [] };
        // copy only the tables this merge can change (rows of append-only tables are never changed in place)
        const snapT = new Set(fresh.map((x) => x.t));
        if (snapT.has('stock_movements')) snapT.add('products');
        if (snapT.has('products')) snapT.add('sku_registry');
        const snap = {};
        for (const t of snapT) snap[t] = APPEND_ONLY.has(t) ? state[t].slice() : state[t].map(clone);
        try {
          const r = mergeRemote(state, fresh, { dirty, deviceId, nowIso: now().toISOString(), pk, appendOnly: APPEND_ONLY });
          for (const t of snapT) idx[t] = null;
          const put = (list) => list.map(([table, row]) => ({ op: 'put', table, row: clone(row) }));
          if (persist) {
            if (r.applied.length) await persist(put(r.applied), { remote: true });
            if (r.local.length) await persist(put(r.local));
          }
          if (r.applied.length || r.local.length) listeners.forEach(l => l(state));
          return { applied: r.applied.length, local: r.local.length, settled: r.settled };
        } catch (e) { Object.assign(state, snap); for (const t of snapT) idx[t] = null; throw e; }
      });
    },
    counts() { return Object.fromEntries(TABLES.map((t) => [t, state[t].length])); },
    peek(t, id) { return state[t] ? clone(index(t).get(id)) : undefined; },
    onCommit(fn) { listeners.push(fn); },
    export() { return clone(state); },
  };
}

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

  function makeTx(opts) {
    const before = [];
    const touched = new Map();                                  // `${table}|${pk}` -> [table, pk]
    const cleared = new Set();
    const touch = (t, id) => touched.set(`${t}|${id}`, [t, id]);
    const tx = {
      beforeCommit: (fn) => { before.push(fn); },
      async get(t, id) { return clone(state[t].find(r => r[pk(t)] === id)); },
      async find(t, pred = () => true) { return state[t].filter(pred).map(clone); },
      async all(t) { return state[t].map(clone); },
      async insert(t, row) {
        if (state[t].some(r => r[pk(t)] === row[pk(t)])) fail('DUPLICATE_ID', `${t}: duplicate ${pk(t)}`, { id: row[pk(t)] });
        state[t].push(clone(row));
        touch(t, row[pk(t)]);
        return clone(row);
      },
      async update(t, id, patch) {
        if (APPEND_ONLY.has(t)) fail('APPEND_ONLY', `${t} is append-only`);
        const r = state[t].find(x => x[pk(t)] === id);
        if (!r) fail('NOT_FOUND', `${t}: ${id} not found`);
        if (t === 'invoices') for (const k of Object.keys(patch)) if (!INVOICE_MUTABLE.has(k)) fail('INVOICE_FROZEN', `Invoice field ${k} is frozen`);
        if (t === 'cash_sessions' && r.closed_at) fail('SESSION_CLOSED', 'A closed cash session cannot change');
        Object.assign(r, clone(patch));
        touch(t, id);
        return clone(r);
      },
      async deleteAll(t) {                                       // only for the owner reset
        if (!opts.allowReset) fail('APPEND_ONLY', 'Deleting is forbidden');
        state[t] = [];
        cleared.add(t);
        for (const k of [...touched.keys()]) if (k.startsWith(`${t}|`)) touched.delete(k);
      },
    };
    tx._before = before;
    tx._changes = () => [
      ...[...cleared].map(table => ({ op: 'clear', table })),
      ...[...touched.values()].map(([table, id]) => ({ op: 'put', table, row: clone(state[table].find(r => r[pk(table)] === id)) })),
    ];
    return tx;
  }

  return {
    // serialised: two operations never interleave
    transaction(fn, opts = {}) {
      const run = async () => {
        const snap = clone(state);
        try {
          const tx = makeTx(opts);
          const result = await fn(tx);
          for (const check of tx._before) await check(tx);       // consistency checks before commit
          if (persist) { const ch = tx._changes(); if (ch.length) await persist(ch); }   // durable BEFORE we answer
          listeners.forEach(l => l(state));
          return result;
        } catch (e) {
          state = snap;                                          // rollback: nothing was written
          throw e;
        }
      };
      const p = queue.then(run, run);
      queue = p.catch(() => {});
      return p;
    },
    // restore a backup: everything replaced in ONE step (memory and disk), or nothing
    replaceAll(newState) {
      const run = async () => {
        const snap = clone(state);
        try {
          state = Object.fromEntries(TABLES.map(t => [t, clone(newState[t] || [])]));
          if (persist) await persist([{ op: 'wipe' }, ...TABLES.flatMap(table => state[table].map(row => ({ op: 'put', table, row })))]);
          listeners.forEach(l => l(state));
        } catch (e) { state = snap; throw e; }
      };
      const p = queue.then(run, run);
      queue = p.catch(() => {});
      return p;
    },
    // rows coming from other devices (sync): merged in ONE serialised step, written to disk as "remote" (not re-sent),
    // our own corrections (renamed duplicate SKU / invoice number) are written as normal changes (they get sent)
    applyRemote(rows, dirty, { deviceId, now = () => new Date() } = {}) {
      const run = async () => {
        const snap = clone(state);
        try {
          const r = mergeRemote(state, rows, { dirty, deviceId, nowIso: now().toISOString(), pk, appendOnly: APPEND_ONLY });
          const put = (list) => list.map(([table, row]) => ({ op: 'put', table, row: clone(row) }));
          if (persist) {
            if (r.applied.length) await persist(put(r.applied), { remote: true });
            if (r.local.length) await persist(put(r.local));
          }
          if (r.applied.length || r.local.length) listeners.forEach(l => l(state));
          return { applied: r.applied.length, local: r.local.length, settled: r.settled };
        } catch (e) { state = snap; throw e; }
      };
      const p = queue.then(run, run);
      queue = p.catch(() => {});
      return p;
    },
    peek(t, id) { return clone(state[t]?.find(r => r[pk(t)] === id)); },
    onCommit(fn) { listeners.push(fn); },
    export() { return clone(state); },
  };
}

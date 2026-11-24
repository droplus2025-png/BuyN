// Durable storage in IndexedDB. The engine keeps everything in memory (fast) and calls persist()
// with the changed rows only; the answer is given AFTER IndexedDB confirmed the write (one transaction).
const STORE = 'rows';
const META = 'meta';        // sync bookkeeping: the outbox (rows not sent yet), the pull cursor, flags

function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function done(tx) { return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('IndexedDB aborted')); }); }

export async function openPersist(dbName = 'pos-db') {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open(dbName, 2);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE)) {
        const s = r.result.createObjectStore(STORE, { keyPath: 'k' });
        s.createIndex('table', 'table');
      }
      if (!r.result.objectStoreNames.contains(META)) r.result.createObjectStore(META, { keyPath: 'k' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});     // ask the browser not to evict our data

  return {
    async load() {
      const all = await req(db.transaction(STORE).objectStore(STORE).getAll());
      const state = {};
      for (const { table, row } of all) (state[table] ||= []).push(row);
      return state;
    },
    // every LOCAL change is also written to the outbox in the same transaction (nothing can be saved without being queued)
    async persist(changes, { remote = false } = {}) {
      const tx = db.transaction([STORE, META], 'readwrite');
      const os = tx.objectStore(STORE), ms = tx.objectStore(META);
      const u = new Date().toISOString();
      for (const c of changes) {
        if (c.op === 'wipe') { os.clear(); ms.delete(IDBKeyRange.bound('ob|', 'ob|\uffff')); }
        else if (c.op === 'clear') {
          const cur = os.index('table').openKeyCursor(IDBKeyRange.only(c.table));
          cur.onsuccess = () => { const k = cur.result; if (k) { os.delete(k.primaryKey); k.continue(); } };
          ms.delete(IDBKeyRange.bound(`ob|${c.table}|`, `ob|${c.table}|\uffff`));
        } else {
          const pk = c.table === 'settings' ? c.row.key : c.table === 'sku_registry' ? c.row.sku : c.row.id;
          os.put({ k: `${c.table}|${pk}`, table: c.table, row: c.row });
          if (!remote) ms.put({ k: `ob|${c.table}|${pk}`, table: c.table, pk, u });
        }
      }
      await done(tx);
    },
    meta: {
      async outbox(limit = 200) { return (await req(db.transaction(META).objectStore(META).getAll(IDBKeyRange.bound('ob|', 'ob|\uffff'), limit))); },
      async outboxMap() { const all = await req(db.transaction(META).objectStore(META).getAll(IDBKeyRange.bound('ob|', 'ob|\uffff'))); return new Map(all.map((e) => [`${e.table}|${e.pk}`, e.u])); },
      async outboxCount() { return req(db.transaction(META).objectStore(META).count(IDBKeyRange.bound('ob|', 'ob|\uffff'))); },
      // sent: forget an entry only if it was not changed again in the meantime
      async ack(entries) {
        const tx = db.transaction(META, 'readwrite'), ms = tx.objectStore(META);
        for (const e of entries) { const g = ms.get(e.k); g.onsuccess = () => { if (g.result && g.result.u === e.u) ms.delete(e.k); }; }
        await done(tx);
      },
      async drop(keys) { const tx = db.transaction(META, 'readwrite'); for (const k of keys) tx.objectStore(META).delete(`ob|${k}`); await done(tx); },
      async markAll(items) { const tx = db.transaction(META, 'readwrite'); for (const i of items) tx.objectStore(META).put({ k: `ob|${i.table}|${i.pk}`, table: i.table, pk: i.pk, u: i.u }); await done(tx); },
      async get(key, dflt = null) { const r = await req(db.transaction(META).objectStore(META).get(`m|${key}`)); return r ? r.v : dflt; },
      async set(key, v) { const tx = db.transaction(META, 'readwrite'); tx.objectStore(META).put({ k: `m|${key}`, v }); await done(tx); },
    },
    async wipeAll() { const tx = db.transaction([STORE, META], 'readwrite'); tx.objectStore(STORE).clear(); tx.objectStore(META).clear(); await done(tx); },
  };
}

// Background synchronisation. Offline-first: the program never waits for the network.
//   push : rows waiting in the outbox -> server        pull : what other devices did -> merged here
// Runs by itself: when the connection comes back, when the app becomes visible, every 30 s, 2 s after a local change.
class SyncError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }          // 'network' | 'badcode' | 'server'
}

// ---------------------------------------------------------------- transport (Supabase REST: two RPC functions)
export function supabaseTransport({ url, key, fetchFn = (...a) => fetch(...a) }) {
  async function call(fn, body) {
    let r;
    try {
      r = await fetchFn(`${url}/rest/v1/rpc/${fn}`, { method: 'POST',
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) { throw new SyncError('network', e.message || 'network'); }
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      if (txt.includes('BAD_LINK_CODE')) throw new SyncError('badcode', 'BAD_LINK_CODE');
      throw new SyncError(r.status >= 500 || r.status === 0 ? 'network' : 'server', `${r.status} ${txt.slice(0, 200)}`);
    }
    return r.json();
  }
  return {
    push: (code, device, rows) => call('sync_push', { p_code: code, p_device: device, p_rows: rows }),
    pull: (code, device, since, limit) => call('sync_pull', { p_code: code, p_device: device, p_since: since, p_limit: limit }),
  };
}

// ---------------------------------------------------------------- the link code lives on THIS device only
const LINK_KEY = 'buyn_link_code';
export const linkCode = {
  get: () => { try { return localStorage.getItem(LINK_KEY) || ''; } catch { return ''; } },
  set: (c) => localStorage.setItem(LINK_KEY, String(c).trim()),
  clear: () => localStorage.removeItem(LINK_KEY),
};

const PULL_PAGE = 500;
const OVERLAP = 100;          // re-read the last rows each time: a row committed late on the server is never missed (merging twice is harmless)

export function createSync({ store, meta, transport, deviceId, getCode = linkCode.get, now = () => new Date(), intervalMs = 30000 }) {
  let st = { state: 'off', pending: 0, last: null, error: null };
  const listeners = [];
  let running = null, again = false, timer = null, debounce = null, started = false;
  const set = (patch) => { st = { ...st, ...patch }; listeners.forEach((l) => l(st)); };
  const refreshPending = async () => { st.pending = await meta.outboxCount(); };

  async function pushAll(code) {
    for (let i = 0; i < 100; i++) {
      const ob = await meta.outbox(200);
      if (!ob.length) return;
      const rows = [];
      for (const e of ob) {
        const row = store.peek(e.table, e.pk);
        if (row) rows.push({ t: e.table, k: String(e.pk), d: row, u: e.u });
      }
      if (rows.length) await transport.push(code, deviceId, rows);
      await meta.ack(ob);
    }
  }
  async function pullAll(code) {
    let local = 0;
    for (let i = 0; i < 400; i++) {
      const cursor = await meta.get('cursor', 0);
      const res = await transport.pull(code, deviceId, Math.max(0, cursor - OVERLAP), PULL_PAGE);
      const rows = res.rows || [];
      if (rows.length) {
        const r = await store.applyRemote(rows, await meta.outboxMap(), { deviceId, now });
        if (r.settled.length) await meta.drop(r.settled);
        local += r.local;
      }
      if (res.last > cursor) await meta.set('cursor', res.last);
      if (rows.length < PULL_PAGE) break;
    }
    return local;
  }

  async function cycle(code) {
    for (let round = 0; round < 5; round++) {
      await pushAll(code);
      const fixes = await pullAll(code);
      if (!fixes) break;                       // our own corrections (renamed duplicates) must go out too
    }
  }

  function syncNow() {
    if (running) { again = true; return running; }
    const code = getCode();
    if (!code) { set({ state: 'off', pending: st.pending }); return Promise.resolve(st); }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { refreshPending().then(() => set({ state: 'offline' })); return Promise.resolve(st); }
    running = (async () => {
      set({ state: 'syncing', error: null });
      try {
        await cycle(code);
        await refreshPending();
        set({ state: 'idle', last: now().toISOString() });
      } catch (e) {
        await refreshPending().catch(() => {});
        if (e.kind === 'badcode') set({ state: 'badcode', error: 'رمز الربط غير صحيح' });
        else if (e.kind === 'network') set({ state: 'offline', error: null });
        else set({ state: 'error', error: e.message });
      } finally {
        running = null;
        if (again) { again = false; setTimeout(syncNow, 1500); }
      }
      return st;
    })();
    return running;
  }

  function onLocalChange() {                   // 2 s after the last local change, if something waits to be sent
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      const n = await meta.outboxCount().catch(() => 0);
      if (st.pending !== n) set({ pending: n });
      if (n && getCode()) syncNow();
    }, 2000);
  }

  return {
    get status() { return st; },
    onStatus(fn) { listeners.push(fn); fn(st); },
    syncNow,
    start() {
      if (started) return; started = true;
      store.onCommit(onLocalChange);
      if (typeof window !== 'undefined') {
        window.addEventListener('online', syncNow);
        window.addEventListener('offline', () => set({ state: getCode() ? 'offline' : 'off' }));
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
      }
      timer = setInterval(syncNow, intervalMs);
      refreshPending().then(syncNow);
    },
    stop() { clearInterval(timer); clearTimeout(debounce); started = false; },

    // Is anything on the server (written by OTHER devices)?  Also proves the link code is right.
    async probe(code) { const r = await transport.pull(code, deviceId, 0, 1); return (r.rows || []).length > 0; },

    // The main device (already has data) joins: everything it has is queued and sent.
    async linkMain(code) {
      const hadServerData = await this.probe(code);                           // throws 'badcode' if wrong
      if (hadServerData && !(await meta.get('linked', false))) throw new SyncError('server', 'SERVER_NOT_EMPTY');
      linkCode.set(code);
      await meta.set('linked', true);
      const all = store.export(), items = [], t0 = now().toISOString();
      for (const [table, rows] of Object.entries(all)) for (const row of rows) {
        items.push({ table, pk: table === 'settings' ? row.key : table === 'sku_registry' ? row.sku : row.id, u: row.updated_at || row.created_at || t0 });
      }
      await meta.markAll(items);
      await refreshPending();
      return syncNow();
    },
    // A new empty device joins: it downloads the whole shop.
    async linkNew(code) {
      if (!(await this.probe(code))) throw new SyncError('server', 'SERVER_EMPTY');
      linkCode.set(code);
      await meta.set('linked', true);
      await meta.set('cursor', 0);
      return syncNow();
    },
    async unlink() { linkCode.clear(); await meta.set('linked', false); set({ state: 'off', error: null }); },
  };
}

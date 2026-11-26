// Background synchronisation. Offline-first: the program never waits for the network.
//   ONE main device + linked devices. Each device has its OWN key (given when it joins with a one-time link code).
//   The main device makes link codes, sees the devices and disconnects any of them (lock or wipe).
//   push : rows waiting in the outbox -> server        pull : what other devices did -> merged here
// Runs by itself: when the connection comes back, when the app becomes visible, every 30 s, 2 s after a local change.
export class SyncError extends Error {
  constructor(kind, message, extra = {}) { super(message); this.kind = kind; Object.assign(this, extra); }
  // kinds: network | server | revoked(mode) | badtoken | notmain | badpair | badkey | keynotset | throttled | taken | notfound
}
// text sent back by the SQL functions -> kind
const KNOWN = [['DEVICE_REVOKED_WIPE', 'revoked', { mode: 'wipe' }], ['DEVICE_REVOKED_LOCK', 'revoked', { mode: 'lock' }], ['BAD_TOKEN', 'badtoken'],
  ['NOT_MAIN', 'notmain'], ['BAD_PAIR_CODE', 'badpair'], ['SETUP_KEY_BAD', 'badkey'], ['SETUP_KEY_NOT_SET', 'keynotset'],
  ['TOO_MANY_ATTEMPTS', 'throttled'], ['DEVICE_TAKEN', 'taken'], ['NOT_FOUND', 'notfound']];
const toError = (txt) => { const k = KNOWN.find(([c]) => String(txt).includes(c)); return k ? new SyncError(k[1], k[0], k[2]) : null; };

// ---------------------------------------------------------------- transport (Supabase REST: one RPC call per function of sync_schema.sql)
export function supabaseTransport({ url, key, fetchFn = (...a) => fetch(...a) }) {
  // a publishable key is not a JWT: it goes in `apikey` only. A legacy (JWT) anon key is also sent as Bearer.
  const headers = { apikey: key, 'Content-Type': 'application/json', ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}) };
  async function call(fn, body) {
    let r;
    try { r = await fetchFn(`${url}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(body) }); }
    catch (e) { throw new SyncError('network', e.message || 'network'); }
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw toError(txt) || new SyncError(r.status >= 500 || r.status === 0 ? 'network' : 'server', `${r.status} ${txt.slice(0, 200)}`);
    }
    const res = await r.json();
    if (res && res.error) throw toError(res.error) || new SyncError('server', String(res.error));     // refusals that must stay counted are returned, not raised
    return res;
  }
  return {
    createShop: (setupKey, device, name) => call('create_shop', { p_setup_key: setupKey, p_device: device, p_name: name }),
    join: (code, device, name) => call('join_shop', { p_code: code, p_device: device, p_name: name }),
    recover: (setupKey, shop, device, name) => call('recover_main', { p_setup_key: setupKey, p_shop: shop, p_device: device, p_name: name }),
    pairingCode: (device, token) => call('create_pairing_code', { p_device: device, p_token: token }),
    devices: (device, token) => call('list_devices', { p_device: device, p_token: token }),
    revoke: (device, token, target, mode) => call('revoke_device', { p_device: device, p_token: token, p_target: target, p_mode: mode }),
    ackRevoked: (device, token) => call('ack_revoked', { p_device: device, p_token: token }),
    push: (device, token, rows) => call('sync_push', { p_device: device, p_token: token, p_rows: rows }),
    pull: (device, token, since, limit) => call('sync_pull', { p_device: device, p_token: token, p_since: since, p_limit: limit }),
  };
}

// ---------------------------------------------------------------- the device key lives on THIS device only: { token, role: 'main'|'linked', shop_id }
const AUTH_KEY = 'buyn_sync_auth';
export const deviceAuth = {
  get: () => { try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch { return null; } },
  set: (a) => localStorage.setItem(AUTH_KEY, JSON.stringify(a)),
  clear: () => localStorage.removeItem(AUTH_KEY),
};

const PULL_PAGE = 500;
const OVERLAP = 100;          // re-read the last rows each time: a row committed late on the server is never missed (merging twice is harmless)

export function createSync({ store, meta, transport, deviceId, auth = deviceAuth, onRevoked, now = () => new Date(), intervalMs = 30000 }) {
  let st = { state: 'off', pending: 0, last: null, error: null };
  const listeners = [];
  let running = null, again = false, timer = null, debounce = null, started = false;
  const set = (patch) => { st = { ...st, ...patch }; listeners.forEach((l) => l(st)); };
  const refreshPending = async () => { st.pending = await meta.outboxCount(); };
  const need = () => { const a = auth.get(); if (!a) throw new SyncError('badtoken', 'NOT_LINKED'); return a; };

  async function pushAll(token) {
    for (let i = 0; i < 100; i++) {
      const ob = await meta.outbox(200);
      if (!ob.length) return;
      const rows = [];
      for (const e of ob) {
        const row = store.peek(e.table, e.pk);
        if (row) rows.push({ t: e.table, k: String(e.pk), d: row, u: e.u });
      }
      if (rows.length) await transport.push(deviceId, token, rows);
      await meta.ack(ob);
    }
  }
  async function pullAll(token) {
    let local = 0;
    for (let i = 0; i < 400; i++) {
      const cursor = await meta.get('cursor', 0);
      const res = await transport.pull(deviceId, token, Math.max(0, cursor - OVERLAP), PULL_PAGE);
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
  async function cycle(token) {
    for (let round = 0; round < 5; round++) {
      await pushAll(token);
      const fixes = await pullAll(token);
      if (!fixes) break;                       // our own corrections (renamed duplicates) must go out too
    }
  }

  function syncNow() {
    if (running) { again = true; return running; }
    const a = auth.get();
    if (!a) { set({ state: 'off', pending: st.pending }); return Promise.resolve(st); }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { refreshPending().then(() => set({ state: 'offline' })); return Promise.resolve(st); }
    running = (async () => {
      set({ state: 'syncing', error: null });
      try {
        await cycle(a.token);
        await refreshPending();
        set({ state: 'idle', last: now().toISOString() });
      } catch (e) {
        await refreshPending().catch(() => {});
        if (e.kind === 'revoked') { set({ state: 'revoked', error: e.mode }); onRevoked?.(e.mode); }     // the owner disconnected this device
        else if (e.kind === 'badtoken') set({ state: 'badcode', error: 'مفتاح الجهاز غير صالح' });
        else if (e.kind === 'network') set({ state: 'offline', error: null });
        else set({ state: 'error', error: e.message });
      } finally {
        running = null;
        if (again && st.state !== 'revoked') { again = false; setTimeout(syncNow, 1500); }
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
      if (n && auth.get()) syncNow();
    }, 2000);
  }

  // everything this device holds goes to the outbox (the server keeps the newest version of each row)
  async function queueAll() {
    const all = store.export(), items = [], t0 = now().toISOString();
    for (const [table, rows] of Object.entries(all)) for (const row of rows) {
      items.push({ table, pk: table === 'settings' ? row.key : table === 'sku_registry' ? row.sku : row.id, u: row.updated_at || row.created_at || t0 });
    }
    await meta.markAll(items);
    await refreshPending();
  }
  // the server gave this device its key: keep it, start from the beginning of the shop history
  async function accept(r, upload) {
    auth.set({ token: r.token, role: r.role, shop_id: r.shop_id });
    await meta.set('linked', true);
    await meta.set('cursor', 0);
    if (upload) await queueAll();
    return syncNow();
  }

  return {
    get status() { return st; },
    get role() { return auth.get()?.role ?? null; },
    get shopId() { return auth.get()?.shop_id ?? null; },
    onStatus(fn) { listeners.push(fn); fn(st); },
    syncNow,
    start() {
      if (started) return; started = true;
      store.onCommit(onLocalChange);
      if (typeof window !== 'undefined') {
        window.addEventListener('online', syncNow);
        window.addEventListener('offline', () => set({ state: auth.get() ? 'offline' : 'off' }));
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
      }
      timer = setInterval(syncNow, intervalMs);
      refreshPending().then(syncNow);
    },
    stop() { clearInterval(timer); clearTimeout(debounce); started = false; },

    // ---- this device becomes the MAIN device of a new shop (needs the private setup key); all its data goes up
    async makeMain(setupKey, name) {
      if (auth.get()) throw new SyncError('server', 'ALREADY_LINKED');
      return accept(await transport.createShop(setupKey, deviceId, name), true);
    },
    // ---- this device joins a shop with the one-time link code made by the main device
    async join(code, name) {
      if (auth.get()) throw new SyncError('server', 'ALREADY_LINKED');
      return accept(await transport.join(code, deviceId, name), true);
    },
    // ---- the main device was lost: a new device takes its place with the setup key (the old one is wiped); the shop is downloaded
    async recover(setupKey, shopId, name) {
      if (auth.get()) throw new SyncError('server', 'ALREADY_LINKED');
      return accept(await transport.recover(setupKey, shopId, deviceId, name), false);
    },
    // ---- main device only
    pairingCode: () => transport.pairingCode(deviceId, need().token),
    devices: () => transport.devices(deviceId, need().token),
    revoke: (target, mode) => transport.revoke(deviceId, need().token, target, mode),
    // ---- a disconnected device: tell the server its data was erased (false when offline: the owner keeps seeing "not erased yet")
    async confirmWipe() { try { await transport.ackRevoked(deviceId, need().token); return true; } catch { return false; } },
    async unlink() { auth.clear(); await meta.set('linked', false); set({ state: 'off', error: null }); },
  };
}

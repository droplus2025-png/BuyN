import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, createMemoryStore, createAuth } from './index.js';
import { createSync } from './sync.js';

// ---- a fake server that behaves like sync_schema.sql (devices with their own keys, link codes, disconnection)
const APPEND = new Set(['invoice_lines', 'stock_movements', 'cash_ledger', 'debt_ledger', 'invoice_settlements', 'price_history', 'audit_log', 'sku_registry']);
const refuse = (kind, extra = {}) => Object.assign(new Error(kind), { kind, ...extra });
function fakeServer(setupKey = 'my-setup-key') {
  const rows = new Map(), devs = new Map(), codes = new Map(); let seq = 0, tok = 0, shops = 0, wrong = 0;
  const auth = (id, token, allowRevoked = false) => {
    const d = devs.get(id);
    if (!d || d.token !== token) throw refuse('badtoken');
    if (d.status === 'revoked' && !allowRevoked) throw refuse('revoked', { mode: d.mode });
    return d;
  };
  const main = (id, token) => { const d = auth(id, token); if (d.role !== 'main') throw refuse('notmain'); return d; };
  const key = (k) => { if (wrong >= 10) throw refuse('throttled'); if (k !== setupKey) { wrong++; throw refuse('badkey'); } };
  return {
    rows, devs,
    transport: {
      async createShop(k, id, name) { key(k); if (devs.has(id)) throw refuse('taken'); const shop = `shop${++shops}`, token = `t${++tok}`; devs.set(id, { id, shop, name, role: 'main', status: 'active', token }); return { shop_id: shop, token, role: 'main' }; },
      async pairingCode(id, token) { const d = main(id, token); const code = String(10000000 + codes.size); codes.set(code, { shop: d.shop, used: false }); return { code }; },
      async join(code, id, name) {
        if (wrong >= 10) throw refuse('throttled');
        const c = codes.get(String(code).replace(/\D/g, ''));
        if (!c || c.used) { wrong++; throw refuse('badpair'); }
        const old = devs.get(id);
        if (old && (old.shop !== c.shop || old.status === 'active')) throw refuse('taken');
        const token = `t${++tok}`; devs.set(id, { id, shop: c.shop, name, role: 'linked', status: 'active', token }); c.used = true;
        return { shop_id: c.shop, token, role: 'linked' };
      },
      async recover(k, shop, id, name) {
        key(k);
        for (const d of devs.values()) if (d.shop === shop && d.role === 'main' && d.id !== id) { d.status = 'revoked'; d.mode = 'wipe'; }
        const token = `t${++tok}`; devs.set(id, { id, shop, name, role: 'main', status: 'active', token });
        return { shop_id: shop, token, role: 'main' };
      },
      async devices(id, token) { const d = main(id, token); return [...devs.values()].filter((x) => x.shop === d.shop).map(({ token: _t, ...x }) => x); },
      async revoke(id, token, target, mode) {
        const d = main(id, token);
        if (target === id) throw Object.assign(new Error('SELF_REVOKE'), { kind: 'server' });
        const t = devs.get(target); if (!t || t.shop !== d.shop) throw refuse('notfound');
        Object.assign(t, { status: 'revoked', mode, wiped: false });
        return { ok: true };
      },
      async ackRevoked(id, token) { const d = auth(id, token, true); d.wiped = true; return { ok: true }; },
      async push(id, token, list) {
        const d = auth(id, token);
        for (const r of list) {
          const k = `${d.shop}|${r.t}|${r.k}`, cur = rows.get(k);
          if (!cur) rows.set(k, { ...r, shop: d.shop, dev: id, seq: ++seq });
          else if (!APPEND.has(r.t) && Date.parse(cur.u) <= Date.parse(r.u)) rows.set(k, { ...r, shop: d.shop, dev: id, seq: ++seq });
        }
        return { ok: true };
      },
      async pull(id, token, since, limit) {
        const d = auth(id, token);
        const out = [...rows.values()].filter((r) => r.shop === d.shop && r.seq > since && r.dev !== id).sort((a, b) => a.seq - b.seq).slice(0, limit);
        return { rows: out.map((r) => ({ t: r.t, k: r.k, d: r.d, u: r.u, s: r.seq })), last: out.length ? out[out.length - 1].seq : since };
      },
    },
  };
}
const memAuth = () => { let a = null; return { get: () => a, set: (x) => { a = x; }, clear: () => { a = null; } }; };
// ---- a fake disk with the same outbox rules as idb-persist.js
function memPersist() {
  const ob = new Map(), m = new Map();
  const pkOf = (t, r) => (t === 'settings' ? r.key : t === 'sku_registry' ? r.sku : r.id);
  return {
    persist: async (ch, { remote = false } = {}) => { for (const c of ch) if (c.op === 'put' && !remote) ob.set(`${c.table}|${pkOf(c.table, c.row)}`, { k: `ob|${c.table}|${pkOf(c.table, c.row)}`, table: c.table, pk: pkOf(c.table, c.row), u: new Date().toISOString() }); },
    meta: {
      async outbox(n = 200) { return [...ob.values()].slice(0, n); }, async outboxMap() { return new Map([...ob.values()].map((e) => [`${e.table}|${e.pk}`, e.u])); },
      async outboxCount() { return ob.size; }, async ack(es) { for (const e of es) if (ob.get(`${e.table}|${e.pk}`)?.u === e.u) ob.delete(`${e.table}|${e.pk}`); },
      async drop(ks) { ks.forEach((k) => ob.delete(k)); }, async markAll(items) { for (const i of items) ob.set(`${i.table}|${i.pk}`, { ...i, k: '' }); },
      async get(k, d = null) { return m.has(k) ? m.get(k) : d; }, async set(k, v) { m.set(k, v); },
    },
    ob,
  };
}
let clock = Date.UTC(2026, 10, 16, 9, 0, 0);
const tick = (s = 1) => (clock += s * 1000);
function device(id) {
  const disk = memPersist();
  const store = createMemoryStore(undefined, { persist: disk.persist });
  const now = () => new Date(tick());
  return { id, disk, store, now, auth: createAuth({ store, now }) };
}
function attach(d, server) {
  d.revoked = [];
  d.sync = createSync({ store: d.store, meta: d.disk.meta, transport: server.transport, deviceId: d.id, now: d.now, auth: memAuth(), onRevoked: (m) => d.revoked.push(m) });
  return d.sync;
}
async function owner(d) {
  const s = await d.auth.setupOwner({ name: 'O', code: '1234' });
  d.eng = createEngine({ store: d.store, session: s, deviceId: d.id, now: d.now });
  await d.eng.settings.init();
  return d.eng;
}
const sum = (rows, f) => rows.reduce((a, r) => a + f(r), 0);

// the main device makes the shop and a link code; the new device joins with it
async function link(srv, main, other) {
  await attach(main, srv).makeMain('my-setup-key', 'main');
  const { code } = await main.sync.pairingCode();
  await attach(other, srv).join(code, 'second');
}

test('sync: two devices sell offline, everything converges (stock, cash, invoice numbers)', async () => {
  const srv = fakeServer();
  const A = device('A'), B = device('B');
  const a = await owner(A);
  const p = await a.products.create({ name: 'Vis', purchasePrice: '1', salePrice: '2', qty: '100' });
  await link(srv, A, B);                                                 // A (has the data) is the main device, B downloads the shop
  assert.equal(await A.disk.meta.outboxCount(), 0);
  assert.equal(A.sync.role, 'main'); assert.equal(B.sync.role, 'linked');
  assert.equal(await B.auth.hasOwner(), true);
  const b = createEngine({ store: B.store, session: await B.auth.login('1234'), deviceId: 'B', now: B.now });
  assert.equal(B.store.export().products.length, 1);

  const sale = (eng, qty) => eng.sale({ lines: [{ productId: p.id, qty, price: '2' }], paid: String(qty * 2) });
  await sale(a, '3'); await sale(a, '2'); await sale(b, '5'); await sale(b, '1');
  await A.sync.syncNow(); await B.sync.syncNow(); await A.sync.syncNow();

  const sa = A.store.export(), sb = B.store.export();
  assert.equal(sa.invoices.length, 4); assert.equal(sb.invoices.length, 4);
  assert.equal(sa.products[0].qty, 100000 - 11000);                    // 100 - 3 - 2 - 5 - 1 = 89 (qty in thousandths)
  assert.equal(sb.products[0].qty, sa.products[0].qty);
  assert.equal(sum(sa.cash_ledger, (r) => r.amount), sum(sb.cash_ledger, (r) => r.amount));
  const nosA = sa.invoices.map((i) => i.invoice_no).sort(), nosB = sb.invoices.map((i) => i.invoice_no).sort();
  assert.deepEqual(nosA, nosB);
  assert.equal(new Set(nosA).size, 4);                                  // no duplicate number survives
  assert.ok(nosA.some((n) => n.includes('-')));                         // the later device's invoices got a suffix
  assert.equal(sa.stock_movements.length, sb.stock_movements.length);
});

test('sync: same SKU created on two devices offline -> the later product gets a new number', async () => {
  const srv = fakeServer();
  const A = device('A'), B = device('B');
  const a = await owner(A);
  await link(srv, A, B);
  const b = createEngine({ store: B.store, session: await B.auth.login('1234'), deviceId: 'B', now: B.now });
  const p1 = await a.products.create({ name: 'Clou' });
  const p2 = await b.products.create({ name: 'Marteau' });
  assert.equal(p1.sku, p2.sku);
  await A.sync.syncNow(); await B.sync.syncNow(); await A.sync.syncNow(); await B.sync.syncNow();
  for (const d of [A, B]) {
    const skus = d.store.export().products.map((p) => p.sku).sort();
    assert.deepEqual(skus, ['01', '02']);
  }
  assert.deepEqual(A.store.export().products.map((p) => [p.name, p.sku]).sort(), B.store.export().products.map((p) => [p.name, p.sku]).sort());
});

test('sync: a newer local edit is not overwritten by an older remote one', async () => {
  const srv = fakeServer();
  const A = device('A'); await owner(A);
  const B = device('B'); await link(srv, A, B);
  const b = createEngine({ store: B.store, session: await B.auth.login('1234'), deviceId: 'B', now: B.now });
  await b.settings.set('store_name', 'B name');            // older edit, sent first
  await B.sync.syncNow();
  await A.eng.settings.set('store_name', 'A name');         // newer edit on A, not sent yet
  await A.sync.syncNow();                                   // pull must not overwrite it, push must win
  await B.sync.syncNow();
  assert.equal((await A.eng.settings.get()).store_name, 'A name');
  assert.equal((await b.settings.get()).store_name, 'A name');
});

test('link: wrong or reused code and wrong setup key are refused; only the main device makes codes and sees devices', async () => {
  const srv = fakeServer();
  const A = device('A'); await owner(A);
  await assert.rejects(attach(A, srv).makeMain('wrong-key', 'main'), (e) => e.kind === 'badkey');
  assert.equal(A.sync.role, null);
  await A.sync.makeMain('my-setup-key', 'main');
  await assert.rejects(A.sync.makeMain('my-setup-key', 'again'), /ALREADY_LINKED/);
  const B = device('B'), C = device('C');
  await assert.rejects(attach(B, srv).join('00000000', 'b'), (e) => e.kind === 'badpair');
  const { code } = await A.sync.pairingCode();
  await B.sync.join(code, 'b');
  await assert.rejects(attach(C, srv).join(code, 'c'), (e) => e.kind === 'badpair');          // one use only
  await assert.rejects(B.sync.pairingCode(), (e) => e.kind === 'notmain');
  await assert.rejects(B.sync.devices(), (e) => e.kind === 'notmain');
  const list = await A.sync.devices();
  assert.deepEqual(list.map((d) => [d.id, d.role, d.status]), [['A', 'main', 'active'], ['B', 'linked', 'active']]);
  await assert.rejects(A.sync.revoke('A', 'lock'), /SELF_REVOKE/);
});

test('disconnect (lock): the device is refused at its next contact, nothing it did afterwards reaches the shop, the others go on', async () => {
  const srv = fakeServer();
  const A = device('A'), B = device('B'), C = device('C');
  const a = await owner(A);
  await link(srv, A, B);
  await attach(C, srv).join((await A.sync.pairingCode()).code, 'third');
  const b = createEngine({ store: B.store, session: await B.auth.login('1234'), deviceId: 'B', now: B.now });
  await A.sync.revoke('B', 'lock');
  await b.settings.set('store_name', 'after the cut');
  await B.sync.syncNow();
  assert.equal(B.sync.status.state, 'revoked'); assert.deepEqual(B.revoked, ['lock']);
  assert.equal(srv.devs.get('B').wiped, false);
  await A.sync.syncNow(); await C.sync.syncNow();
  assert.notEqual((await a.settings.get()).store_name, 'after the cut');           // what B did after being cut stays on B
  assert.equal(C.sync.status.state, 'idle'); assert.deepEqual(C.revoked, []);        // C is not affected
  assert.equal((await A.sync.devices()).find((d) => d.id === 'B').status, 'revoked');
});

test('disconnect (wipe): the device is told to erase itself and confirms; it can join again with a new code', async () => {
  const srv = fakeServer();
  const A = device('A'), B = device('B');
  await owner(A); await link(srv, A, B);
  await A.sync.revoke('B', 'wipe');
  await B.sync.syncNow();
  assert.deepEqual(B.revoked, ['wipe']);
  assert.equal(await B.sync.confirmWipe(), true);
  assert.equal(srv.devs.get('B').wiped, true);
  await B.sync.unlink();                                                        // what the program does after wiping the data
  assert.equal(B.sync.role, null);
  await B.sync.join((await A.sync.pairingCode()).code, 'second again');
  assert.equal(B.sync.role, 'linked'); assert.equal(srv.devs.get('B').status, 'active');
});

test('recover: a new device takes the place of a lost main device, the old one is wiped, the shop comes back from the cloud', async () => {
  const srv = fakeServer();
  const A = device('A'), B = device('B');
  const a = await owner(A);
  await a.products.create({ name: 'Vis', purchasePrice: '1', salePrice: '2', qty: '10' });
  await attach(A, srv).makeMain('my-setup-key', 'main');
  const shop = A.sync.shopId;
  await attach(B, srv).recover('my-setup-key', shop, 'new main');
  assert.equal(B.sync.role, 'main');
  assert.equal(B.store.export().products.length, 1);
  await A.sync.syncNow();
  assert.deepEqual(A.revoked, ['wipe']);
  await assert.rejects(attach(device('Z'), srv).recover('wrong-key', shop, 'z'), (e) => e.kind === 'badkey');
});

test('transport: a publishable key goes in apikey only, refusals map to kinds', async () => {
  const { supabaseTransport } = await import('./sync.js');
  const calls = [];
  const mk = (res) => supabaseTransport({ url: 'https://x.supabase.co', key: 'sb_publishable_abc', fetchFn: async (u, o) => { calls.push({ u, o }); return res; } });
  const ok = { ok: true, json: async () => ({ ok: true }) };
  await mk(ok).push('A', 'tok', []);
  assert.equal(calls[0].u, 'https://x.supabase.co/rest/v1/rpc/sync_push');
  assert.equal(calls[0].o.headers.apikey, 'sb_publishable_abc'); assert.equal(calls[0].o.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0].o.body), { p_device: 'A', p_token: 'tok', p_rows: [] });
  await assert.rejects(mk({ ok: false, status: 400, text: async () => '{"message":"DEVICE_REVOKED_WIPE"}' }).pull('A', 't', 0, 1), (e) => e.kind === 'revoked' && e.mode === 'wipe');
  await assert.rejects(mk({ ok: true, json: async () => ({ error: 'BAD_PAIR_CODE' }) }).join('1', 'A', 'x'), (e) => e.kind === 'badpair');
  await assert.rejects(mk({ ok: false, status: 400, text: async () => '{"message":"TOO_MANY_ATTEMPTS"}' }).join('1', 'A', 'x'), (e) => e.kind === 'throttled');
  const legacy = supabaseTransport({ url: 'u', key: 'eyJabc', fetchFn: async (u, o) => { calls.push({ u, o }); return ok; } });
  await legacy.push('A', 't', []);
  assert.equal(calls.at(-1).o.headers.Authorization, 'Bearer eyJabc');
});

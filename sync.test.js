import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, createMemoryStore, createAuth } from './index.js';
import { createSync } from './sync.js';

// ---- a fake server that behaves like sync_schema.sql + license_schema.sql
//      (licenses by phone number, devices with their own keys, link codes, disconnection, device limit, 14-day lease)
const APPEND = new Set(['invoice_lines', 'stock_movements', 'cash_ledger', 'debt_ledger', 'invoice_settlements', 'price_history', 'audit_log', 'sku_registry']);
const refuse = (kind, extra = {}) => Object.assign(new Error(kind), { kind, ...extra });
const PHONE = '0663152474', CODE = 'ACT-CODE-1';
const norm = (p) => { const d = String(p).replace(/\D/g, ''); return d.startsWith('00') ? d.slice(2) : d.startsWith('0') && d.length === 10 ? `212${d.slice(1)}` : d; };
function fakeServer() {
  const calls = { n: 0 }; const rows = new Map(), devs = new Map(), codes = new Map(), lics = new Map(); let seq = 0, tok = 0, shops = 0, wrong = 0; const epochs = new Map(), stall = new Set();
  lics.set(norm(PHONE), { code: CODE, status: 'active', max: 3, shop: null });
  const lease = () => new Date(clock + 14 * 864e5).toISOString();                 // the server shares the test clock
  const licenseOf = (shop) => [...lics.values()].find((l) => l.shop === shop);
  const licenseError = (shop) => { const l = licenseOf(shop); return !l ? 'nolicense' : l.status !== 'active' ? 'suspended' : null; };
  const auth = (id, token, allowRevoked = false) => {
    const d = devs.get(id);
    if (!d || d.token !== token) throw refuse('badtoken');
    if (!allowRevoked) {
      if (d.status === 'revoked') throw refuse('revoked', { mode: d.mode });
      const e = licenseError(d.shop); if (e) throw refuse(e);
      d.lease = lease();
    }
    return d;
  };
  const main = (id, token) => { const d = auth(id, token); if (d.role !== 'main') throw refuse('notmain'); return d; };
  return {
    rows, devs, lics, calls, epochs, stall,
    release() { for (const r of rows.values()) r.hidden = false; },        // a stalled push finally commits (rows of devices in `stall` stay invisible until then)
    transport: {
      async activate(phone, code, id, name) {
        if (wrong >= 5) throw refuse('throttled');
        const l = lics.get(norm(phone));
        if (!l || l.code !== code) { wrong++; throw refuse('badactivation'); }
        if (l.status !== 'active') throw refuse('suspended');
        const old = devs.get(id); if (old && old.shop !== l.shop) throw refuse('taken');
        let recovered = false;
        if (!l.shop) l.shop = `shop${++shops}`;
        else { recovered = true; for (const d of devs.values()) if (d.shop === l.shop && d.role === 'main' && d.id !== id && d.status === 'active') Object.assign(d, { status: 'revoked', mode: 'wipe', wiped: false }); }
        if (!old && [...devs.values()].filter((d) => d.shop === l.shop && d.status === 'active').length >= l.max) throw refuse('limit');
        const token = `t${++tok}`; devs.set(id, { id, shop: l.shop, name, role: 'main', status: 'active', token, lease: lease() });
        return { shop_id: l.shop, token, role: 'main', recovered, lease_until: devs.get(id).lease };
      },
      async pairingCode(id, token) { const d = main(id, token); const code = String(10000000 + codes.size); codes.set(code, { shop: d.shop, used: false }); return { code }; },
      async join(code, id, name) {
        if (wrong >= 30) throw refuse('throttled');
        const c = codes.get(String(code).replace(/\D/g, ''));
        if (!c || c.used) { wrong++; throw refuse('badpair'); }
        const e = licenseError(c.shop); if (e) throw refuse(e);
        if ([...devs.values()].filter((d) => d.shop === c.shop && d.status === 'active' && d.id !== id).length >= licenseOf(c.shop).max) throw refuse('limit');
        const old = devs.get(id);
        if (old && (old.shop !== c.shop || old.status === 'active')) throw refuse('taken');
        const token = `t${++tok}`; devs.set(id, { id, shop: c.shop, name, role: 'linked', status: 'active', token, lease: lease() }); c.used = true;
        return { shop_id: c.shop, token, role: 'linked', lease_until: devs.get(id).lease };
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
      async exchange(id, token, list, since, limit, epoch = null) {
        const d = auth(id, token);
        calls.n++;
        const ep = epochs.get(d.shop) || 1;
        if (epoch != null && epoch !== ep) return { reset: true, epoch: ep, rows: [], last: 0, lease_until: d.lease };       // sync_repair.sql: an older epoch is not accepted
        for (const r of list) {
          const k = `${d.shop}|${r.t}|${r.k}`, cur = rows.get(k), hidden = stall.has(id);
          if (!cur) rows.set(k, { ...r, shop: d.shop, dev: id, seq: ++seq, hidden });
          else if (!APPEND.has(r.t) && Date.parse(cur.u) <= Date.parse(r.u)) rows.set(k, { ...r, shop: d.shop, dev: id, seq: ++seq, hidden });
        }
        const out = [...rows.values()].filter((r) => r.shop === d.shop && !r.hidden && r.seq > since && r.dev !== id).sort((a, b) => a.seq - b.seq).slice(0, limit);
        return { rows: out.map((r) => ({ t: r.t, k: r.k, d: r.d, u: r.u, s: r.seq })), last: out.length ? out[out.length - 1].seq : since, lease_until: d.lease, epoch: ep };
      },
      async counts(id, token) {
        const d = auth(id, token), counts = {};
        for (const r of rows.values()) if (r.shop === d.shop && !r.hidden) counts[r.t] = (counts[r.t] || 0) + 1;
        return { counts, epoch: epochs.get(d.shop) || 1 };
      },
      async reset(id, token) {
        const d = main(id, token);
        for (const [k, r] of [...rows]) if (r.shop === d.shop) rows.delete(k);
        epochs.set(d.shop, (epochs.get(d.shop) || 1) + 1);
        return { epoch: epochs.get(d.shop) };
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
  d.revoked = []; d.license = []; d.syncAuth = memAuth();
  d.sync = createSync({ store: d.store, meta: d.disk.meta, transport: server.transport, deviceId: d.id, now: d.now, auth: d.syncAuth, onRevoked: (m) => d.revoked.push(m), onLicense: (k) => d.license.push(k) });
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
  await attach(main, srv).activate(PHONE, CODE, 'main');
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

test('activation: unknown number or wrong code refused (same answer), a number can be written in any form, only the main device makes codes and sees devices', async () => {
  const srv = fakeServer();
  const A = device('A'); await owner(A);
  await assert.rejects(attach(A, srv).activate(PHONE, 'wrong', 'main'), (e) => e.kind === 'badactivation');
  await assert.rejects(A.sync.activate('0600000000', CODE, 'main'), (e) => e.kind === 'badactivation');
  assert.equal(A.sync.role, null);
  const r = await A.sync.activate('+212 663-152474', CODE, 'main');             // 06.. = +212 6.. = same number
  assert.equal(r.recovered, false); assert.equal(A.sync.role, 'main');
  await assert.rejects(A.sync.activate(PHONE, CODE, 'again'), /ALREADY_LINKED/);
  const B = device('B'), C = device('C');
  await assert.rejects(attach(B, srv).join('00000000', 'b'), (e) => e.kind === 'badpair');
  const { code } = await A.sync.pairingCode();
  await B.sync.join(code, 'b');
  await assert.rejects(attach(C, srv).join(code, 'c'), (e) => e.kind === 'badpair');          // one use only
  await assert.rejects(B.sync.pairingCode(), (e) => e.kind === 'notmain');
  await assert.rejects(B.sync.devices(), (e) => e.kind === 'notmain');
  assert.deepEqual((await A.sync.devices()).map((d) => [d.id, d.role, d.status]), [['A', 'main', 'active'], ['B', 'linked', 'active']]);
  await assert.rejects(A.sync.revoke('A', 'lock'), /SELF_REVOKE/);
});

test('activation: too many wrong codes are stopped', async () => {
  const srv = fakeServer(); const A = device('A'); await owner(A); attach(A, srv);
  for (let i = 0; i < 5; i++) await assert.rejects(A.sync.activate(PHONE, `bad${i}`, 'x'), (e) => e.kind === 'badactivation');
  await assert.rejects(A.sync.activate(PHONE, CODE, 'x'), (e) => e.kind === 'throttled');
});

test('license: the device limit is enforced; a suspended license locks every device (nothing deleted) and resuming brings them back', async () => {
  const srv = fakeServer();
  srv.lics.get(norm(PHONE)).max = 2;
  const A = device('A'), B = device('B'), C = device('C');
  await owner(A); await link(srv, A, B);
  await assert.rejects(attach(C, srv).join((await A.sync.pairingCode()).code, 'third'), (e) => e.kind === 'limit');
  srv.lics.get(norm(PHONE)).status = 'suspended';
  await A.sync.syncNow(); await B.sync.syncNow();
  assert.equal(A.sync.status.state, 'license'); assert.deepEqual(A.license, ['suspended']); assert.deepEqual(B.license, ['suspended']);
  assert.deepEqual(A.revoked, []);                                                    // locked, not disconnected
  assert.equal(A.store.export().products.length, A.store.export().products.length);   // the data stays
  srv.lics.get(norm(PHONE)).status = 'active';
  await A.sync.syncNow();
  assert.equal(A.sync.status.state, 'idle');
  await attach(device('D'), srv).activate(PHONE, CODE, 'd');                            // a new main device replaces the old one: the count stays within the limit
  await A.sync.syncNow(); assert.deepEqual(A.revoked, ['wipe']);
});

test('a device left in a shop with no license is locked as "no license", and a new identity can activate and bring its data along', async () => {
  const srv = fakeServer();
  const A = device('A'); const a = await owner(A);
  await a.products.create({ name: 'Vis', purchasePrice: '1', salePrice: '2', qty: '10' });
  attach(A, srv);
  srv.devs.set('A', { id: 'A', shop: 'old-shop', name: 'old', role: 'main', status: 'active', token: 'tk' });         // made before licenses existed
  A.syncAuth.set({ token: 'tk', role: 'main', shop_id: 'old-shop' });
  await A.sync.syncNow();
  assert.equal(A.sync.status.state, 'license'); assert.deepEqual(A.license, ['nolicense']);
  await A.sync.unlink();                                                              // what the program does (and a new device id)
  const fresh = createSync({ store: A.store, meta: A.disk.meta, transport: srv.transport, deviceId: 'A-new', now: A.now, auth: memAuth() });
  assert.equal((await fresh.activate(PHONE, CODE, 'phone')).recovered, false);
  assert.equal(fresh.status.state, 'idle');
  assert.ok([...srv.rows.values()].some((r) => r.t === 'products' && r.shop === 'shop1'));                          // the local data reached the new shop
});

test('lease: given at activation, renewed at every contact, expires offline, the device clock cannot go back', async () => {
  const srv = fakeServer();
  const A = device('A'); await owner(A);
  await link(srv, A, device('B'));
  assert.ok(A.sync.leaseUntil);
  assert.equal(A.sync.leaseExpired(), false);
  clock += 13 * 864e5; assert.equal(A.sync.leaseExpired(), false);                       // 13 days without internet: still working
  await A.sync.syncNow(); const renewed = Date.parse(A.sync.leaseUntil);                 // a contact renews it
  assert.ok(renewed > Date.UTC(2026, 10, 16) + 14 * 864e5);
  clock += 15 * 864e5; assert.equal(A.sync.leaseExpired(), true);                        // 15 days offline: locked
  clock -= 10 * 864e5; assert.equal(A.sync.leaseExpired(), true);                        // putting the clock back does not help
});

test('recover: activating again on a new device makes it the main one, wipes the old main device, and the shop comes back from the cloud', async () => {
  const srv = fakeServer();
  const A = device('A'), B = device('B');
  const a = await owner(A);
  await a.products.create({ name: 'Vis', purchasePrice: '1', salePrice: '2', qty: '10' });
  await attach(A, srv).activate(PHONE, CODE, 'main');
  const r = await attach(B, srv).activate(PHONE, CODE, 'new main');
  assert.equal(r.recovered, true); assert.equal(B.sync.role, 'main');
  assert.equal(B.store.export().products.length, 1);
  await A.sync.syncNow();
  assert.deepEqual(A.revoked, ['wipe']);
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

test('transport: a publishable key goes in apikey only, refusals map to kinds', async () => {
  const { supabaseTransport } = await import('./sync.js');
  const calls = [];
  const mk = (res) => supabaseTransport({ url: 'https://x.supabase.co', key: 'sb_publishable_abc', fetchFn: async (u, o) => { calls.push({ u, o }); return res; } });
  const ok = { ok: true, json: async () => ({ ok: true }) };
  await mk(ok).exchange('A', 'tok', [], 0, 500);
  assert.equal(calls[0].u, 'https://x.supabase.co/rest/v1/rpc/sync_exchange');
  assert.equal(calls[0].o.headers.apikey, 'sb_publishable_abc'); assert.equal(calls[0].o.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0].o.body), { p_device: 'A', p_token: 'tok', p_rows: [], p_since: 0, p_limit: 500 });
  await assert.rejects(mk({ ok: false, status: 400, text: async () => '{"message":"DEVICE_REVOKED_WIPE"}' }).exchange('A', 't', [], 0, 1), (e) => e.kind === 'revoked' && e.mode === 'wipe');
  await assert.rejects(mk({ ok: true, json: async () => ({ error: 'BAD_PAIR_CODE' }) }).join('1', 'A', 'x'), (e) => e.kind === 'badpair');
  await assert.rejects(mk({ ok: false, status: 400, text: async () => '{"message":"TOO_MANY_ATTEMPTS"}' }).join('1', 'A', 'x'), (e) => e.kind === 'throttled');
  await assert.rejects(mk({ ok: true, json: async () => ({ error: 'LICENSE_SUSPENDED' }) }).activate('0', 'c', 'A', 'x'), (e) => e.kind === 'suspended');
  await assert.rejects(mk({ ok: false, status: 400, text: async () => '{"message":"DEVICE_LIMIT"}' }).join('1', 'A', 'x'), (e) => e.kind === 'limit');
  const legacy = supabaseTransport({ url: 'u', key: 'eyJabc', fetchFn: async (u, o) => { calls.push({ u, o }); return ok; } });
  await legacy.exchange('A', 't', [], 0, 1);
  assert.equal(calls.at(-1).o.headers.Authorization, 'Bearer eyJabc');
});

test('sync: one request per round (rows out and rows in together), and nothing to do costs one small request', async () => {
  const srv = fakeServer();
  const A = device('A'), B = device('B');
  const a = await owner(A); await link(srv, A, B);
  const p = await a.products.create({ name: 'Vis', purchasePrice: '1', salePrice: '2', qty: '10' });
  await A.sync.syncNow(); await B.sync.syncNow();
  const before = srv.calls.n;
  await B.sync.syncNow();                                                           // nothing new anywhere
  assert.equal(srv.calls.n - before, 1);
  await a.sale({ lines: [{ productId: p.id, qty: 1, price: '2' }], paid: '2' });
  const b2 = srv.calls.n;
  await A.sync.syncNow();                                                           // sends the sale and looks for news in the same request
  assert.equal(srv.calls.n - b2, 1);
  await B.sync.syncNow();
  assert.equal(B.store.export().invoices.length, 1);
});

test('sync: a large backlog goes out in pages of 500 and converges', async () => {
  const srv = fakeServer();
  const A = device('A'), B = device('B');
  const a = await owner(A); await link(srv, A, B);
  for (let i = 0; i < 40; i++) await a.products.create({ name: `Produit ${i}`, purchasePrice: '1', salePrice: '2', qty: '5' });      // ~ 40 products + 40 movements + audit rows: a few hundred rows
  await A.sync.syncNow(); await B.sync.syncNow();
  assert.equal(B.store.export().products.length, 40);
  assert.equal(B.store.export().stock_movements.length, 40);
  assert.equal(await A.disk.meta.outboxCount(), 0);
});

// ---- the shop of the user: the main device holds a history, a link-up happens at the same moment as other work
async function history(eng, n) {
  const p = await eng.products.create({ name: `Vis${n}`, purchasePrice: '1', salePrice: '2', qty: '1000' });
  for (let i = 0; i < n; i++) await eng.sale({ lines: [{ productId: p.id, qty: '1', price: '2' }], paid: '2' });
  return p;
}
const empEngine = async (D) => createEngine({ store: D.store, session: await D.auth.login('1234'), deviceId: D.id, now: D.now });

test('sync: old history is never skipped, even when a third device read past it (the phone with no invoices)', async () => {
  const srv = fakeServer();
  const M = device('M'), L1 = device('L1'), L2 = device('L2');
  const m = await owner(M);
  await history(m, 60);                                              // the history made before any link-up
  const l1 = await owner(L1);
  await history(l1, 40);                                             // another device with its own work: far more than the 100-row overlap
  srv.stall.add('M');                                                // M's upload is still "in flight" (not committed) ...
  await attach(M, srv).activate(PHONE, CODE, 'main');
  const code1 = await M.sync.pairingCode();
  await attach(L1, srv).join(code1.code, 'first');                   // ... while the other device links and sends its rows: they get HIGHER numbers
  srv.stall.clear();
  const code2 = await M.sync.pairingCode();
  await attach(L2, srv).join(code2.code, 'second');                  // a third device reads: it only sees what is committed, and moves its cursor past it
  srv.release();                                                     // M's history commits LATER than rows that came after it
  await L2.sync.syncNow();
  assert.equal(L2.store.export().invoices.length, 40, 'the cursor alone never brings the history back');

  // the repair: a device compares its row counts with the shop's and reads the whole shop again when it holds less
  clock += 6 * 60 * 1000;
  await L2.sync.syncNow(); await L1.sync.syncNow(); await M.sync.syncNow(); await L2.sync.syncNow();
  const n = M.store.export().invoices.length;
  assert.equal(n, 100);
  for (const D of [L1, L2]) {
    const got = D.store.export();
    assert.equal(got.invoices.length, 100);
    assert.equal(got.stock_movements.length, M.store.export().stock_movements.length);
  }
});

test('sync: rows lost from the outbox are sent again (the main device holds more than the shop)', async () => {
  const srv = fakeServer();
  const M = device('M'), L = device('L');
  const m = await owner(M);
  await link(srv, M, L);
  await history(m, 5);
  M.disk.ob.clear();                                                 // the outbox of the main device was lost: its sales never left it
  await M.sync.syncNow(); await L.sync.syncNow();
  assert.equal(L.store.export().invoices.length, 0);
  clock += 6 * 60 * 1000;
  await M.sync.syncNow(); await L.sync.syncNow(); await M.sync.syncNow(); await L.sync.syncNow();
  assert.equal(L.store.export().invoices.length, 5);
});

test('sync: a device that was linked before the repair existed sends everything and reads the shop once', async () => {
  const srv = fakeServer();
  const M = device('M'), L = device('L');
  const m = await owner(M);
  await link(srv, M, L);
  await history(m, 4);
  M.disk.ob.clear();                                                 // sales that never reached the shop
  await M.disk.meta.set('repair', 0);                                // this device never ran the repair: a first start of the new program
  await M.sync.syncNow(); await L.sync.syncNow();
  assert.equal(L.store.export().invoices.length, 4);                 // no waiting time: the one-time repair does not depend on the server counts
  assert.equal(await M.disk.meta.get('repair', 0), 1);
});

test('sync: the main device restores / empties the operations and every linked device follows (no old invoice stays on a phone)', async () => {
  const srv = fakeServer();
  const M = device('M'), L = device('L');
  const m = await owner(M);
  await history(m, 6);
  await link(srv, M, L);
  assert.equal(L.store.export().invoices.length, 6);
  let reloaded = 0; L.sync = createSync({ store: L.store, meta: L.disk.meta, transport: srv.transport, deviceId: 'L', now: L.now, auth: L.syncAuth, onReset: () => reloaded++ });

  await m.admin.resetOperations();                                   // the owner empties the operations on the main device
  await M.sync.markReset(); await M.sync.syncNow();
  assert.equal(srv.epochs.get('shop1'), 2);
  await L.sync.syncNow();
  assert.equal(L.store.export().invoices.length, 0);
  assert.equal(L.store.export().products.length, 1);                 // the products stay, as on the main device
  assert.equal(reloaded, 1);                                         // the program reloads itself on that device

  // a sale made on the phone while it was offline, before it met the new epoch, is not accepted into the new shop
  const l = await empEngine(L);
  const p = (await l.products.search('', 5))[0];
  await l.sale({ lines: [{ productId: p.id, qty: '1', price: '2' }], paid: '2' });
  await L.sync.syncNow(); await M.sync.syncNow();
  assert.equal(M.store.export().invoices.length, 1);                 // a NEW sale after the reset syncs normally
  assert.equal(L.store.export().invoices.length, 1);

  // a backup restored on the main device: same thing
  const file = await m.admin.backup();
  await history(m, 2);
  await M.sync.syncNow(); await L.sync.syncNow();
  assert.equal(L.store.export().invoices.length, 3);
  await m.admin.restoreBackup(file);
  await M.sync.markReset(); await M.sync.syncNow();
  await L.sync.syncNow();
  assert.equal(L.store.export().invoices.length, 1);
  assert.equal(srv.epochs.get('shop1'), 3);
  assert.equal(M.store.export().invoices.length, L.store.export().invoices.length);
});

test('sync: a device in an older epoch is told to start again and what it sent is not accepted', async () => {
  const srv = fakeServer();
  const M = device('M'), L = device('L');
  const m = await owner(M);
  await history(m, 3);
  await link(srv, M, L);
  const l = await empEngine(L);
  const p = (await l.products.search('', 5))[0];
  await m.admin.resetOperations(); await M.sync.markReset(); await M.sync.syncNow();         // L is offline during the reset ...
  await l.sale({ lines: [{ productId: p.id, qty: '1', price: '2' }], paid: '2' });   // ... and sells
  const before = [...srv.rows.values()].filter((r) => r.t === 'invoices').length;
  await L.sync.syncNow();                                            // it meets the new epoch: its offline sale belongs to the old shop
  assert.equal([...srv.rows.values()].filter((r) => r.t === 'invoices').length, before);
  assert.equal(L.store.export().invoices.length, 0);
});

test('sync: a main device whose server was not updated keeps working and says the reset is blocked', async () => {
  const srv = fakeServer();
  const M = device('M'), L = device('L');
  const m = await owner(M);
  await link(srv, M, L);
  srv.transport.reset = async () => { throw Object.assign(new Error('404'), { kind: 'server' }); };
  await M.sync.markReset(); await M.sync.syncNow();
  assert.equal(M.sync.status.resetBlocked, true);
  assert.equal(M.sync.status.state, 'idle');                         // normal sync is not blocked
});

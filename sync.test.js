import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, createMemoryStore, createAuth } from './index.js';
import { createSync } from './sync.js';

// ---- a fake server that behaves like sync_schema.sql
const APPEND = new Set(['invoice_lines', 'stock_movements', 'cash_ledger', 'debt_ledger', 'invoice_settlements', 'price_history', 'audit_log', 'sku_registry']);
function fakeServer(code = 'secret-code-123') {
  const rows = new Map(); let seq = 0;
  const check = (c) => { if (c !== code) throw Object.assign(new Error('BAD_LINK_CODE'), { kind: 'badcode' }); };
  return {
    rows,
    transport: {
      async push(c, dev, list) {
        check(c);
        for (const r of list) {
          const k = `${r.t}|${r.k}`, cur = rows.get(k);
          if (!cur) rows.set(k, { ...r, dev, seq: ++seq });
          else if (!APPEND.has(r.t) && Date.parse(cur.u) <= Date.parse(r.u)) rows.set(k, { ...r, dev, seq: ++seq });
        }
        return { ok: true };
      },
      async pull(c, dev, since, limit) {
        check(c);
        const out = [...rows.values()].filter((r) => r.seq > since && r.dev !== dev).sort((a, b) => a.seq - b.seq).slice(0, limit);
        return { rows: out.map((r) => ({ t: r.t, k: r.k, d: r.d, u: r.u, s: r.seq })), last: out.length ? out[out.length - 1].seq : since };
      },
    },
  };
}
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
  global.localStorage = { getItem: () => 'secret-code-123', setItem() {}, removeItem() {} };
  d.sync = createSync({ store: d.store, meta: d.disk.meta, transport: server.transport, deviceId: d.id, now: d.now, getCode: () => 'secret-code-123' });
  return d.sync;
}
async function owner(d) {
  const s = await d.auth.setupOwner({ name: 'O', code: '1234' });
  d.eng = createEngine({ store: d.store, session: s, deviceId: d.id, now: d.now });
  await d.eng.settings.init();
  return d.eng;
}
const sum = (rows, f) => rows.reduce((a, r) => a + f(r), 0);

test('sync: two devices sell offline, everything converges (stock, cash, invoice numbers)', async () => {
  const srv = fakeServer();
  const A = device('A'), B = device('B');
  const a = await owner(A);
  const p = await a.products.create({ name: 'Vis', purchasePrice: '1', salePrice: '2', qty: '100' });
  const sA = attach(A, srv);
  // main device links: everything it has goes up
  await sA.linkMain('secret-code-123');
  assert.equal(await A.disk.meta.outboxCount(), 0);

  // new device joins and downloads the shop (owner + settings + product + stock)
  const sB = attach(B, srv);
  await sB.linkNew('secret-code-123');
  assert.equal(await B.auth.hasOwner(), true);
  const b = createEngine({ store: B.store, session: await B.auth.login('1234'), deviceId: 'B', now: B.now });
  assert.equal((await b.products.list?.() ?? B.store.export().products).length, 1);

  // both sell the same product, offline, same day
  const sale = (eng, qty) => eng.sale({ lines: [{ productId: p.id, qty, price: '2' }], paid: String(qty * 2) });
  await sale(a, '3'); await sale(a, '2'); await sale(b, '5'); await sale(b, '1');
  await sA.syncNow(); await sB.syncNow(); await sA.syncNow();

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
  await attach(A, srv).linkMain('secret-code-123');
  await attach(B, srv).linkNew('secret-code-123');
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

test('sync: a wrong link code is refused; a newer local edit is not overwritten by an older remote one', async () => {
  const srv = fakeServer();
  const A = device('A'); await owner(A);
  await assert.rejects(attach(A, srv).linkMain('wrong'), (e) => e.kind === 'badcode');
  await attach(A, srv).linkMain('secret-code-123');
  const B = device('B'); await attach(B, srv).linkNew('secret-code-123');
  const b = createEngine({ store: B.store, session: await B.auth.login('1234'), deviceId: 'B', now: B.now });
  await b.settings.set('store_name', 'B name');            // older edit, sent first
  await B.sync.syncNow();
  await A.eng.settings.set('store_name', 'A name');         // newer edit on A, not sent yet
  await A.sync.syncNow();                                   // pull must not overwrite it, push must win
  await B.sync.syncNow();
  assert.equal((await A.eng.settings.get()).store_name, 'A name');
  assert.equal((await b.settings.get()).store_name, 'A name');
});

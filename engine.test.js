import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, createMemoryStore, createAuth, EngineError, money } from './index.js';
import { createAccess } from './permissions.js';
import { postInvoice } from './post.js';
import { renderInvoice } from './invoice-text.js';

// Clock: 13 Nov 2026 21:46 (Casablanca) + 1 s per call, so FIFO order is deterministic
function setup() {
  let t = Date.UTC(2026, 10, 13, 20, 46, 0);
  const now = () => new Date((t += 1000));
  const store = createMemoryStore();
  const auth = createAuth({ store, now });
  return { store, auth, now };
}
async function world() {
  const { store, auth, now } = setup();
  const ownerS = await auth.setupOwner({ name: 'Owner', code: '1234' });
  const owner = createEngine({ store, session: ownerS, now });
  await owner.settings.init();
  await owner.settings.set('store_name', 'عقاقير العيادي');
  await owner.settings.set('store_phone', '0663152474');
  await auth.addEmployee(ownerS, { name: 'Emp', code: '5678' });
  const empS = await auth.login('5678');
  const emp = createEngine({ store, session: empS, now });
  return { store, auth, now, ownerS, owner, empS, emp };
}
const rejects = (p, code) => assert.rejects(p, (e) => e instanceof EngineError && e.code === code, `expected ${code}`);

test('money: exact rounding, comma decimals, weighted average', () => {
  assert.equal(money.parseMoney('12,5'), 1250);
  assert.equal(money.lineCents(money.parseQty('1,5'), money.parsePrice('10.01')), 1502);     // 15.015 -> 15.02
  assert.equal(money.wac(10000, 30000, 10000, 50000), 40000);                                 // (10x3 + 10x5)/20 = 4
  assert.equal(money.wac(-5000, 30000, 4000, 70000), 70000);                                  // negative stock -> new cost whole
  assert.throws(() => money.parseMoney('1.234'), (e) => e.code === 'TOO_MANY_DECIMALS');
  assert.equal(money.fmtMoney(1501), '15.01');
});

test('login: the code decides the role', async () => {
  const w = await world();
  assert.equal(w.ownerS.role, 'owner');
  assert.equal(w.empS.role, 'employee');
  await rejects(w.auth.login('0000'), 'BAD_CODE');
  await rejects(w.auth.addEmployee(w.empS, { name: 'x', code: '9999' }), 'PERMISSION_DENIED');
  await rejects(w.auth.addEmployee(w.ownerS, { name: 'dup', code: '5678' }), 'CODE_TAKEN');
  assert.equal(w.empS.permissions.cash_deposit_withdraw, false);
  assert.equal(w.empS.permissions.sell, true);
});

async function stocked(w) {
  const nails = await w.owner.products.create({ name: 'مسمار', salePrice: '5' });
  assert.equal(nails.sku, '01');
  await w.owner.deposit('1000');
  const p1 = await w.emp.purchase({ supplier: { name: 'Ali', phone: '0661234567' }, lines: [{ productId: nails.id, qty: 10, price: '3' }], paid: '20' });
  const p2 = await w.emp.purchase({ supplier: { name: 'Ali', phone: '+212661234567' }, lines: [{ productId: nails.id, qty: 10, price: '5' }] });
  return { nails, p1, p2 };
}

test('purchase: stock, weighted cost, till, supplier debt, same phone = same supplier', async () => {
  const w = await world();
  const { nails, p1, p2 } = await stocked(w);
  assert.equal(p1.invoice.invoice_no, '61113002');                       // deposit took 001
  assert.equal(p1.invoice.credit_amount, 1000);
  assert.equal(p1.invoice.cash_effect, -2000);
  const [prod] = await w.emp.products.search('01');
  assert.equal(prod.qty, 20000);
  assert.equal(prod.purchase_price, 40000);                              // WAC 4.00
  assert.equal(await w.owner.reports.cashBalance(), 100000 - 2000 - 5000);
  const sup = await w.emp.reports.suppliers();
  assert.equal(sup.length, 1);                                           // 0661... and +212661... are one supplier
  assert.equal(sup[0].balance, 1000);
  await rejects(w.emp.purchase({ supplier: { name: 'Ali', phone: '0661234567' }, lines: [{ productId: nails.id, qty: 1, price: '3' }], paid: '99' }), 'OVERPAYMENT');
  await rejects(w.emp.purchase({ supplier: { name: '', phone: '' }, lines: [{ productId: nails.id, qty: 1, price: '4' }], paid: '1' }), 'NAME_REQUIRED');
  assert.deepEqual(await w.owner.reports.integrityCheck(), []);
});

test('sale: cash with change, credit needs customer, frozen cost, negative stock warning', async () => {
  const w = await world();
  const { nails } = await stocked(w);
  const cash0 = await w.owner.reports.cashBalance();
  const s = await w.emp.sale({ lines: [{ productId: nails.id, qty: 5 }], paid: '30' });
  assert.equal(s.invoice.total, 2500);
  assert.equal(s.invoice.paid, 2500);                                    // change 5.00 is not recorded
  assert.equal(s.change, 500);
  assert.equal(s.invoice.profit, 500);                                   // 5 x (5.00 - 4.00)
  assert.equal(await w.owner.reports.cashBalance(), cash0 + 2500);
  await rejects(w.emp.sale({ lines: [{ productId: nails.id, qty: 1 }], paid: '2' }), 'CUSTOMER_REQUIRED');

  const c = await w.emp.sale({ lines: [{ productId: nails.id, qty: 2 }], paid: '4', customer: { name: 'Karim', phone: '0600000001' } });
  assert.equal(c.invoice.credit_amount, 600);
  assert.equal((await w.emp.reports.customers())[0].balance, 600);

  const big = await w.emp.sale({ lines: [{ productId: nails.id, qty: 20 }] });                // only 13 left
  assert.equal(big.warnings[0].type, 'NEGATIVE_STOCK');
  const [prod] = await w.emp.products.search('01');
  assert.equal(prod.qty, -7000);
  assert.deepEqual(await w.owner.reports.integrityCheck(), []);
});

test('sale below cost: alert first, then allowed (damaged goods); permission can forbid it', async () => {
  const w = await world();
  const { nails } = await stocked(w);
  await rejects(w.emp.sale({ lines: [{ productId: nails.id, qty: 1, price: '2' }] }), 'BELOW_COST');
  const ok = await w.emp.sale({ lines: [{ productId: nails.id, qty: 1, price: '2' }], allowBelowCost: true });
  assert.equal(ok.invoice.profit, -200);
  assert.equal(ok.warnings[0].type, 'BELOW_COST');
  await w.auth.setUserPermission(w.ownerS, w.empS.userId, 'sell_below_cost', false);
  const emp2 = createEngine({ store: w.store, session: await w.auth.login('5678'), now: w.now });
  await rejects(emp2.sale({ lines: [{ productId: nails.id, qty: 1, price: '2' }], allowBelowCost: true }), 'PERMISSION_DENIED');
});

test('external product: its cost leaves the till at the sale, profit is the commission', async () => {
  const w = await world();
  await w.owner.deposit('500');
  const r = await w.emp.sale({ lines: [{ external: { name: 'بيب خاص', cost: '70', price: '90', qty: 1 } }] });
  assert.equal(r.invoice.total, 9000);
  assert.equal(r.invoice.cash_effect, 2000);                             // 90 in, 70 out
  assert.equal(r.invoice.profit, 2000);
  assert.equal(await w.owner.reports.cashBalance(), 50000 + 2000);
});

test('quick sale: full price in the till, only the configured % is profit, can be returned', async () => {
  const w = await world();
  const q = await w.emp.quickSale('8');
  assert.equal(q.invoice.total, 800);
  assert.equal(q.invoice.cash_effect, 800);
  assert.equal(q.invoice.profit, 160);                                   // 20 %
  await w.owner.settings.set('quick_sale_profit_pct', 40);
  const q2 = await w.emp.quickSale('10');
  assert.equal(q2.invoice.profit, 400);                                  // 40 %
  const ret = await w.emp.customerReturn({ invoice: q.invoice.invoice_no, lines: [{ originLineId: q.lines[0].id, qty: 1 }] });
  assert.equal(ret.refunded, 800);
  assert.equal(ret.invoice.profit, -160);                                // profit taken back at the original %
  assert.equal(await w.owner.reports.cashBalance(), 800 + 1000 - 800);
  await rejects(w.emp.customerReturn({ invoice: q.invoice.invoice_no, lines: [{ originLineId: q.lines[0].id, qty: 1 }] }), 'RETURN_EXCEEDS');
  assert.deepEqual(await w.owner.reports.integrityCheck(), []);
});

test('customer return: debt reduced first, then cash; partial returns; original flagged', async () => {
  const w = await world();
  const { nails } = await stocked(w);
  const s = await w.emp.sale({ lines: [{ productId: nails.id, qty: 4 }], paid: '5', customer: { name: 'Karim', phone: '0600000001' } });   // 20.00, paid 5 -> debt 15
  const cash0 = await w.owner.reports.cashBalance();
  const r1 = await w.emp.customerReturn({ invoice: s.invoice.id, lines: [{ originLineId: s.lines[0].id, qty: 2 }] });      // value 10
  assert.equal(r1.debt_reduced, 1000); assert.equal(r1.refunded, 0);
  assert.equal(await w.owner.reports.cashBalance(), cash0);
  const r2 = await w.emp.customerReturn({ invoice: s.invoice.id, lines: [{ originLineId: s.lines[0].id, qty: 2 }] });      // value 10: 5 debt left, 5 refund
  assert.equal(r2.debt_reduced, 500); assert.equal(r2.refunded, 500);
  assert.equal(await w.owner.reports.cashBalance(), cash0 - 500);
  assert.equal((await w.emp.reports.customers())[0].balance, 0);
  const back = await w.emp.reports.invoice(s.invoice.id);
  assert.equal(back.invoice.is_modified, true);
  assert.equal(back.invoice.total, 2000);                                // original untouched
  assert.equal(back.returns.length, 2);
  const [prod] = await w.emp.products.search('01');
  assert.equal(prod.qty, 20000);                                         // everything back in stock
  assert.deepEqual(await w.owner.reports.integrityCheck(), []);
});

test('supplier return: blocked without stock, reduces the supplier debt first', async () => {
  const w = await world();
  const { nails, p1 } = await stocked(w);
  await w.emp.sale({ lines: [{ productId: nails.id, qty: 15 }] });                         // 5 left
  await rejects(w.emp.supplierReturn({ invoice: p1.invoice.id, lines: [{ originLineId: p1.lines[0].id, qty: 8 }] }), 'STOCK_INSUFFICIENT');
  const cash0 = await w.owner.reports.cashBalance();
  const r = await w.emp.supplierReturn({ invoice: p1.invoice.id, lines: [{ originLineId: p1.lines[0].id, qty: 4 }] });   // 12.00 at 3.00
  assert.equal(r.debt_reduced, 1000);                                    // supplier debt was 10.00
  assert.equal(r.refunded, 200);
  assert.equal(await w.owner.reports.cashBalance(), cash0 + 200);
  assert.equal((await w.emp.reports.suppliers())[0].balance, 0);
  assert.deepEqual(await w.owner.reports.integrityCheck(), []);
});

test('debt payments: oldest invoice first, partial, no overpayment', async () => {
  const w = await world();
  const { nails } = await stocked(w);
  const who = { name: 'Karim', phone: '0600000001' };
  const a = await w.emp.sale({ lines: [{ productId: nails.id, qty: 2 }], paid: '0', customer: who });   // 10.00
  const b = await w.emp.sale({ lines: [{ productId: nails.id, qty: 4 }], paid: '0', customer: who });   // 20.00
  const r = await w.emp.collect({ phone: '+212600000001' }, '15');
  assert.deepEqual(r.settled.map(x => x.amount), [1000, 500]);           // A fully, B partly
  const open = await w.emp.reports.openInvoices({ customer_id: r.customer.id });
  assert.equal(open.length, 1);
  assert.equal(open[0].invoice_no, b.invoice.invoice_no);
  assert.equal(open[0].remaining, 1500);
  assert.equal((await w.emp.reports.customers())[0].balance, 1500);
  await rejects(w.emp.collect({ phone: who.phone }, '15.01'), 'OVERPAYMENT');
  await w.emp.collect({ phone: who.phone }, '15');
  assert.equal((await w.emp.reports.customers())[0].balance, 0);
  assert.deepEqual(await w.owner.reports.integrityCheck(), []);
});

test('till closing is blind for the employee; the difference is recorded and becomes the official balance', async () => {
  const w = await world();
  await w.owner.deposit('100');
  await w.owner.cash.open();
  await w.emp.quickSale('50');                                           // expected 150
  const st = await w.emp.cash.status();
  assert.equal(st.open, true); assert.equal(st.opening_balance, 10000);
  assert.equal(st.expected_now, undefined);                              // never shown
  const res = await w.emp.cash.close('140');
  assert.deepEqual(res, { closed: true });                               // no expected, no difference
  assert.equal(await w.owner.reports.cashBalance(), 14000);              // counted = official
  const [adj] = await w.owner.reports.invoices({ type: 'cash_adjustment' });
  assert.equal(adj.cash_effect, -1000);
  await rejects(w.emp.reports.cashBalance(), 'PERMISSION_DENIED');
  const next = await w.owner.cash.open();
  assert.equal(next.opening_balance, 14000);                             // tomorrow opens with the counted amount
});

test('permissions set by the owner from Settings', async () => {
  const w = await world();
  await rejects(w.emp.deposit('10'), 'PERMISSION_DENIED');
  await rejects(w.emp.products.create({ name: 'x', qty: 5 }), 'PERMISSION_DENIED');           // initial stock = manage_stock
  await rejects(w.auth.setUserPermission(w.empS, w.empS.userId, 'cash_deposit_withdraw', true), 'PERMISSION_DENIED');
  await w.auth.setUserPermission(w.ownerS, w.empS.userId, 'cash_deposit_withdraw', true);
  const emp2 = createEngine({ store: w.store, session: await w.auth.login('5678'), now: w.now });
  assert.equal(emp2.permissions.cash_deposit_withdraw, true);
  await emp2.deposit('10');
  const rows = await w.auth.listPermissions(w.ownerS);
  const row = rows.find(r => r.key === 'cash_deposit_withdraw');
  assert.equal(row.allowed, true); assert.equal(row.customized, true);
  await w.auth.resetUserPermissions(w.ownerS, w.empS.userId, 'cash_deposit_withdraw');
  await w.auth.setDefaultPermission(w.ownerS, 'expense', false);
  const emp3 = createEngine({ store: w.store, session: await w.auth.login('5678'), now: w.now });
  assert.equal(emp3.permissions.cash_deposit_withdraw, false);
  assert.equal(emp3.permissions.expense, false);
  await rejects(emp3.expense('5', 'x'), 'PERMISSION_DENIED');
  await w.auth.setEmployeeActive(w.ownerS, w.empS.userId, false);
  await rejects(w.auth.login('5678'), 'BAD_CODE');
});

test('all or nothing: a failure in the middle writes NOTHING', async () => {
  const w = await world();
  const { nails } = await stocked(w);
  const before = w.store.export();
  await rejects(w.emp.sale({ lines: [{ productId: nails.id, qty: 1 }, { productId: 'nope', qty: 1 }] }), 'UNKNOWN_PRODUCT');
  assert.deepEqual(w.store.export(), before);
  // an unbalanced draft that slips past the builders is caught by the final check and rolled back
  const ctx = { store: w.store, access: createAccess({ role: 'owner' }), ids: () => crypto.randomUUID(), now: w.now };
  await rejects(w.store.transaction((tx) => postInvoice(ctx, tx, { type: 'sale', total: 500, paid: 500, credit_amount: 0, cash_effect: 500,
    lines: [{ kind: 'quick', name: 'x', qty: 1000, unit_price: 60000, unit_cost: 0 }] })), 'CHECK_FAILED');   // total 5.00 but the line says 6.00
  assert.deepEqual(w.store.export(), before);
});

test('ledgers and invoices are frozen', async () => {
  const w = await world();
  const q = await w.emp.quickSale('8');
  await rejects(w.store.transaction((tx) => tx.update('cash_ledger', (w.store.export().cash_ledger[0]).id, { amount: 1 })), 'APPEND_ONLY');
  await rejects(w.store.transaction((tx) => tx.update('invoices', q.invoice.id, { total: 1 })), 'INVOICE_FROZEN');
  await rejects(w.store.transaction((tx) => tx.deleteAll('invoices')), 'APPEND_ONLY');
});

test('products: names unique, SKU never reused, search digits=SKU letters=name, import rules', async () => {
  const w = await world();
  const a = await w.owner.products.create({ name: 'Marteau', salePrice: '40' });
  await rejects(w.owner.products.create({ name: '  marteau ' }), 'PRODUCT_EXISTS');
  const b = await w.owner.products.create({ name: 'Scie' });
  assert.deepEqual([a.sku, b.sku], ['01', '02']);
  await w.owner.products.remove(b.id);
  const c = await w.owner.products.create({ name: 'Clou' });
  assert.equal(c.sku, '03');                                                // SKU 2 stays reserved
  await rejects(w.owner.products.create({ name: 'Autre', sku: '02' }), 'SKU_TAKEN');
  assert.equal((await w.owner.products.search('01'))[0].name, 'Marteau');
  assert.equal((await w.owner.products.search('cl'))[0].name, 'Clou');
  await rejects(w.emp.products.remove(a.id), 'PERMISSION_DENIED');
  const rep = await w.owner.products.import([{ name: 'Vis', qty: '10', purchasePrice: '1', salePrice: '2' }, { name: '' }, { name: 'vis' }, { name: 'Marteau' }, { name: 'Pince' }]);
  assert.equal(rep.created, 2); assert.equal(rep.skipped.length, 2);
  const [vis] = await w.owner.products.search('vis');
  assert.equal(vis.qty, 10000); assert.equal(vis.purchase_price, 10000);
  assert.deepEqual(await w.owner.reports.integrityCheck(), []);
});

test('invoice numbers aammjjooo and the text invoice', async () => {
  const w = await world();
  const a = await w.emp.quickSale('8');
  const b = await w.emp.quickSale('9');
  assert.equal(a.invoice.invoice_no, '61113001');
  assert.equal(b.invoice.invoice_no, '61113002');
  const msg = await w.emp.share.invoiceMessage(a.invoice.invoice_no);
  assert.match(msg.text, /\*عقاقير العيادي\*/);
  assert.match(msg.text, /Fact n° : 61113001/);
  assert.match(msg.text, /13 nov 2026/);
  assert.match(msg.text, /\*Montant total : 8 DH\*/);
  assert.match(msg.text, /Tel : 0663152474/);
  assert.equal(msg.link, null);                                          // no party on a quick sale
});

test('store value live, daily report, reminder, reset keeps the stock', async () => {
  const w = await world();
  const { nails } = await stocked(w);                                    // cash 930, stock 20 x 4 = 80, supplier owes 10
  await w.emp.sale({ lines: [{ productId: nails.id, qty: 2 }], paid: '4', customer: { name: 'Karim', phone: '0600000001' } });   // +4 cash, customer owes 6
  const v = await w.owner.reports.storeValue();
  assert.equal(v.cash, 93000 + 400);
  assert.equal(v.stock, 18 * 4 * 100);
  assert.equal(v.customer_debts, 600);
  assert.equal(v.supplier_dues, 1000);
  assert.equal(v.store_value, 93400 + 7200 + 600 - 1000);
  await rejects(w.emp.reports.storeValue(), 'PERMISSION_DENIED');
  const [day] = await w.owner.reports.dailyReport();
  assert.equal(day.day, '2026-11-13');
  assert.equal(day.gross_profit, 200);                                   // 2 x (5 - 4)
  const cust = (await w.emp.reports.customers())[0];
  const rem = await w.emp.share.reminder(cust.id);
  assert.match(rem.text, /6 DH/);
  assert.match(rem.link, /^https:\/\/wa\.me\/212600000001\?text=/);
  const res = await w.owner.admin.resetOperations();
  assert.equal(res.products_kept, 1);
  assert.equal(await w.owner.reports.cashBalance(), 0);
  assert.equal((await w.owner.products.search('01'))[0].qty, 18000);
  assert.equal((await w.owner.products.search('01'))[0].purchase_price, 40000);
  assert.equal((await w.emp.reports.customers()).length, 0);
  assert.deepEqual(await w.owner.reports.integrityCheck(), []);
  await rejects(w.emp.admin.resetOperations(), 'PERMISSION_DENIED');
});

test('persistence hook: only changed rows are saved, a failing disk rolls the operation back', async () => {
  const saved = [];
  let broken = false;
  const persist = async (ch) => { if (broken) throw new Error('disk full'); saved.push(...ch); };
  const store = createMemoryStore(undefined, { persist });
  const auth = createAuth({ store });
  const s = await auth.setupOwner({ name: 'O', code: '1234' });
  const e = createEngine({ store, session: s });
  await e.settings.init();
  saved.length = 0;
  await e.quickSale('8');
  const tables = new Set(saved.map(c => c.table));
  assert.deepEqual([...tables].sort(), ['cash_ledger', 'invoice_lines', 'invoices']);
  broken = true;
  const before = store.export();
  await assert.rejects(e.quickSale('9'), /disk full/);
  assert.deepEqual(store.export(), before);                              // memory rolled back too
  broken = false;
  // reload from the saved rows gives the same state
  const rebuilt = createMemoryStore(store.export());
  assert.deepEqual(rebuilt.export(), store.export());
});

test('invoice search (number, name, phone) and already-returned quantities', async () => {
  const w = await world();
  const { nails } = await stocked(w);
  const s = await w.emp.sale({ lines: [{ productId: nails.id, qty: 4 }], paid: '5', customer: { name: 'Karim', phone: '0600000001' } });
  await w.emp.customerReturn({ invoice: s.invoice.id, lines: [{ originLineId: s.lines[0].id, qty: 1 }] });
  const byName = await w.emp.reports.searchInvoices({ text: 'kar', types: ['sale', 'quick_sale'] });
  assert.equal(byName.length, 1); assert.equal(byName[0].party_name, 'Karim');
  assert.equal((await w.emp.reports.searchInvoices({ text: '0600000001', types: ['sale'] })).length, 1);
  assert.equal((await w.emp.reports.searchInvoices({ text: s.invoice.invoice_no, types: ['sale'] })).length, 1);
  assert.equal((await w.emp.reports.searchInvoices({ text: 'nobody', types: ['sale'] })).length, 0);
  const d = await w.emp.reports.invoice(s.invoice.id);
  assert.equal(d.lines[0].returned, 1000);
  assert.equal(d.party.name, 'Karim');
});

test('quick sale details: whole total distributed, normal-sale freedom, real profit replaces the flat %', async () => {
  const w = await world();
  const A = await w.owner.products.create({ name: 'A', purchasePrice: '10', salePrice: '30', qty: '100' });
  const B = await w.owner.products.create({ name: 'B', purchasePrice: '20', salePrice: '50', qty: '100' });
  const C = await w.owner.products.create({ name: 'C', purchasePrice: '5', salePrice: '12', qty: '100' });
  await w.owner.settings.set('quick_sale_profit_pct', 10);
  const q = await w.emp.quickSale('500');                                   // 10 % flat -> estimated profit 50
  assert.equal(q.invoice.profit, 5000);
  assert.equal((await w.emp.reports.pendingQuickSales()).count, 1);
  let [day] = await w.owner.reports.dailyReport();                          // the example of the owner: 500 undetailed at 10 % = 50
  assert.equal(day.undetailed_total, 50000); assert.equal(day.estimated_profit, 5000); assert.equal(day.real_profit, 0);

  const lines = [{ productId: A.id, qty: 3 }, { productId: B.id, qty: 4 }, { productId: C.id, qty: 10 }];   // default prices: 90+200+120 = 410
  const pv = await w.emp.previewQuickDetail({ invoice: q.invoice.id, lines });
  assert.equal(pv.distributed, 41000); assert.equal(pv.remaining, 9000);
  await rejects(w.emp.detailQuickSale({ invoice: q.invoice.id, lines }), 'DETAIL_TOTAL_MISMATCH');           // 90 not distributed yet
  // nothing is shared out automatically: the option does not exist any more, and a partial list simply cannot be saved
  const noAuto = await w.emp.previewQuickDetail({ invoice: q.invoice.id, lines, autoDistribute: true });
  assert.equal(noAuto.remaining, 9000);
  assert.equal((await w.emp.reports.pendingQuickSales()).count, 1);

  const mine = [{ productId: A.id, qty: 3, price: '40' }, { productId: B.id, qty: 4, price: '60' }, { productId: C.id, qty: 10, price: '14' }];   // 120+240+140
  const before = w.store.export();
  assert.equal((await w.emp.previewQuickDetail({ invoice: q.invoice.id, lines: mine })).remaining, 0);
  assert.deepEqual(w.store.export(), before);                              // a preview writes nothing
  const cash0 = await w.owner.reports.cashBalance();
  const d = await w.emp.detailQuickSale({ invoice: q.invoice.id, lines: mine });
  assert.equal(d.invoice.invoice_no, `${q.invoice.invoice_no}-D`);
  assert.equal(d.invoice.total, 50000);
  assert.equal(d.real_profit, 34000);                                      // 500 - (3x10 + 4x20 + 10x5)
  assert.equal(await w.owner.reports.cashBalance(), cash0);                // no external item: no cash moves
  [day] = await w.owner.reports.dailyReport();
  assert.equal(day.gross_profit, 34000); assert.equal(day.estimated_profit, 0); assert.equal(day.real_profit, 34000);
  assert.equal(day.sales_total, 50000); assert.equal(day.sales_count, 1);
  assert.equal((await w.emp.reports.pendingQuickSales()).count, 0);
  const stock = Object.fromEntries((await w.owner.products.search('', 10)).map(p => [p.name, p.qty]));
  assert.deepEqual(stock, { A: 97000, B: 96000, C: 90000 });
  const view = await w.emp.reports.invoice(q.invoice.id);
  assert.equal(view.has_detail, true); assert.equal(view.lines.length, 3); assert.equal(view.real_profit, 34000);
  assert.equal((await w.emp.reports.invoices()).filter(i => i.type === 'quick_detail').length, 0);        // internal record hidden
  await rejects(w.emp.detailQuickSale({ invoice: q.invoice.id, lines: mine }), 'ALREADY_DETAILED');       // once only
  const msg = await w.emp.share.invoiceMessage(q.invoice.invoice_no);
  assert.match(msg.text, /1- A   3×40   120/); assert.match(msg.text, /Montant total : 500 DH/);

  // a return after the details works on the detail lines, at the real price and cost
  const ret = await w.emp.customerReturn({ invoice: q.invoice.invoice_no, lines: [{ originLineId: view.lines[0].id, qty: 1 }] });
  assert.equal(ret.refunded, 4000);                                        // one A at 40
  assert.equal(ret.invoice.profit, -3000);                                 // 40 - cost 10
  assert.equal((await w.owner.products.search('01'))[0].qty, 98000);

  // external product: its cost leaves the till, the profit is price - cost
  const q2 = await w.emp.quickSale('100');
  const cash1 = await w.owner.reports.cashBalance();
  const d2 = await w.emp.detailQuickSale({ invoice: q2.invoice.id, lines: [{ productId: A.id, qty: 1, price: '60' }, { external: { name: 'X', cost: '30', price: '40', qty: 1 } }] });
  assert.equal(d2.real_profit, 6000);                                      // 100 - (10 + 30)
  assert.equal(await w.owner.reports.cashBalance(), cash1 - 3000);
  assert.deepEqual(await w.owner.reports.integrityCheck(), []);

  // below cost: same alert as a normal sale
  const q3 = await w.emp.quickSale('5');
  await rejects(w.emp.detailQuickSale({ invoice: q3.invoice.id, lines: [{ productId: A.id, qty: 1, price: '5' }] }), 'BELOW_COST');
  const d3 = await w.emp.detailQuickSale({ invoice: q3.invoice.id, lines: [{ productId: A.id, qty: 1, price: '5' }], allowBelowCost: true });
  assert.equal(d3.real_profit, -500);

  // a quick sale already returned as a lump cannot be detailed; only quick sales can; no dedicated permission needed
  const q4 = await w.emp.quickSale('100');
  await w.emp.customerReturn({ invoice: q4.invoice.id, lines: [{ originLineId: q4.lines[0].id, qty: 1 }] });
  await rejects(w.emp.detailQuickSale({ invoice: q4.invoice.id, lines: [{ productId: A.id, qty: 1 }] }), 'HAS_RETURNS');
  const s = await w.emp.sale({ lines: [{ productId: A.id, qty: 1 }] });
  await rejects(w.emp.detailQuickSale({ invoice: s.invoice.id, lines: [{ productId: A.id, qty: 1 }] }), 'BAD_PARENT');
  assert.equal((await import('./permissions.js')).CATALOG.some(p => p.key === 'detail_quick_sale'), false);
  // same rules as a normal sale for the employee: price edits and external items follow their permissions
  await w.auth.setUserPermission(w.ownerS, w.empS.userId, 'edit_sale_price', false);
  const emp2 = createEngine({ store: w.store, session: await w.auth.login('5678'), now: w.now });
  const q5 = await emp2.quickSale('60');
  await rejects(emp2.detailQuickSale({ invoice: q5.invoice.id, lines: [{ productId: A.id, qty: 2, price: '25' }] }), 'PERMISSION_DENIED');   // price differs from the product's
  await emp2.detailQuickSale({ invoice: q5.invoice.id, lines: [{ productId: A.id, qty: 2 }] });                                                  // really sold at 30 x 2 = 60: saved
  const q6 = await emp2.quickSale('70');                                                                                                        // 70 cannot be reached at the real prices -> stays undetailed
  await rejects(emp2.detailQuickSale({ invoice: q6.invoice.id, lines: [{ productId: A.id, qty: 2 }] }), 'DETAIL_TOTAL_MISMATCH');
});

test('party statement: every invoice of a customer with what is still owed', async () => {
  const w = await world();
  const { nails } = await stocked(w);
  const who = { name: 'Karim', phone: '0600000001' };
  const a = await w.emp.sale({ lines: [{ productId: nails.id, qty: 2 }], paid: '4', customer: who });   // owes 6
  await w.emp.sale({ lines: [{ productId: nails.id, qty: 4 }], paid: '0', customer: who });             // owes 20
  const cust = (await w.emp.reports.customers())[0];
  await w.emp.collect({ id: cust.id }, '10');                                                           // oldest first: 6 then 4
  const st = await w.emp.reports.partyStatement({ customer_id: cust.id });
  const by = Object.fromEntries(st.map(i => [i.type + ':' + i.total, i.remaining]));
  assert.equal(st.length, 3);
  assert.equal(by['sale:1000'], 0);                                                                      // first invoice settled
  assert.equal(by['sale:2000'], 1600);                                                                   // 20 - 4
  assert.equal(by['collect:1000'], 0);
});

test('backup: export, verified restore, tampered file refused, restore replaces everything', async () => {
  const w = await world();
  const { nails } = await stocked(w);
  await w.emp.sale({ lines: [{ productId: nails.id, qty: 3 }], paid: '5', customer: { name: 'Karim', phone: '0600000001' } });
  await w.emp.quickSale('40');
  await rejects(w.emp.admin.backup(), 'PERMISSION_DENIED');
  assert.equal(await w.owner.admin.lastBackupAt(), null);
  const file = await w.owner.admin.backup();
  assert.notEqual(await w.owner.admin.lastBackupAt(), null);
  const json = JSON.parse(JSON.stringify(file));                           // what really travels in a .json file
  const v = await w.owner.admin.verifyBackup(json);
  assert.equal(v.ok, true); assert.equal(v.counts.customers, 1);

  // an edited file is refused before anything is touched
  const bad = JSON.parse(JSON.stringify(file));
  bad.state.cash_ledger[0].amount += 100;
  assert.equal((await w.owner.admin.verifyBackup(bad)).ok, false);
  const before = w.store.export();
  await rejects(w.owner.admin.restoreBackup(bad), 'BACKUP_CORRUPT');
  assert.deepEqual(w.store.export(), before);
  await rejects(w.owner.admin.verifyBackup({ format: 'other' }), 'BAD_BACKUP');
  const noOwner = JSON.parse(JSON.stringify(file)); noOwner.state.app_users = noOwner.state.app_users.filter(u => u.role !== 'owner');
  await rejects(w.owner.admin.verifyBackup(noOwner), 'BAD_BACKUP');

  // restore into a brand new device
  const saved = []; const store2 = createMemoryStore(undefined, { persist: async (ch) => { saved.push(...ch); } });
  const auth2 = createAuth({ store: store2 });
  await auth2.setupOwner({ name: 'Other', code: '9999' });
  const o2 = createEngine({ store: store2, session: await auth2.login('9999') });
  await o2.settings.init();
  const counts = await o2.admin.restoreBackup(json);
  assert.equal(counts.invoices, v.counts.invoices);
  assert.equal(saved[saved.length - counts.invoices - 1] !== undefined, true);
  assert.equal(saved.some(c => c.op === 'wipe'), true);                    // the disk is wiped then refilled in one transaction
  assert.deepEqual(store2.export(), json.state);
  const owner2 = createEngine({ store: store2, session: await createAuth({ store: store2 }).login('1234') });           // the codes come with the backup
  assert.equal(await owner2.reports.cashBalance(), await w.owner.reports.cashBalance());
  assert.deepEqual(await owner2.reports.integrityCheck(), []);
});

test('stock: owner edits quantity / prices / SKU, journaled; CSV export', async () => {
  const w = await world();
  const a = await w.owner.products.create({ name: 'Marteau; "XL"', purchasePrice: '30', salePrice: '40', qty: '10' });
  const b = await w.owner.products.create({ name: 'Clou', purchasePrice: '0,5', salePrice: '1', qty: '0' });
  await w.owner.products.setQty(a.id, '7,5');
  assert.equal((await w.owner.products.search('01'))[0].qty, 7500);
  await rejects(w.emp.products.setQty(a.id, '1'), 'PERMISSION_DENIED');
  await w.owner.products.update(a.id, { name: 'Marteau XL', purchasePrice: '31', salePrice: '42', sku: '09' });
  const u = (await w.owner.products.search('09'))[0];
  assert.equal(u.sku, '09'); assert.equal(u.purchase_price, 310000); assert.equal(u.sale_price, 420000);
  await rejects(w.owner.products.update(b.id, { sku: '09' }), 'SKU_TAKEN');
  const csv = await w.owner.products.exportCsv();
  assert.equal(csv, 'Sku;Produit;PA;AV;Qte\r\n02;Clou;0.5;1;0\r\n09;Marteau XL;31;42;7.5');
  await rejects(w.emp.products.exportCsv(), 'PERMISSION_DENIED');
  const again = await w.owner.products.import(csv.split('\r\n').map(l => l.split(';')).slice(1).map(([sku, name, pa, av, q]) => ({ sku, name, purchasePrice: pa, salePrice: av, qty: q })));
  assert.equal(again.created, 0); assert.equal(again.skipped.length, 2);                                // the exported file re-imports without duplicates
  assert.deepEqual(await w.owner.reports.integrityCheck(), []);
});

test('quick sale: optional customer from the sale screen is attached; no customer = unchanged', async () => {
  const w = await world();
  const a = await w.emp.quickSale('25');
  assert.equal(a.invoice.customer_id, null);
  const b = await w.emp.quickSale('30', { name: 'Ali', phone: '0661234567' });
  assert.ok(b.invoice.customer_id);
  assert.equal(b.invoice.credit_amount, 0);
  assert.equal(b.invoice.total, 3000);
});
test('settings: sale_beep defaults to on and the owner can switch it off', async () => {
  const w = await world();
  assert.equal((await w.owner.settings.get()).sale_beep, true);
  await w.owner.settings.set('sale_beep', false);
  assert.equal((await w.owner.settings.get()).sale_beep, false);
});

test('reset stock: owner only, refused while invoices use products, frees the SKUs for a clean Excel re-import', async () => {
  const w = await world();
  await w.owner.products.create({ name: 'Marteau', purchasePrice: '30', salePrice: '40', qty: '5' });
  await w.owner.products.create({ name: 'Clou', purchasePrice: '1', salePrice: '2', qty: '100' });
  await rejects(w.emp.admin.resetStock(), 'PERMISSION_DENIED');
  const p = (await w.owner.products.search('', 10))[0];
  await w.owner.sale({ paid: '40', lines: [{ productId: p.id, qty: '1', price: '40' }] });
  await rejects(w.owner.admin.resetStock(), 'STOCK_HAS_HISTORY');
  await w.owner.admin.resetOperations();
  const r = await w.owner.admin.resetStock();
  assert.equal(r.products_removed, 2);
  assert.equal((await w.owner.products.search('', 10)).length, 0);
  const imp = await w.owner.products.import([{ sku: '01', name: 'Marteau', purchasePrice: '30', salePrice: '40', qty: '5' }, { sku: '02', name: 'Clou', purchasePrice: '1', salePrice: '2', qty: '100' }]);
  assert.equal(imp.created, 2); assert.equal(imp.skipped.length, 0);
  const again = await w.owner.products.search('', 10);
  assert.deepEqual(again.map((x) => x.sku).sort(), ['01', '02']);
});

test('quick sale details: optional customer typed with the details (sync-safe: stored on the detail record)', async () => {
  const w = await world();
  await w.owner.products.create({ name: 'Marteau', purchasePrice: '30', salePrice: '40', qty: '5' });
  const p = (await w.owner.products.search('', 5))[0];
  const q1 = await w.emp.quickSale('40');
  const d1 = await w.emp.detailQuickSale({ invoice: q1.invoice.id, lines: [{ productId: p.id, qty: '1', price: '40' }], customer: { name: 'Ali', phone: '0661234567' } });
  const inv = await w.owner.reports.invoice(q1.invoice.id);
  assert.equal(inv.party.name, 'Ali');
  assert.equal(inv.invoice.credit_amount, 0);
  assert.equal((await w.owner.reports.invoices({ customerId: inv.party.id })).length, 1);
  assert.equal((await w.owner.reports.partyStatement({ customer_id: inv.party.id })).length, 1);
  assert.equal((await w.owner.share.invoiceMessage(q1.invoice.id)).link.includes('661234567'), true);
  // no customer = as before; half-filled customer is refused
  const q2 = await w.emp.quickSale('40');
  await rejects(w.emp.detailQuickSale({ invoice: q2.invoice.id, lines: [{ productId: p.id, qty: '1', price: '40' }], customer: { name: 'Omar', phone: '' } }), 'PHONE_REQUIRED');
  await w.emp.detailQuickSale({ invoice: q2.invoice.id, lines: [{ productId: p.id, qty: '1', price: '40' }] });
  assert.equal((await w.owner.reports.invoice(q2.invoice.id)).party, null);
});

test('calculator quick sale: one invoice, one line per term, then details link the products and take the stock out', async () => {
  const w = await world();
  const A = await w.owner.products.create({ name: 'A', purchasePrice: '2', salePrice: '4', qty: '50' });
  await w.owner.settings.set('quick_sale_profit_pct', 10);
  // 14+3×5+5×2+18  (quantity = second number of a product)
  const r = await w.emp.calcSale({ lines: [{ price: '14', qty: '1' }, { price: '3', qty: '5' }, { price: '5', qty: '2' }, { price: '18', qty: '1' }] });
  assert.equal(r.invoice.total, 5700); assert.equal(r.invoice.paid, 5700); assert.equal(r.invoice.profit, 570);   // flat 10 %
  assert.deepEqual(r.lines.map((l) => [l.name, l.line_total]), [['produit 1', 1400], ['produit 2', 1500], ['produit 3', 1000], ['produit 4', 1800]]);
  assert.equal(await w.owner.reports.cashBalance(), 5700);
  assert.equal((await w.emp.reports.pendingQuickSales()).count, 1);
  await rejects(w.emp.calcSale({ lines: [{ price: '0', qty: '1' }] }), 'BAD_NUMBER');
  await rejects(w.emp.calcSale({ lines: [] }), 'EMPTY_CART');
  // details: product A replaces "produit 2" (qty 5, invoice price 3 kept although the catalogue says 4); the rest as external items
  await w.auth.setUserPermission(w.ownerS, w.empS.userId, 'edit_sale_price', true);
  const emp2 = createEngine({ store: w.store, session: await w.auth.login('5678'), now: w.now });
  const lines = [{ external: { name: 'x1', cost: '10', price: '14', qty: '1' } }, { productId: A.id, qty: '5', price: '3' },
    { external: { name: 'x3', cost: '4', price: '5', qty: '2' } }, { external: { name: 'x4', cost: '15', price: '18', qty: '1' } }];
  const d = await emp2.detailQuickSale({ invoice: r.invoice.id, lines });
  assert.equal(d.invoice.total, 5700);
  assert.equal((await w.owner.products.search('A', 5))[0].qty, 45000);       // 5 taken out of the stock
  assert.equal((await emp2.reports.pendingQuickSales()).count, 0);
});

test('invoice text: header row, one line per product, forced left-to-right so the total sits at the far right', async () => {
  const { DEFAULT_SETTINGS } = await import('./settings.js');
  const text = renderInvoice({
    invoice: { invoice_no: '61119001', type: 'sale', created_at: '2026-11-19T19:59:00Z', total: 12000, paid: 12000, credit_amount: 0, note: null },
    lines: [{ name: 'منتج 1', qty: 2000, unit_price: 250000, line_total: 5000 }, { name: 'منتج 2', qty: 1000, unit_price: 700000, line_total: 7000 }],
    party: null, settings: { ...DEFAULT_SETTINGS, invoice_template: DEFAULT_SETTINGS.invoice_template },
  });
  const rows = text.split('\n').filter((l) => l.startsWith('\u200E'));
  assert.equal(rows.length, 3);
  assert.match(rows[0], /produit\s+q×p\s+Total/);
  assert.match(rows[1], /^\u200E1- منتج 1\u200E {3}2×25 {3}50$/);          // Arabic name: a left-to-right mark keeps the numbers in order
  assert.match(rows[2], /^\u200E2- منتج 2\u200E {3}1×70 {3}70$/);
});

// ---- buyN codes: <category digit><product number from 1>, product 0 does not exist, category 0 does
test('codes: category digit + product number, numbering per category, no product 0', async () => {
  const w = await world();
  const a = await w.owner.products.create({ name: 'Lampe', cat: '2' }), b = await w.owner.products.create({ name: 'Cable', cat: '2' });
  const c = await w.owner.products.create({ name: 'Colle', cat: '5' }), d = await w.owner.products.create({ name: 'Divers' });
  assert.deepEqual([a.sku, b.sku, c.sku, d.sku], ['21', '22', '51', '01']);
  assert.deepEqual([a.cat, a.num, d.cat, d.num], ['2', 1, '0', 1]);
  await rejects(w.owner.products.create({ name: 'X', sku: '20' }), 'BAD_SKU');          // product 0
  await rejects(w.owner.products.create({ name: 'Y', sku: '5' }), 'BAD_SKU');           // a code needs a product part
  await rejects(w.owner.products.create({ name: 'Z', sku: '2007' }), 'BAD_SKU');        // no leading zero in the product number
  const big = await w.owner.products.create({ name: 'Grand', sku: '5319' });
  assert.deepEqual([big.cat, big.num], ['5', 319]);
  assert.deepEqual((await w.owner.products.search('2')).map((p) => p.sku), ['21', '22']);   // digits = start of the code
  assert.deepEqual((await w.owner.products.search('')).map((p) => p.sku), ['01', '21', '22', '51', '5319']);   // category, then number
});

test('settings: category names and letters layout are validated and saved', async () => {
  const w = await world();
  await w.owner.settings.set('categories', { 0: 'عام', 2: 'Electricite' }); await w.owner.settings.set('letters_layout', 'ar');
  const c = await w.owner.settings.get();
  assert.equal(c.categories[2], 'Electricite'); assert.equal(c.letters_layout, 'ar');
  await rejects(w.owner.settings.set('categories', { 10: 'x' }), 'BAD_CATEGORIES');
  await rejects(w.owner.settings.set('letters_layout', 'fr'), 'BAD_LAYOUT');
  await rejects(w.emp.settings.set('letters_layout', 'ar'), 'PERMISSION_DENIED');
});

test('category statistics: sales, profit, returns and stock per category (first digit of the code)', async () => {
  const w = await world();
  const lamp = await w.owner.products.create({ name: 'Lampe', cat: '2', purchasePrice: '10', salePrice: '15', qty: '10' });
  const glue = await w.owner.products.create({ name: 'Colle', cat: '5', purchasePrice: '4', salePrice: '6', qty: '4' });
  await w.owner.products.create({ name: 'Vis', purchasePrice: '1', salePrice: '2', qty: '0' });
  const s = await w.emp.sale({ lines: [{ productId: lamp.id, qty: 2 }, { productId: glue.id, qty: 1 }], paid: '36' });
  const st = await w.owner.reports.categoryStats({ days: 0 });
  const by = Object.fromEntries(st.cats.map((c) => [c.cat, c]));
  assert.equal(by['2'].revenue, 3000); assert.equal(by['2'].profit, 1000); assert.equal(by['2'].qty, 2000);
  assert.equal(by['5'].revenue, 600); assert.equal(by['2'].stock_count, 1); assert.equal(by['0'].zero_count, 1);
  assert.equal(by['0'].revenue, 0);
  await w.emp.customerReturn({ invoice: s.invoice.invoice_no, lines: [{ originLineId: s.lines[0].id, qty: 1 }] });
  assert.equal((await w.owner.reports.categoryStats({ days: 0 })).cats.find((c) => c.cat === '2').revenue, 1500);   // a return comes back negative
  await rejects(w.emp.reports.categoryStats(), 'PERMISSION_DENIED');
});

test('smart entry: smallest free number per category, planned codes skipped, existing product found by name', async () => {
  const w = await world();
  const a = await w.owner.products.create({ name: 'Peinture', cat: '8' }); await w.owner.products.create({ name: 'Rouleau', cat: '8' });
  assert.equal(await w.owner.products.nextCode('8'), '83');
  assert.equal(await w.owner.products.nextCode('8', ['83', '84']), '85');
  assert.equal(await w.owner.products.nextCode('4'), '41');
  await rejects(w.owner.products.nextCode('12'), 'BAD_CATEGORY');
  assert.equal((await w.owner.products.byName('  peinture ')).sku, '81');
  assert.equal(await w.owner.products.byName('Inconnu'), null);
  await rejects(w.owner.products.create({ name: 'PEINTURE' }), 'PRODUCT_EXISTS');            // never twice
  await w.owner.products.adjustStock(a.id, '3');                                              // the quantity is added instead
  assert.equal((await w.owner.products.byName('Peinture')).qty, 3000);
});

test('purchase: supplier is optional when fully paid, required for a debt', async () => {
  const w = await world();
  const p = await w.owner.products.create({ name: 'Colle', purchasePrice: '2' });
  const r = await w.owner.purchase({ lines: [{ productId: p.id, qty: '3', price: '2' }] });          // paid in full, nobody named
  assert.equal(r.supplier, null); assert.equal(r.invoice.supplier_id, null);
  assert.equal((await w.owner.products.byName('Colle')).qty, 3000);
  await rejects(w.owner.purchase({ lines: [{ productId: p.id, qty: '1', price: '2' }], paid: '1' }), 'NAME_REQUIRED');   // a debt needs a name
  const d = await w.owner.purchase({ supplier: { name: 'Ahmed', phone: '0611223344' }, lines: [{ productId: p.id, qty: '1', price: '2' }], paid: '1' });
  assert.equal(d.invoice.credit_amount, 100);
  assert.deepEqual(await w.owner.reports.integrityCheck(), []);
});

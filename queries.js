// Read-side: balances and live store value are SUMS of the ledgers (never stored numbers).
import { lineCents } from './money.js';
import { getSetting, checkInvoice, remainingDebt, openInvoices } from './post.js';
import { dayParts } from './invoice-number.js';
import { normPhone } from './phone.js';

export const cashBalance = async (tx) => (await tx.all('cash_ledger')).reduce((a, c) => a + c.amount, 0);
const stockValue = async (tx) => (await tx.find('products', p => !p.deleted_at))
  .reduce((a, p) => a + lineCents(Math.max(p.qty, 0), p.purchase_price), 0);
export const partyBalance = async (tx, key, id) => (await tx.find('debt_ledger', d => d[key] === id)).reduce((a, d) => a + d.amount, 0);

// quick sales that already received their product details
const detailedSet = async (tx) => new Set((await tx.find('invoices', i => i.type === 'quick_detail')).map(i => i.parent_invoice_id));


// the whole-database self check (also used to verify a backup file before restoring it)
export async function integrityProblems(tx) {
  const problems = [];
  const movs = await tx.all('stock_movements');
  for (const p of await tx.all('products')) {
    const s = movs.filter(m => m.product_id === p.id).reduce((a, m) => a + m.qty_delta, 0);
    if (s !== p.qty) problems.push({ check: 'product_qty', ref: p.sku, detail: `cache=${p.qty} ledger=${s}` });
  }
  for (const [table, key] of [['customers', 'customer_id'], ['suppliers', 'supplier_id']]) {
    for (const party of await tx.all(table)) {
      const bal = await partyBalance(tx, key, party.id);
      const open = (await openInvoices(tx, { [key]: party.id })).reduce((a, o) => a + o.remaining, 0);
      if (bal !== open) problems.push({ check: `${table}_debt`, ref: party.phone_norm, detail: `ledger=${bal} open_invoices=${open}` });
    }
  }
  for (const i of await tx.all('invoices')) {
    try { await checkInvoice(tx, i.id); } catch (e) { problems.push({ check: 'invoice', ref: i.invoice_no, detail: e.message }); }
  }
  return problems;
}

// parent quick-sale id -> customer typed when its details were added
async function detailCustomers(tx) {
  return new Map((await tx.find('invoices', d => d.type === 'quick_detail' && d.customer_id)).map(d => [d.parent_invoice_id, d.customer_id]));
}

export function queriesApi(ctx) {
  const { store } = ctx;
  // reading invoices is needed by sales, returns, debts and the details of quick sales: any of these rights is enough
  const seeInvoices = () => { if (!['view_invoices', 'quick_sale', 'return_customer', 'return_supplier', 'collect_debt', 'pay_supplier', 'expense', 'cash_count'].some((k) => ctx.access.can(k))) ctx.access.require('view_invoices'); };
  const ownerRead = async (fn) => { ctx.access.requireOwner(); return store.transaction(fn); };
  return {
    cashBalance: () => ownerRead(cashBalance),
    // history of till closings (owner): counted vs expected, with the difference
    cashSessions: () => ownerRead(async (tx) => (await tx.all('cash_sessions')).sort((a, b) => b.opened_at.localeCompare(a.opened_at))),                         // the employee never sees the expected till

    // store value = till + stock at cost + customer debts - supplier dues
    storeValue: () => ownerRead(async (tx) => {
      const debts = await tx.all('debt_ledger');
      const customer_debts = debts.filter(d => d.customer_id).reduce((a, d) => a + d.amount, 0);
      const supplier_dues = debts.filter(d => d.supplier_id).reduce((a, d) => a + d.amount, 0);
      const cash = await cashBalance(tx), stock = await stockValue(tx);
      return { cash, stock, customer_debts, supplier_dues, store_value: cash + stock + customer_debts - supplier_dues };
    }),

    customers: () => store.transaction(async (tx) => {
      const rows = await tx.all('customers');
      return Promise.all(rows.map(async c => ({ ...c, balance: await partyBalance(tx, 'customer_id', c.id) })));
    }),
    suppliers: () => store.transaction(async (tx) => {
      const rows = await tx.all('suppliers');
      return Promise.all(rows.map(async s => ({ ...s, balance: await partyBalance(tx, 'supplier_id', s.id) })));
    }),
    openInvoices: (party) => store.transaction(async (tx) => (await openInvoices(tx, party)).map(o => ({ ...o.invoice, remaining: o.remaining }))),

    // archive: one row per invoice; cost and profit hidden if the account may not see them
    async invoices({ type, customerId, supplierId, limit = 200 } = {}) {
      seeInvoices();
      return store.transaction(async (tx) => {
        const dc = await detailCustomers(tx);
        let rows = await tx.find('invoices', i => i.type !== 'quick_detail' && (!type || i.type === type) && (!customerId || (i.customer_id || dc.get(i.id)) === customerId) && (!supplierId || i.supplier_id === supplierId));
        rows = rows.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
        const detailed = await detailedSet(tx);
        return rows.map(i => ({ ...strip(ctx, i), has_detail: detailed.has(i.id) }));
      });
    },
    // find invoices by number, or by the name / phone of the customer or supplier (used by the return screens)
    async searchInvoices({ text = '', types, limit = 30 } = {}) {
      seeInvoices();
      const t = String(text).trim().toLowerCase();
      const digits = t.replace(/\D/g, '');                         // 0600000001 / +212600000001 / 600000001 all match
      const nums = [...new Set([digits, digits.replace(/^0+/, ''), normPhone(digits)])].filter((x) => x && x.length >= 3);
      return store.transaction(async (tx) => {
        const parties = new Map([...(await tx.all('customers')), ...(await tx.all('suppliers'))].map(p => [p.id, p]));
        const rows = [];
        const detailed = await detailedSet(tx), dc = await detailCustomers(tx);
        for (const i of (await tx.find('invoices', x => x.type !== 'quick_detail' && (!types || types.includes(x.type)))).sort((a, b) => b.created_at.localeCompare(a.created_at))) {
          const p = parties.get(i.customer_id || dc.get(i.id) || i.supplier_id);
          const hit = !t || i.invoice_no.includes(t) || (p && (p.name.toLowerCase().includes(t) || nums.some((n) => p.phone_norm.includes(n))));
          if (hit) rows.push({ ...strip(ctx, i), party_name: p?.name ?? null, party_phone: p?.phone ?? null, has_detail: detailed.has(i.id) });
          if (rows.length >= limit) break;
        }
        return rows;
      });
    },
    async invoice(idOrNo) {
      seeInvoices();
      return store.transaction(async (tx) => {
        const inv = (await tx.find('invoices', i => i.id === idOrNo || i.invoice_no === idOrNo))[0];
        if (!inv) return null;
        const detail = inv.type === 'quick_sale' ? (await tx.find('invoices', d => d.type === 'quick_detail' && d.parent_invoice_id === inv.id))[0] : null;
        const eff = detail || inv;                                   // a detailed quick sale shows (and returns) its product lines
        const lines = (await tx.find('invoice_lines', l => l.invoice_id === eff.id)).sort((a, b) => a.line_no - b.line_no);
        const returns = await tx.find('invoices', r => r.parent_invoice_id === inv.id || r.parent_invoice_id === eff.id);
        const remaining = await remainingDebt(tx, inv);
        const allLines = await tx.all('invoice_lines');
        const returned = (id) => allLines.filter(x => x.origin_line_id === id).reduce((a, x) => a + x.qty, 0);   // already returned quantity
        const custId = inv.customer_id || detail?.customer_id;
        const party = custId ? await tx.get('customers', custId) : inv.supplier_id ? await tx.get('suppliers', inv.supplier_id) : null;
        return { invoice: strip(ctx, inv), has_detail: !!detail, quick_pending: inv.type === 'quick_sale' && !detail, real_profit: detail ? inv.profit + detail.profit : null, party, lines: lines.map(l => ({ ...stripLine(ctx, l), returned: returned(l.id) })), returns: returns.map(r => strip(ctx, r)), remaining };
      });
    },

    // quick sales still waiting for their product details (the employee is asked to complete them)
    async pendingQuickSales() {
      seeInvoices();
      return store.transaction(async (tx) => {
        const detailed = await detailedSet(tx);
        const rows = (await tx.find('invoices', i => i.type === 'quick_sale' && !detailed.has(i.id))).sort((a, b) => a.created_at.localeCompare(b.created_at));
        return { count: rows.length, total: rows.reduce((a, i) => a + i.total, 0), oldest: rows[0]?.created_at ?? null };
      });
    },

    // archive of one customer / supplier with the remaining amount of each invoice
    async partyStatement({ customer_id, supplier_id }) {
      seeInvoices();
      return store.transaction(async (tx) => {
        const dc = await detailCustomers(tx);
        const rows = (await tx.find('invoices', i => i.type !== 'quick_detail' && (customer_id ? (i.customer_id || dc.get(i.id)) === customer_id : i.supplier_id === supplier_id)))
          .sort((a, b) => b.created_at.localeCompare(a.created_at));
        const out = [];
        for (const i of rows) out.push({ ...strip(ctx, i), remaining: await remainingDebt(tx, i) });
        return out;
      });
    },

    // owner report: profit recognised at sale, returns come back negative, then expenses
    dailyReport: () => ownerRead(async (tx) => {
      const tz = await getSetting(tx, 'timezone', 'Africa/Casablanca');
      const days = new Map();
      const detailed = await detailedSet(tx);
      for (const i of await tx.all('invoices')) {
        const k = dayParts(new Date(i.created_at), tz).key;
        const d = days.get(k) || { day: k, sales_count: 0, sales_total: 0, returns_total: 0, gross_profit: 0, expenses: 0, net_profit: 0, undetailed_total: 0, undetailed_count: 0, estimated_profit: 0, real_profit: 0 };
        if (i.type === 'sale' || i.type === 'quick_sale') { d.sales_count++; d.sales_total += i.total; d.gross_profit += i.profit; }
        if (i.type === 'quick_sale' && !detailed.has(i.id)) { d.undetailed_count++; d.undetailed_total += i.total; d.estimated_profit += i.profit; }   // flat % estimate
        if (i.type === 'return_customer') { d.returns_total += i.total; d.gross_profit += i.profit; }
        if (i.type === 'quick_detail') d.gross_profit += i.profit;      // real profit replaces the flat %
        if (i.type === 'expense') d.expenses += i.total;
        d.real_profit = d.gross_profit - d.estimated_profit;
        d.net_profit = d.gross_profit - d.expenses;
        days.set(k, d);
      }
      return [...days.values()].sort((a, b) => b.day.localeCompare(a.day));
    }),

    // owner report per category (first digit of the code): sales, cost, profit, units sold + current stock. days = 0 means all time.
    categoryStats: ({ days = 30 } = {}) => ownerRead(async (tx) => {
      const since = days > 0 ? new Date(Date.now() - days * 864e5).toISOString() : '';
      const prod = new Map((await tx.all('products')).map((p) => [p.id, p]));
      const cats = new Map();
      const get = (d) => { if (!cats.has(d)) cats.set(d, { cat: d, revenue: 0, cost: 0, profit: 0, qty: 0, stock_count: 0, stock_qty: 0, stock_value: 0, zero_count: 0 }); return cats.get(d); };
      const inv = new Map((await tx.find('invoices', (i) => ['sale', 'quick_detail', 'return_customer'].includes(i.type) && i.created_at >= since)).map((i) => [i.id, i]));
      for (const l of await tx.find('invoice_lines', (x) => inv.has(x.invoice_id))) {
        const sgn = inv.get(l.invoice_id).type === 'return_customer' ? -1 : 1;           // returns come back negative
        const c = get(l.cat || String(prod.get(l.product_id)?.sku || 'x')[0]);            // x = outside the stock
        c.revenue += sgn * l.line_total; c.cost += sgn * l.line_cost; c.qty += sgn * l.qty;
      }
      for (const p of prod.values()) {
        if (p.deleted_at) continue;
        const c = get(String(p.sku)[0]), q = Math.max(p.qty, 0);
        c.stock_count++; c.stock_qty += q; c.stock_value += lineCents(q, p.purchase_price);
        if (!p.purchase_price || !p.sale_price || !p.qty || p.qty < 0) c.zero_count++;
      }
      const list = [...cats.values()].map((c) => ({ ...c, profit: c.revenue - c.cost })).sort((a, b) => (a.cat === 'x') - (b.cat === 'x') || a.cat.localeCompare(b.cat));
      return { days, cats: list };
    }),

    // self-check: must be EMPTY. Anything listed is a number that does not add up.
    integrityCheck: () => ownerRead(integrityProblems),
  };
}
const strip = (ctx, i) => ctx.access.can('view_cost_profit') ? i : (({ cost_total, profit, profit_pct_applied, ...r }) => r)(i);
const stripLine = (ctx, l) => ctx.access.can('view_cost_profit') ? l : (({ unit_cost, line_cost, ...r }) => r)(l);

// Debt payments (FIFO on the oldest invoices), expenses, till deposit/withdrawal, previous debts.
import { fail } from './errors.js';
import { parseMoney } from './money.js';
import { postInvoice, allocateFifo, getSetting } from './post.js';
import { findOrCreateParty } from './parties.js';
import { normPhone } from './phone.js';
import { cashBalance } from './queries.js';

async function resolveParty(tx, table, ref) {
  const cc = await getSetting(tx, 'wa_country_code', '212');
  const p = ref.id ? await tx.get(table, ref.id)
    : (await tx.find(table, r => r.phone_norm === normPhone(ref.phone, cc)))[0];
  if (!p) fail('PARTY_NOT_FOUND', 'Customer / supplier not found');
  return p;
}

export function paymentsApi(ctx) {
  const { store } = ctx;
  const simple = async (type, amount, note, sign) => {
    return store.transaction(async (tx) => {
      const total = parseMoney(amount, 'amount');
      if (total <= 0) fail('BAD_NUMBER', 'Amount must be positive');
      const warnings = [];
      if (sign < 0 && (await cashBalance(tx)) - total < 0) warnings.push({ type: 'CASH_NEGATIVE' });   // allowed, flagged
      const res = await postInvoice(ctx, tx, { type, total, paid: total, credit_amount: 0, cash_effect: sign * total, note });
      return { ...res, warnings };
    });
  };
  return {
    // collect from a customer: ref = {id} or {phone}
    async collect(ref, amount) {
      ctx.access.require('collect_debt');
      return store.transaction(async (tx) => {
        const c = await resolveParty(tx, 'customers', ref);
        const total = parseMoney(amount, 'amount');
        if (total <= 0) fail('BAD_NUMBER', 'Amount must be positive');
        const settlements = await allocateFifo(tx, { customer_id: c.id }, total);
        const res = await postInvoice(ctx, tx, { type: 'collect', customer_id: c.id, total, paid: total, credit_amount: 0,
          cash_effect: total, debt: [{ customer_id: c.id, amount: -total }], settlements });
        return { ...res, customer: c, settled: settlements };
      });
    },
    async paySupplier(ref, amount) {
      ctx.access.require('pay_supplier');
      return store.transaction(async (tx) => {
        const s = await resolveParty(tx, 'suppliers', ref);
        const total = parseMoney(amount, 'amount');
        if (total <= 0) fail('BAD_NUMBER', 'Amount must be positive');
        const warnings = [];
        if ((await cashBalance(tx)) - total < 0) warnings.push({ type: 'CASH_NEGATIVE' });         // allowed, flagged
        const settlements = await allocateFifo(tx, { supplier_id: s.id }, total);
        const res = await postInvoice(ctx, tx, { type: 'pay_supplier', supplier_id: s.id, total, paid: total, credit_amount: 0,
          cash_effect: -total, debt: [{ supplier_id: s.id, amount: -total }], settlements });
        return { ...res, supplier: s, settled: settlements, warnings };
      });
    },
    async expense(amount, description) {
      ctx.access.require('expense');
      if (!description || !String(description).trim()) fail('DESCRIPTION_REQUIRED', 'Describe the expense');
      return simple('expense', amount, String(description).trim(), -1);
    },
    deposit: (amount, note) => simple('deposit', amount, note, +1),
    withdraw: (amount, note) => simple('withdrawal', amount, note, -1),

    // previous debt written in a paper notebook: { kind:'customer'|'supplier', party:{name,phone}, amount }
    async previousDebt({ kind, party, amount }) {
      const customer = kind === 'customer';
      return store.transaction(async (tx) => {
        const total = parseMoney(amount, 'amount');
        if (total <= 0) fail('BAD_NUMBER', 'Amount must be positive');
        const p = await findOrCreateParty(ctx, tx, customer ? 'customers' : 'suppliers', party);
        const key = customer ? 'customer_id' : 'supplier_id';
        return postInvoice(ctx, tx, { type: customer ? 'opening_debt_customer' : 'opening_debt_supplier', [key]: p.id,
          total, paid: 0, credit_amount: total, cash_effect: 0, debt: [{ [key]: p.id, amount: total }] });
      });
    },
  };
}

// Till sessions. The closing count is BLIND: the employee types what he counted and never sees
// the expected balance. The difference is recorded for good and the counted amount becomes
// the official balance (and tomorrow's opening).
import { fail } from './errors.js';
import { parseMoney } from './money.js';
import { postInvoice, audit } from './post.js';
import { cashBalance } from './queries.js';

export function cashApi(ctx) {
  const { store } = ctx;
  const current = async (tx) => (await tx.find('cash_sessions', s => !s.closed_at))[0];
  return {
    async open() {
      return store.transaction(async (tx) => {
        if (await current(tx)) fail('SESSION_OPEN', 'A cash session is already open');
        const row = await tx.insert('cash_sessions', { id: ctx.ids(), opened_at: ctx.now().toISOString(), opened_by: ctx.userId ?? null,
          opening_balance: await cashBalance(tx), closed_at: null, closed_by: null, counted_amount: null,
          expected_amount: null, difference: null, adjustment_invoice_id: null });
        return ctx.access.isOwner ? row : { id: row.id, opening_balance: row.opening_balance };
      });
    },
    // what the employee sees: only the opening balance
    async status() {
      return store.transaction(async (tx) => {
        const s = await current(tx);
        if (!s) return { open: false };
        return ctx.access.isOwner ? { open: true, ...s, expected_now: await cashBalance(tx) }
          : { open: true, opening_balance: s.opening_balance };
      });
    },
    async close(counted) {
      ctx.access.require('cash_count');
      return store.transaction(async (tx) => {
        const s = await current(tx);
        if (!s) fail('NO_SESSION', 'No open cash session');
        const c = parseMoney(counted, 'counted amount');
        const expected = await cashBalance(tx), diff = c - expected;
        let adj = null;
        if (diff !== 0) {
          adj = (await postInvoice(ctx, tx, { type: 'cash_adjustment', total: Math.abs(diff), paid: Math.abs(diff), credit_amount: 0,
            cash_effect: diff, note: diff > 0 ? 'excess' : 'shortage' })).invoice;
        }
        await tx.update('cash_sessions', s.id, { closed_at: ctx.now().toISOString(), closed_by: ctx.userId ?? null,
          counted_amount: c, expected_amount: expected, difference: diff, adjustment_invoice_id: adj?.id ?? null });
        if (diff !== 0) await audit(ctx, tx, 'cash_difference', 'cash_sessions', s.id, null, { expected, counted: c, difference: diff });
        // blind: the employee learns nothing about the expected balance or the difference
        return ctx.access.isOwner ? { closed: true, expected, counted: c, difference: diff } : { closed: true };
      });
    },
  };
}

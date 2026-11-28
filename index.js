// Entry point.   const engine = createEngine({ store, session, deviceId })
// `session` comes from auth.login(code): the code decides the role, the role decides what is possible.
import { productsApi } from './products.js';
import { salesApi } from './sales.js';
import { purchasesApi } from './purchases.js';
import { returnsApi } from './returns.js';
import { quickDetailApi } from './quick-detail.js';
import { paymentsApi } from './payments.js';
import { cashApi } from './cash.js';
import { queriesApi } from './queries.js';
import { settingsApi } from './settings.js';
import { shareApi } from './share.js';
import { adminApi } from './admin.js';

export { createMemoryStore } from './memory-store.js';
export { createAuth } from './auth.js';
export { EngineError } from './errors.js';
export { CATALOG } from './permissions.js';
export * as money from './money.js';

// Double tap protection: the SAME posting operation (same name, same figures) asked again while the first is still running
// is not run twice: both callers get the answer of the first. A real second sale is never identical-and-simultaneous.
const POSTING = ['sale', 'quickSale', 'calcSale', 'purchase', 'customerReturn', 'supplierReturn', 'detailQuickSale', 'collect', 'paySupplier',
  'expense', 'deposit', 'withdraw', 'previousDebt'];
function guardDoubleTap(engine) {
  const pending = new Map();
  const wrap = (owner, name, label) => {
    const run = owner[name];
    owner[name] = (...args) => {
      let key; try { key = label + JSON.stringify(args); } catch { return run(...args); }
      if (pending.has(key)) return pending.get(key);
      const p = Promise.resolve(run(...args)).finally(() => pending.delete(key));
      pending.set(key, p);
      return p;
    };
  };
  for (const n of POSTING) wrap(engine, n, n);
  wrap(engine.cash, 'close', 'cash.close');
  return engine;
}

export function createEngine({ store, session, deviceId = null, now = () => new Date(), ids = () => globalThis.crypto.randomUUID() }) {
  const ctx = { store, access: session.access, userId: session.userId, deviceId, now, ids };
  return guardDoubleTap({
    permissions: session.permissions,                         // hide what is not allowed
    products: productsApi(ctx),
    ...salesApi(ctx),
    ...purchasesApi(ctx),
    ...returnsApi(ctx),
    ...quickDetailApi(ctx),
    ...paymentsApi(ctx),
    cash: cashApi(ctx),
    reports: queriesApi(ctx),
    settings: settingsApi(ctx),
    share: shareApi(ctx),
    admin: adminApi(ctx),
  });
}

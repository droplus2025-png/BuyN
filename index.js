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

export function createEngine({ store, session, deviceId = null, now = () => new Date(), ids = () => globalThis.crypto.randomUUID() }) {
  const ctx = { store, access: session.access, userId: session.userId, deviceId, now, ids };
  return {
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
  };
}

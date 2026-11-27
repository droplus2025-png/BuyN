// Boot, router, session. Screens live in ui-*.js
import { createMemoryStore, createAuth, createEngine } from './index.js';
import { openPersist } from './idb-persist.js';
import { createSync, supabaseTransport } from './sync.js';
import { SUPABASE } from './sync-config.js';
import { APP_VERSION } from './version.js';
import './viewport.js';
import { toast } from './ui-core.js';
import { renderLogin, renderSetup, renderLocked } from './ui-login.js';
import { renderHome, renderSoon } from './ui-home.js';
import { renderPc, ensureShell, menuOf } from './ui-pc.js';
import { renderSale } from './ui-sale.js';
import { renderCalc } from './ui-calc.js';
import { renderPurchase } from './ui-purchase.js';
import { renderReturn } from './ui-returns.js';
import { renderInvoices } from './ui-invoices.js';
import { renderDebts } from './ui-debts.js';
import { renderExpenses } from './ui-expenses.js';
import { renderCash } from './ui-cash.js';
import { renderStock } from './ui-stock.js';
import { renderAdmin } from './ui-admin.js';

const SCREENS = { login: renderLogin, setup: renderSetup, home: renderHome, soon: renderSoon, sale: renderSale, calc: renderCalc, purchase: renderPurchase, return: renderReturn, invoices: renderInvoices, debts: renderDebts, expenses: renderExpenses, cash: renderCash, stock: renderStock, admin: renderAdmin };
export const app = { screen: null, updatePending: false };

// a pressed button changes colour at once (touch screens: :active is too short to see)
document.addEventListener('pointerdown', (e) => { const b = e.target.closest('button'); if (!b || b.disabled) return; b.classList.add('pressed'); setTimeout(() => b.classList.remove('pressed'), 280); }, true);

const deviceId = localStorage.getItem('buyn_device_id') || (() => { const id = crypto.randomUUID(); localStorage.setItem('buyn_device_id', id); return id; })();

app.go = async (name, params = {}) => {
  app.screen = name; app.syncHook = null;
  const wide = !!app.session && name !== 'login' && name !== 'setup' && matchMedia('(min-width:900px)').matches;
  if (!wide) document.body.classList.remove('pcmode');
  else { if (name === 'sale' || name === 'calc') name = 'home'; ensureShell(app, menuOf(name, params)); }       // computer: shell always there
  if (name === 'home' && wide) { try { return await renderPc(app); } catch (e) { console.error(e); toast(e.message || 'خطأ', true, 4000); return; } }
  if (name === 'home' && app.updatePending) return applyUpdate();
  try { await SCREENS[name](app, params); }
  catch (e) { console.error(e); toast(e.message || 'خطأ', true, 4000); }
};

app.startSession = async (session) => {
  app.session = session;
  app.engine = createEngine({ store: app.store, session, deviceId });
  await app.engine.settings.init();
  app.cfg = await app.engine.settings.get();
  app.go('home');
};
app.refreshCfg = async () => { app.cfg = await app.engine.settings.get(); };
// exit: closes the program. A browser may refuse to close a page it did not open: then a clear screen says so.
app.exit = () => {
  app.session = null; app.engine = null;
  window.close();
  setTimeout(() => {
    document.body.classList.remove('pcmode');
    document.getElementById('app').innerHTML = '<div class="center"><img src="logo.png" alt=""><div>يمكنك الآن إغلاق التطبيق</div><button class="btn gold big" id="reopen" style="min-width:200px">العودة للبرنامج</button></div>';
    document.getElementById('reopen').onclick = () => location.reload();
  }, 300);
};

// ------------------------------------------------------------- sync indicator (a dot in every header)
const SYNC_TIP = { off: '', idle: 'متزامن', syncing: 'جارٍ المزامنة…', offline: 'بلا إنترنت — ستتم المزامنة تلقائياً', error: 'خطأ في المزامنة', badcode: 'مفتاح الجهاز غير صحيح', revoked: 'تم فصل هذا الجهاز', license: 'الترخيص موقوف' };
function paintSync(s) {
  if (s.state === 'idle' && localStorage.getItem(LICENSE_KEY) && !app.sync.leaseExpired()) { localStorage.removeItem(LICENSE_KEY); location.reload(); return; }
  document.querySelectorAll('.sdot').forEach((el) => {
    el.className = `sdot ${s.state}${s.pending ? ' pend' : ''}`;
    el.title = `${SYNC_TIP[s.state] || ''}${s.pending ? ` · ${s.pending} بانتظار الإرسال` : ''}`;
    el.textContent = s.pending && s.state !== 'off' ? s.pending : '';
  });
  app.syncHook?.(s);
}
app.paintSync = () => paintSync(app.sync.status);

// ------------------------------------------------------------- updates (applied only on the home screen)
async function checkUpdate() {
  try {
    const r = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    const v = (await r.json()).version;
    if (v && v !== APP_VERSION) { app.updatePending = true; if (app.screen === 'home' || app.screen === 'login') applyUpdate(); }
  } catch { /* offline: nothing to do */ }
}
function applyUpdate() { toast('تم تحديث البرنامج'); setTimeout(() => location.reload(), 600); }

// PHASE 1: no activation and no password yet (both come in the last phase) -> straight in as owner with a fixed internal code
const DEV = 'buyN-open', LOCK_KEY = 'buyn_locked', LICENSE_KEY = 'buyn_license_lock';

// the owner account of this device (created at the first activation of a shop). A joined device already received it with the shop.
app.enter = async () => {
  if (!(await app.auth.hasOwner())) await app.auth.setupOwner({ name: 'المالك', code: DEV });
  return app.startSession(await app.auth.login(DEV));
};
app.enterJoined = async () => {
  if (!(await app.auth.hasOwner())) { await app.sync.unlink(); throw Object.assign(new Error('SERVER_EMPTY'), { kind: 'server' }); }
  return app.startSession(await app.auth.login(DEV));
};
// the main device disconnected this device. lock: program locked, data kept. wipe: data erased, then the first screen.
app.onRevoked = async (mode) => {
  app.sync.stop();
  app.session = null; app.engine = null;
  if (mode === 'wipe') {
    await app.sync.confirmWipe();
    await app.persist.wipeAll();
    for (const k of ['buyn_device_id', 'buyn_sync_auth', LOCK_KEY]) localStorage.removeItem(k);
    renderLocked(app, { mode: 'wipe' });
  } else {
    localStorage.setItem(LOCK_KEY, '1');
    await app.sync.unlink();
    renderLocked(app, { mode: 'lock' });
  }
};

// the license is suspended / ended, or the device stayed offline past its lease: locked, nothing is deleted.
// It opens again by itself as soon as a contact with the server succeeds.
app.onLicense = (kind) => {
  localStorage.setItem(LICENSE_KEY, kind);
  app.session = null; app.engine = null;
  renderLocked(app, { mode: 'license', kind });
};
const checkLease = () => { if (app.sync.role && !localStorage.getItem(LICENSE_KEY) && app.sync.leaseExpired()) app.onLicense('lease'); };

async function boot() {
  const persist = await openPersist('buyn-db');
  const state = await persist.load();
  app.persist = persist;
  app.store = createMemoryStore(Object.keys(state).length ? state : undefined, { persist: persist.persist });
  app.auth = createAuth({ store: app.store });
  app.sync = createSync({ store: app.store, meta: persist.meta, transport: supabaseTransport(SUPABASE), deviceId, onRevoked: (mode) => app.onRevoked(mode), onLicense: (kind) => app.onLicense(kind) });
  app.sync.onStatus(paintSync);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkUpdate(); });
  setInterval(checkUpdate, 60 * 60 * 1000);
  checkUpdate();
  app.sync.start();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkLease(); });
  setInterval(checkLease, 5 * 60 * 1000);
  if (localStorage.getItem(LOCK_KEY)) return renderLocked(app, { mode: 'lock' });            // disconnected (locked) by the main device: nothing opens until it joins again
  if (!app.sync.role) return app.go('setup');                                               // not activated yet (new device, or one that has not been activated): activation first
  if (localStorage.getItem(LICENSE_KEY)) return renderLocked(app, { mode: 'license', kind: localStorage.getItem(LICENSE_KEY) });
  if (app.sync.leaseExpired()) return app.onLicense('lease');
  if (!(await app.auth.hasOwner())) { if (app.sync.role === 'main') return app.enter(); await app.sync.syncNow(); }
  if (!(await app.auth.hasOwner())) return app.go('setup');
  app.startSession(await app.auth.login(DEV));
}
boot().catch((e) => { console.error(e); document.getElementById('app').innerHTML = `<div class="center"><div class="err">تعذّر تشغيل البرنامج: ${e.message}</div></div>`; });
window.__app = app;           // handy for debugging / tests

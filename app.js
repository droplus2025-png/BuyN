// Boot, router, session. Screens live in ui-*.js
import { createMemoryStore, createAuth, createEngine } from './index.js';
import { openPersist } from './idb-persist.js';
import { createSync, supabaseTransport } from './sync.js';
import { SUPABASE } from './sync-config.js';
import { APP_VERSION } from './version.js';
import './viewport.js';
import { toast } from './ui-core.js';
import { renderLogin, renderSetup } from './ui-login.js';
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
const SYNC_TIP = { off: '', idle: 'متزامن', syncing: 'جارٍ المزامنة…', offline: 'بلا إنترنت — ستتم المزامنة تلقائياً', error: 'خطأ في المزامنة', badcode: 'رمز الربط غير صحيح' };
function paintSync(s) {
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

async function boot() {
  const persist = await openPersist('buyn-db');
  const state = await persist.load();
  app.persist = persist;
  app.store = createMemoryStore(Object.keys(state).length ? state : undefined, { persist: persist.persist });
  app.auth = createAuth({ store: app.store });
  app.sync = createSync({ store: app.store, meta: persist.meta, transport: supabaseTransport(SUPABASE), deviceId });
  app.sync.onStatus(paintSync);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkUpdate(); });
  setInterval(checkUpdate, 60 * 60 * 1000);
  checkUpdate();
  // PHASE 1: no activation and no password yet (both come in the last phase) -> straight in as owner with a fixed internal code
  const DEV = 'buyN-open';
  if (!(await app.auth.hasOwner())) await app.auth.setupOwner({ name: 'المالك', code: DEV });
  app.startSession(await app.auth.login(DEV));
}
boot().catch((e) => { console.error(e); document.getElementById('app').innerHTML = `<div class="center"><div class="err">تعذّر تشغيل البرنامج: ${e.message}</div></div>`; });
window.__app = app;           // handy for debugging / tests

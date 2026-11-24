import { mount, $, esc, header } from './ui-core.js';

// order = right column first, then left column (RTL), as in the reference screen
const TILES = [
  ['suppliers', 'مستحقات الموردين', 'Suppliers Receivables', '🚚'], ['customers', 'ديون الزبناء', 'Customers Debts', '👥'],
  ['expenses', 'مصاريف', 'Expenses', '💸'], ['purchase', 'شراء', 'Purchases', '📦'],
  ['supret', 'ارجاع للمورد', 'Supplier Returns', '↪️'], ['custret', 'ارجاع من زبون', 'Customer Returns', '↩️'],
  ['stock', 'المخزون', 'Inventory', '🏬'], ['cash', 'الصندوق', 'Cash Register', '🧮'],
];
const INVOICES = ['invoices', 'الفواتير', 'Invoices', '🧾'];            // slim full-width row under the two sell buttons
const ADMIN = ['admin', 'الإدارة والإعدادات', 'Administration & Settings', '⚙️'];   // full-width row at the bottom (owner only)
const PERM = { stock: 'view_stock', purchase: 'purchase', expenses: 'expense', supret: 'return_supplier', custret: 'return_customer',
  customers: 'collect_debt', suppliers: 'pay_supplier', cash: 'cash_count', invoices: 'view_invoices' };
const LIVE = { sell: ['sale'], quick: ['calc'], purchase: ['purchase'], stock: ['stock'], admin: ['admin'], custret: ['return', { mode: 'customer' }], supret: ['return', { mode: 'supplier' }],
  invoices: ['invoices'], expenses: ['expenses'], cash: ['cash'], customers: ['debts', { mode: 'customer' }], suppliers: ['debts', { mode: 'supplier' }] };

export function renderHome(app) {
  const p = app.session.permissions, owner = app.session.role === 'owner';
  const now = new Date();
  const d = now.toLocaleDateString('ar-MA-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long' });
  const year = now.getFullYear();
  const tile = ([id, ar, en, ico]) => {
    if (id === 'admin' && !owner) return '';
    const off = id === 'invoices' ? !(p.view_invoices || p.quick_sale) && !owner : PERM[id] && !p[PERM[id]] && !owner;
    return `<button class="tile ${id === 'admin' ? 'admin' : ''}" data-id="${id}" ${off ? 'disabled' : ''}><div class="ico">${ico}</div><div><div class="t1">${ar}</div><div class="t2">${en}</div></div></button>`;
  };
  mount(`<div class="screen">
    <div class="homehead"><img src="logo.png" alt=""><div><div class="name">${esc(app.cfg.store_name)}</div><div class="date">${esc(d)} <span class="yr">${year}</span></div></div></div>
    <div class="body">
      <div class="toprow">
        <button class="tile sell" data-id="sell" ${!p.sell && !owner ? 'disabled' : ''}><div class="ico">🛒</div><div><div class="t1">بيع بالفاتورة</div><div class="t2">اختيار المنتجات من المخزون</div></div></button>
        <button class="tile quick" data-id="quick" ${!p.quick_sale && !owner ? 'disabled' : ''}><div class="ico">⚡</div><div><div class="t1">بيع سريع</div><div class="t2">آلة حاسبة تنتج فاتورة</div></div></button>
      </div>
      <div class="invrow">${tile(INVOICES)}</div>
      <div class="grid2">${TILES.map(tile).join('')}${tile(ADMIN)}</div>
      <button class="btn" id="out" style="margin-top:4px">خروج</button>
    </div></div>`);
  app.pendingCount = 0;
  document.querySelectorAll('.tile').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.id;
    if (id === 'invoices') return app.go('invoices', { filter: app.pendingCount > 0 ? 'pending' : 'all' });   // go straight to what must be completed
    if (LIVE[id]) app.go(...LIVE[id]); else app.go('soon', { title: [...TILES, INVOICES, ADMIN].find((t) => t[0] === id)?.[1] || 'قريباً' });
  }));
  $('#out').onclick = () => app.logout();
  // owner: reminder when no recent backup exists (the data lives on this device only)
  if (owner) app.engine.admin.lastBackupAt().then((t) => {
    if (t && Date.now() - new Date(t) < 3 * 864e5) return;
    document.querySelector('.body')?.insertAdjacentHTML('afterbegin', `<button class="card" id="bk" style="border-color:var(--amber);color:var(--amber);font-weight:700;text-align:center">⚠ ${t ? 'مرّت أكثر من 3 أيام على آخر نسخة احتياطية' : 'لم تُحفظ أي نسخة احتياطية بعد'} — اضغط للحفظ</button>`);
    document.querySelector('#bk')?.addEventListener('click', () => app.go('admin'));
  }).catch(() => {});
  // reminder: quick sales still waiting for their product details
  app.engine.reports.pendingQuickSales().then((r) => {
    app.pendingCount = r.count;
    const tile = document.querySelector('.tile[data-id=invoices]');
    if (r.count && tile) tile.insertAdjacentHTML('beforeend', `<span class="badge">⏳ ${r.count}</span>`);
  }).catch(() => {});
}

export function renderSoon(app, { title }) {
  mount(`<div class="screen">${header(title)}<div class="center"><div style="font-size:3rem">🛠️</div><div>هذه الشاشة قيد البناء</div></div></div>`);
  $('#hdrBack').onclick = () => app.go('home');
}

// PC screen (touch all-in-one, no keyboard): the HOME screen is the sale screen.
//   top bar : logo + shop name (right) · 123⇄abc · system keyboard · notice · date (left)
//   right   : fixed menu · centre : display + 3 modes + keypad · left : panel that follows the mode
// Modes: calc (ordinary calculator) · quick (14+3×5+8 = lines, then pay) · inv (type a code, tap a result).
// The category digit is never shown: a code is just a number to the seller.
import { $, esc, toast, errText, openModal, confirmBox, showStrip, money, price4, qtyStr, priceShort } from './ui-core.js';
import { openExternal } from './ui-external.js';
import { money as M } from './index.js';
import { validPhone } from './phone.js';
import { beep } from './beep.js';
import { parseExpr, termsToLines } from './calc.js';

const MENU = [['home', 'الرئيسية'], ['invoices', 'فواتير'], ['purchase', 'شراء'], ['expenses', 'مصاريف'], ['customers', 'ديون الزبناء'], ['suppliers', 'مستحقات الموردين'],
  ['custret', 'ارجاع من زبون'], ['supret', 'ارجاع للمورد'], ['stock', 'المخزون'], ['cash', 'الصندوق'], ['admin', 'الاعدادات و التقارير']];
const GO = { invoices: ['invoices'], purchase: ['purchase'], expenses: ['expenses'], customers: ['debts', { mode: 'customer' }], suppliers: ['debts', { mode: 'supplier' }],
  custret: ['return', { mode: 'customer' }], supret: ['return', { mode: 'supplier' }], stock: ['stock'], cash: ['cash'], admin: ['admin'] };
const LETTERS = { latin: ['abcde', 'fghijkl', 'mnopqrs', 'tvwxyz'], ar: ['ضصثقفغعهخح', 'شسيبلاتنمك', 'ئءؤرلاىةوز', 'ظطذدجچ'] };
// digit keys + frequent keys double size: x + = and pay take two cells
const NUM = [['1', 1, 1], ['2', 2, 1], ['3', 3, 1], ['⌫', 4, 1, 1, 1, 'fn'], ['C', 5, 1, 1, 1, 'fn'], ['4', 1, 2], ['5', 2, 2], ['6', 3, 2], ['×', 4, 2, 1, 2, 'op big'], ['+', 5, 2, 1, 2, 'op big'],
  ['7', 1, 3], ['8', 2, 3], ['9', 3, 3], ['.', 1, 4], ['0', 2, 4], ['%', 3, 4, 1, 1, 'op'], ['−', 4, 4, 1, 1, 'op'], ['÷', 5, 4, 1, 1, 'op']];


export const menuOf = (n, p = {}) => ({ home: 'home', sale: 'home', calc: 'home', soon: 'home', invoices: 'invoices', purchase: 'purchase', expenses: 'expenses', cash: 'cash', stock: 'stock', admin: 'admin' }[n]
  || (n === 'debts' ? (p.mode === 'supplier' ? 'suppliers' : 'customers') : n === 'return' ? (p.mode === 'supplier' ? 'supret' : 'custret') : 'home'));

// The blue top bar and the blue right menu stay on screen for EVERY screen on the computer; only #work changes.
export function ensureShell(app, active) {
  document.body.classList.add('pcmode');
  if (!$('.pc')) {
    const d = new Date().toLocaleDateString('ar-MA-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    $('#app').innerHTML = `<div class="pc"><div class="pc-top"><div class="brand"><img src="logo.png" alt=""><b></b></div>
      <button class="tb salebtn" id="kbm">123⇄abc</button><button class="tb salebtn" id="sysk" title="لوحة مفاتيح النظام">⌨</button><div class="note" id="note"></div><div class="date">${esc(d)}</div></div>
      <div class="pc-body"><nav class="pc-menu">${MENU.map(([id, t]) => `<button data-id="${id}">${t}</button>`).join('')}</nav><div id="work"></div></div></div>`;
    document.querySelectorAll('.pc-menu button').forEach((b) => b.addEventListener('click', () => (b.dataset.id === 'home' ? app.go('home') : app.go(...GO[b.dataset.id]))));
  }
  $('.brand b').textContent = app.cfg?.store_name || '';
  document.querySelectorAll('.pc-menu button').forEach((b) => b.classList.toggle('on', b.dataset.id === active));
  document.querySelectorAll('.salebtn').forEach((b) => { b.style.visibility = active === 'home' ? 'visible' : 'hidden'; });
  if (active !== 'home') { $('#note').textContent = ''; $('#note').className = 'note'; }
  return $('#work');
}

function evalCalc(src) {
  const e = src.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/(\d+\.?\d*)%/g, '($1/100)');
  if (!e || !/^[\d+\-*/.() ]+$/.test(e)) return null;
  try { const v = Function(`"use strict";return (${e})`)(); return Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : null; } catch { return null; }
}

export async function renderPc(app) {
  const eng = app.engine, cur = String(app.cfg?.currency || '').toLowerCase();
  const work = ensureShell(app, 'home');
  const S = (app.pc ||= { mode: localStorage.getItem('buyn_mode') || 'calc', expr: '', lines: [], cart: [], query: '', kb: 'num' });
  let { mode, expr, lines, cart, query, kb } = S, rows = [], typing = false, busy = false, pending = 0;
  work.innerHTML = `<div class="pc-sale"><main class="pc-center"><input id="disp" class="disp" dir="ltr" readonly inputmode="none" autocomplete="off">
        <div class="modes"><button data-m="inv">بيع بالفاتورة</button><button data-m="quick">بيع سريع</button><button data-m="calc">آلة حاسبة</button></div>
        <div class="keys" id="keys" dir="ltr"></div></main><aside class="pc-left" id="left"></aside></div>`;
  const disp = $('#disp'), keys = $('#keys'), left = $('#left');
  const safe = (fn, dflt = 0) => { try { return fn(); } catch { return dflt; } };
  const lineTotal = (l) => safe(() => M.lineCents(M.parseQty(l.qty || 0), M.parsePrice(l.price || 0)));
  const sum = (a) => a.reduce((s, l) => s + lineTotal(l), 0);
  const total = () => (mode === 'quick' ? sum(lines) : sum(cart));
  const text = () => (mode === 'inv' ? query : expr);

  function paintKeys() {
    if (kb !== 'num' && mode === 'inv') {
      const rowsK = LETTERS[kb === 'ar' ? 'ar' : 'latin'];
      keys.className = 'keys abc';
      keys.innerHTML = rowsK.map((r) => `<div class="kr" ${kb === 'ar' ? 'dir="rtl"' : ''}>${[...r].map((c) => `<button data-k="${c}">${c}</button>`).join('')}</div>`).join('')
        + `<div class="kr"><button data-k=" " class="wide">مسافة</button><button data-k="⌫" class="fn">⌫</button><button data-k="C" class="fn">C</button></div>`;
      return;
    }
    keys.className = 'keys num';
    const cell = ([k, c, r, cs = 1, rs = 1, cls = ''], off) => `<button data-k="${k}" class="${cls}" ${off ? 'disabled' : ''} style="grid-column:${c}/span ${cs};grid-row:${r}/span ${rs}">${k}</button>`;
    const inv = mode === 'inv';
    const ops = new Set(['+', '−', '÷', '%']);
    const eq = mode === 'inv' ? 'إضافة' : '=';
    keys.innerHTML = NUM.map((k) => cell(k, inv && (ops.has(k[0]) || (k[0] === '.')))).join('')
      + `<button data-k="=" class="eq" style="grid-column:1/span ${mode === 'calc' ? 5 : 3};grid-row:5">${eq}</button>`
      + (mode === 'calc' ? '' : `<button data-k="pay" class="pay" style="grid-column:4/span 2;grid-row:5">دفع</button>`);
  }
  function paintLeft() {
    if (mode === 'calc') { left.innerHTML = ''; return; }
    if (mode === 'quick') {
      const T = total();
      left.innerHTML = `<div class="info"><div><span>الاجمالي</span><b>${money(T)}</b></div><div><span>الباقي</span><b>0</b></div></div>
        <input class="f" id="cn" placeholder="اسم الزبون (اختياري)"><input class="f" id="cp" inputmode="tel" placeholder="هاتف الزبون (اختياري)">
        <div class="tbl"><div class="th"><span>منتج</span><span>سعر</span><span>كمية</span></div>${lines.map((l, i) => `<button class="tr" data-i="${i}"><span>${esc(l.name)}</span><span>${esc(l.price)}</span><span>${esc(l.qty)}</span></button>`).join('') || '<div class="muted">اكتب مثل 3+56×7+8 ثم =</div>'}</div>`;
      return;
    }
    const list = query ? `<div class="res-list">${rows.map((p) => `<button class="res ${p.sku === query ? 'exact' : ''}" data-id="${p.id}"><span><b>${p.sku}</b>- ${esc(p.name)}</span><span>${priceShort(p.sale_price)}${esc(cur)}</span><span>A${priceShort(p.purchase_price)} Q${qtyStr(p.qty) || 0}</span></button>`).join('') || '<div class="muted">لا نتائج</div>'}</div>`
      : `<div class="tbl"><div class="th"><span>منتج</span><span>سعر</span><span>كمية</span></div>${cart.map((l, i) => `<button class="tr" data-i="${i}"><span>${l.sku ? `<b>${l.sku}</b>- ` : '＋ '}${esc(l.name)}</span><span>${esc(l.price)}</span><span>${esc(l.qty)}</span></button>`).join('')}</div>`;
    left.innerHTML = `<div class="info"><div><span>الاجمالي</span><b>${money(total())}</b></div></div><button class="ext" id="ext">منتج خارج المخزون +</button>${list}`;
  }

  // ---- the program knows the next step: the key to press next pulses, and the notice says why
  function hint() {
    if (mode === 'calc') return expr ? ['اضغط = لإظهار النتيجة', '='] : ['اكتب العملية الحسابية', null];
    if (mode === 'quick') {
      if (expr) return ['اضغط = لتحويل العملية إلى أسطر', '='];
      if (lines.length) return ['راجع الأسطر ثم اضغط دفع', 'pay'];
      return [pending ? `⏳ ${pending} فواتير سريعة بانتظار التفاصيل — المس هنا` : 'اكتب مثل 3+56×7+8 ثم =', null];
    }
    if (query) {
      if (rows.length === 1) return ['اضغط إضافة، أو المس المنتج', '='];
      if (rows.length > 1) return ['اختر المنتج من القائمة', '.res'];
      return ['لا نتيجة — جرّب اسم المنتج بالحروف، أو منتج خارج المخزون', kb === 'num' ? '#kbm' : '#ext'];
    }
    return cart.length ? ['أضف منتجاً آخر بكتابة كوده، أو اضغط دفع', 'pay'] : ['اكتب كود المنتج، أو abc لاسمه', null];
  }
  function applyHint() {
    document.querySelectorAll('.next').forEach((x) => x.classList.remove('next'));
    const [text, target] = hint(), note = $('#note');
    note.textContent = text; note.className = `note ${mode === 'quick' && pending && !expr && !lines.length ? 'link' : ''}`;
    const el = target && (target[0] === '.' || target[0] === '#' ? document.querySelector(target) : keys.querySelector(`[data-k="${target}"]`));
    if (el && !el.disabled) el.classList.add('next');
  }
  const refreshPending = () => eng.reports.pendingQuickSales().then((r) => { pending = r.count; applyHint(); }).catch(() => {});
  $('#note').onclick = () => { if ($('#note').classList.contains('link')) app.go('invoices', { filter: 'pending' }); };
  function paint() {
    Object.assign(S, { mode, expr, lines, cart, query, kb }); try { localStorage.setItem('buyn_mode', mode); } catch { /* private mode */ }
    if (!typing) disp.value = text() || '0';
    disp.classList.toggle('empty', !text());
    document.querySelectorAll('.modes button').forEach((b) => b.classList.toggle('on', b.dataset.m === mode));
    $('#kbm').classList.toggle('on', kb !== 'num'); $('#kbm').disabled = mode !== 'inv';
    paintKeys(); paintLeft(); applyHint();
  }
  async function load() { if (mode === 'inv' && query) rows = await eng.products.search(query, 40).catch(() => []); paintLeft(); applyHint(); }

  // ---- keys
  function press(k) {
    if (k === 'pay') return pay();
    if (k === '⌫') { if (mode === 'inv') query = query.slice(0, -1); else expr = expr.slice(0, -1); }
    else if (k === 'C') { expr = ''; query = ''; if (mode === 'quick') lines = []; }
    else if (k === '=') return enter();
    else if (mode === 'inv') { if (k === '×') return setQty(); query += k; }
    else {
      const ch = k === '−' ? '−' : k, last = expr.slice(-1);
      if (/[×+−÷]/.test(ch)) { if (!expr) return; expr = /[×+−÷]/.test(last) ? expr.slice(0, -1) + ch : expr + ch; }
      else expr += ch;
    }
    paint(); load();
  }
  keys.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && !b.disabled) { if (app.cfg?.sale_beep !== false) beep(b.dataset.k === 'pay'); press(b.dataset.k); } });
  function enter() {
    if (mode === 'calc') { const v = evalCalc(expr); if (v !== null) expr = String(v); return paint(); }
    if (mode === 'quick') {
      const r = parseExpr(expr.replace(/−/g, '-'));
      if (r.error) return toast('العملية غير صحيحة', true, 1500);
      lines.push(...termsToLines(r.terms, [], lines.length + 1)); expr = ''; return paint();
    }
    const hit = rows.find((p) => p.sku === query) || (rows.length === 1 ? rows[0] : null);
    if (hit) addProduct(hit); else toast('لا نتائج', true, 1200);
  }
  function addProduct(p) {
    const ex = cart.find((l) => l.productId === p.id);
    if (ex) ex.qty = String((Number(ex.qty) || 0) + 1); else cart.push({ kind: 'product', productId: p.id, sku: p.sku, name: p.name, qty: '1', price: price4(p.sale_price) });
    query = ''; rows = []; paint();
  }
  function setQty() {   // the key × in invoice mode: quantity of the last line
    const l = cart[cart.length - 1]; if (!l) return toast('أضف منتجاً أولاً', true, 1200);
    openModal({ title: `الكمية · ${l.name}`, html: `<input id="q" class="inp" inputmode="decimal" value="${esc(l.qty)}">`, buttons: [{ label: 'إلغاء' }, { label: 'حفظ', cls: 'gold', onClick: (c, m) => { l.qty = m.querySelector('#q').value.replace(',', '.') || l.qty; paint(); } }], onOpen: (m) => { const f = m.querySelector('#q'); f.focus(); f.select(); } });
  }
  keys.addEventListener('click', (e) => { const b = e.target.closest('.abc button'); if (b) { /* letters go through press() */ } });

  // ---- modes, keyboard, menu
  document.querySelectorAll('.modes button').forEach((b) => b.addEventListener('click', async () => {
    const m = b.dataset.m; if (m === mode) return;
    if ((lines.length || cart.length) && !(await confirmBox('فاتورة غير مدفوعة', 'تغيير الوضع يمسحها؟', 'مسح', 'بقاء'))) return;
    mode = m; expr = ''; query = ''; lines = []; cart = []; rows = []; kb = 'num'; paint();
  }));
  $('#kbm').onclick = () => { kb = kb === 'num' ? (app.cfg?.letters_layout === 'ar' ? 'ar' : 'latin') : 'num'; paint(); };
  $('#sysk').onclick = () => { typing = !typing; disp.readOnly = !typing; disp.inputMode = typing ? 'text' : 'none'; if (typing) { disp.value = text(); disp.focus(); } else { disp.blur(); paint(); } };
  disp.addEventListener('input', () => { if (mode === 'inv') query = disp.value.trim(); else expr = disp.value; paintLeft(); load(); });
  left.addEventListener('click', (e) => {
    const r = e.target.closest('.res'); if (r) return addProduct(rows.find((p) => p.id === r.dataset.id));
    if (e.target.id === 'ext') return openExternal(app, (v) => { cart.push({ kind: 'ext', name: v.name, qty: v.qty, price: v.price, cost: v.cost }); paint(); });
    const t = e.target.closest('.tr'); if (!t) return; const i = Number(t.dataset.i);
    if (mode === 'quick') { const l = lines[i]; [l.price, l.qty] = [l.qty, l.price]; paint(); }                       // tap = swap price / quantity
    else openModal({ title: cart[i].name, html: `<div class="lbl">السعر</div><input id="p" class="inp" inputmode="decimal" value="${esc(cart[i].price)}"><div class="lbl">الكمية</div><input id="q" class="inp" inputmode="decimal" value="${esc(cart[i].qty)}">`,
      buttons: [{ label: 'حذف', cls: 'danger', onClick: () => { cart.splice(i, 1); paint(); } }, { label: 'حفظ', cls: 'gold', onClick: (c, m) => { cart[i].price = m.querySelector('#p').value.replace(',', '.'); cart[i].qty = m.querySelector('#q').value.replace(',', '.'); paint(); } }] });
  });

  // ---- pay
  async function pay() {
    if (busy || total() <= 0) return;
    const cn = $('#cn')?.value.trim() || '', cp = $('#cp')?.value.trim() || '';
    const c = cn && validPhone(cp, app.cfg?.wa_country_code || '212') ? { name: cn, phone: cp } : null;
    busy = true;
    try {
      if (mode === 'quick') {
        const r = await eng.calcSale({ lines, customer: c });
        showStrip({ ms: 6000, html: `✔ ${esc(r.invoice.invoice_no)} · <b>${money(r.invoice.total)}</b>`, actions: [{ label: 'التفاصيل', cls: 'gold', onClick: () => { document.body.classList.remove('pcmode'); app.go('invoices', { open: r.invoice.id }); } }] });
        lines = []; refreshPending();
      } else await payInvoice(c);
    } catch (e) { toast(errText(e), true, 3500); }
    busy = false; paint();
  }
  async function payInvoice(c, below = false) {
    const T = sum(cart);
    const paid = await new Promise((res) => openModal({ title: `الدفع · ${money(T)}`, html: `<div class="lbl">المبلغ المدفوع</div><input id="pd" class="inp" inputmode="decimal" value="${money(T)}"><div id="dbt" class="chg"></div>
      <div id="cu"><input id="mn" class="inp" placeholder="اسم الزبون" value="${esc(c?.name || '')}"><input id="mp" class="inp" inputmode="tel" placeholder="رقم الهاتف" value="${esc(c?.phone || '')}"></div>`,
      buttons: [{ label: 'إلغاء', onClick: () => res(null) }, { label: 'تأكيد', cls: 'gold', onClick: (cl, m) => res({ paid: m.querySelector('#pd').value, name: m.querySelector('#mn').value.trim(), phone: m.querySelector('#mp').value.trim() }) }],
      onOpen: (m) => { const p = m.querySelector('#pd'), cu = m.querySelector('#cu'), i = m.querySelector('#dbt'); const u = () => { const v = safe(() => M.parseMoney(p.value || 0)); cu.style.display = v < T ? 'flex' : 'none'; i.textContent = v < T ? `دين على الزبون: ${money(T - v)}` : v > T ? `الباقي للزبون: ${money(v - T)}` : ''; }; p.addEventListener('input', u); u(); p.focus(); p.select(); } }));
    if (!paid) return;
    const input = { paid: paid.paid, allowBelowCost: below, lines: cart.map((l) => (l.kind === 'product' ? { productId: l.productId, qty: l.qty, price: l.price } : { external: { name: l.name, cost: l.cost, price: l.price, qty: l.qty } })) };
    if (paid.name || paid.phone) input.customer = { name: paid.name, phone: paid.phone };
    try {
      const r = await eng.sale(input);
      showStrip({ ms: 5000, html: `✔ ${esc(r.invoice.invoice_no)} · <b>${money(r.invoice.total)}</b>` }); cart = [];
    } catch (e) {
      if (e.code === 'BELOW_COST' && await confirmBox('بيع بأقل من التكلفة', `${e.details.items.map((i) => i.name).join('، ')} — هل تريد المتابعة؟`)) return payInvoice({ name: paid.name, phone: paid.phone }, true);
      throw e;
    }
  }
  paint(); refreshPending();
}

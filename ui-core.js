// Small UI helpers: DOM, toast, top-aligned modal, Arabic error messages, header.
import { fmtMoney, fmtPrice, fmtQty } from './money.js';
export const $ = (sel, root = document) => root.querySelector(sel);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function mount(html) { const app = $('#work') || $('#app'); app.innerHTML = html; window.__app?.sync && window.__app.paintSync(); return app; }

export function toast(msg, bad = false, ms = 2200) {
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

const ERR = {
  BAD_CODE: 'كلمة المرور غير صحيحة', WEAK_CODE: 'كلمة المرور قصيرة (4 أحرف على الأقل)', CODE_TAKEN: 'كلمة المرور مستعملة',
  PERMISSION_DENIED: 'غير مسموح لحسابك', BELOW_COST: 'بيع بأقل من التكلفة', CUSTOMER_REQUIRED: 'الاسم والهاتف إلزاميان عند الدين',
  NAME_REQUIRED: 'الاسم مطلوب', PHONE_REQUIRED: 'رقم الهاتف مطلوب (6 أرقام على الأقل)', OVERPAYMENT: 'المبلغ أكبر من المستحق',
  UNKNOWN_PRODUCT: 'منتج غير معروف', EMPTY_CART: 'السلة فارغة', PRODUCT_EXISTS: 'هذا المنتج موجود', SKU_TAKEN: 'هذا الرقم مستعمل',
  BAD_NUMBER: 'رقم غير صالح', TOO_MANY_DECIMALS: 'عدد الخانات العشرية أكثر من المسموح', RETURN_EXCEEDS: 'الكمية أكبر من المباعة',
  STOCK_INSUFFICIENT: 'المخزون لا يكفي', NOT_SETUP: 'لم يتم إنشاء حساب المالك بعد', ALREADY_SETUP: 'حساب المالك موجود',
  CHECK_FAILED: 'خطأ في توازن الأرقام، لم تُحفظ العملية',
  BAD_BACKUP: 'ملف النسخة الاحتياطية غير صالح', BACKUP_CORRUPT: 'الملف تالف أو معدَّل يدوياً، ورُفض حمايةً للبيانات',
  DETAIL_TOTAL_MISMATCH: 'يجب توزيع المبلغ كاملاً على المنتجات', ALREADY_DETAILED: 'تمت إضافة تفاصيل هذه الفاتورة من قبل', HAS_RETURNS: 'لا يمكن تفصيل فاتورة تم إرجاعها',
  BAD_PARENT: 'هذه الفاتورة لا تقبل هذه العملية', CANNOT_ALLOCATE: 'تعذّر توزيع المبلغ على هذه الكميات', INVOICE_NOT_FOUND: 'الفاتورة غير موجودة',
};
export const errText = (e) => ERR[e?.code] || e?.message || 'حدث خطأ';

// modal in the top half of the screen. buttons: [{label, cls, onClick(close)}]; onClick returning false keeps it open
export function openModal({ title, html = '', buttons = [], tall = false, onOpen }) {
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<div class="sheet ${tall ? 'tall' : ''}">${title ? `<h3>${esc(title)}</h3>` : ''}<div class="mbody">${html}</div>
    <div class="row mbtns">${buttons.map((b, i) => (b.row2 ? '' : `<button class="btn ${b.cls || ''}" data-i="${i}" style="flex:1">${esc(b.label)}</button>`)).join('')}</div>
    ${buttons.some((b) => b.row2) ? `<div class="row mbtns2">${buttons.map((b, i) => (b.row2 ? `<button class="btn ${b.cls || ''}" data-i="${i}" style="flex:1">${esc(b.label)}</button>` : '')).join('')}</div>` : ''}</div>`;
  document.body.appendChild(m);
  const close = () => m.remove();
  m.querySelectorAll('.mbtns button, .mbtns2 button').forEach((btn) => btn.addEventListener('click', async () => {
    const r = await buttons[Number(btn.dataset.i)].onClick?.(close, m);
    if (r !== false) close();
  }));
  // Enter: next visible field; on the last one = the gold (confirm) button. The keyboard key is labelled accordingly.
  const fields = () => [...m.querySelectorAll('input:not([type=hidden]):not([disabled]),textarea')].filter((el) => el.offsetParent !== null);
  m.addEventListener('focusin', (e) => { const f = fields(); if (e.target.tagName === 'INPUT') e.target.enterKeyHint = f[f.length - 1] === e.target ? 'done' : 'next'; });
  m.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
    const f = fields(), i = f.indexOf(e.target);
    e.preventDefault();
    if (i >= 0 && i < f.length - 1) f[i + 1].focus(); else m.querySelector('.mbtns .gold')?.click();
  });
  onOpen?.(m, close);
  return { el: m, close };
}
// Non-blocking result strip laid OVER the header (no layout shift, nothing to tap to continue): auto-hides.
export function showStrip({ html, actions = [], ms = 12000, warn = false }) {
  document.querySelector('.strip')?.remove();
  const hdr = document.querySelector('.hdr');
  if (!hdr) { toast(html.replace(/<[^>]+>/g, ' '), warn, 3500); return null; }
  const s = document.createElement('div');
  s.className = 'strip' + (warn ? ' warn' : '');
  s.innerHTML = `<div class="sm">${html}</div>${actions.map((a, i) => `<button class="btn ${a.cls || ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}<button class="btn sx">✕</button>`;
  hdr.appendChild(s);
  const t = setTimeout(() => s.remove(), ms);
  s.querySelector('.sx').onclick = () => { clearTimeout(t); s.remove(); };
  actions.forEach((a, i) => { s.querySelector(`[data-i="${i}"]`).onclick = () => { a.onClick?.(s); if (a.close !== false) { clearTimeout(t); s.remove(); } }; });
  return s;
}
export const confirmBox = (title, text, yes = 'متابعة', no = 'رجوع') => new Promise((res) => openModal({
  title, html: `<div>${esc(text)}</div>`,
  buttons: [{ label: no, onClick: () => res(false) }, { label: yes, cls: 'gold', onClick: () => res(true) }],
}));

// header: back (right) | title (center) | logo (left)
export function header(title, backLabel = 'رجوع') {
  return `<div class="hdr"><button class="back" id="hdrBack">→ ${esc(backLabel)}</button><div class="title">${esc(title)}<span class="sdot off"></span></div><img class="logo" src="logo.png" alt=""></div>`;
}
// display formats come from the engine's own functions (money.js): one definition only
export const money = fmtMoney, price4 = fmtPrice, qtyStr = fmtQty;

// a number computed on screen that may be incomplete while typing: never throws
export const safe = (fn, dflt = 0) => { try { return fn(); } catch { return dflt; } };

// save a Blob / File through the browser's download
export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// open an invoice message in WhatsApp (the customer's chat when known) and remember it was sent
export function sendWhatsApp(eng, msg) {
  const w = window.open(msg.link || `https://wa.me/?text=${encodeURIComponent(msg.text)}`, '_blank');
  eng.share.markSent(msg.invoice_id).catch(() => {});
  return w;
}

// computer: the program points to the next step (notice in the top bar + pulsing target)
export function setNext(text, target) {
  document.querySelectorAll('.next').forEach((x) => x.classList.remove('next'));
  const note = $('#note'); if (note) note.textContent = text;
  if (target) document.querySelector(target)?.classList.add('next');
}

export const TYPE_AR = { sale: 'بيع', quick_sale: 'بيع سريع', quick_detail: 'تفصيل', purchase: 'شراء', deposit: 'إيداع', withdrawal: 'سحب',
  expense: 'مصروف', return_customer: 'إرجاع من زبون', return_supplier: 'إرجاع للمورد', collect: 'قبض دين', pay_supplier: 'دفع للمورد',
  opening_debt_customer: 'دين سابق', opening_debt_supplier: 'مستحق سابق', cash_adjustment: 'تسوية الصندوق' };
// time only (HH:MM): the date is already inside the invoice number (a mm jj ooo)
export const fmtTime = (iso, tz) => { try { return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz || undefined }); } catch { return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); } };
export const fmtWhen = (iso) => new Date(iso).toLocaleString('ar-MA-u-nu-latn', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// Suggestions of KNOWN customers / suppliers while typing a name or a phone: tap one to fill both fields.
// Nobody is ever forgotten (even when everything is paid), so the program completes names and phones by itself.
export function partySuggest(app, kind, nameEl, phoneEl, box) {
  let parties = null;
  const load = async () => (parties ||= await (kind === 'customer' ? app.engine.reports.customers() : app.engine.reports.suppliers()));
  const strip0 = (s) => s.replace(/^0+/, '');
  async function render() {
    const list = await load();
    const qn = nameEl.value.trim().toLowerCase(), qp = strip0(phoneEl.value.replace(/\D/g, ''));
    const byPhone = document.activeElement === phoneEl;
    if (byPhone ? qp.length < 2 : qn.length < 1) { box.innerHTML = ''; return; }
    const hits = list.filter((p) => (byPhone ? p.phone_norm.includes(qp) : p.name.toLowerCase().includes(qn))
      && !(p.name === nameEl.value.trim() && p.phone === phoneEl.value.trim())).slice(0, 5);
    box.innerHTML = hits.length ? `<div class="results" style="max-height:none">${hits.map((p, i) => `
      <button class="res sg" data-i="${i}" style="grid-template-columns:1fr auto;padding:9px 12px"><span><b>${esc(p.name)}</b> <span class="muted" dir="ltr">${esc(p.phone)}</span></span>
      ${p.balance > 0 ? `<span class="pill amber">${kind === 'customer' ? 'دين' : 'مستحق'} ${money(p.balance)}</span>` : '<span class="pill">معروف</span>'}</button>`).join('')}</div>` : '';
    box.querySelectorAll('.sg').forEach((b) => b.addEventListener('click', () => {
      const p = hits[Number(b.dataset.i)];
      nameEl.value = p.name; phoneEl.value = p.phone; box.innerHTML = '';
      nameEl.dispatchEvent(new Event('input')); phoneEl.dispatchEvent(new Event('input'));
    }));
  }
  for (const el of [nameEl, phoneEl]) { el.addEventListener('input', render); el.addEventListener('focus', render); }
  nameEl.setAttribute('autocomplete', 'off'); phoneEl.setAttribute('autocomplete', 'off');
}

// compact display of a price in a narrow column (full precision stays in the edit window)
export const priceShort = (p4) => { const v = p4 / 10000; const s = v >= 1000 ? String(Math.round(v)) : v.toFixed(2).replace(/\.?0+$/, ''); return s || '0'; };

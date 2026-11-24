// Sale screen (v1.2) -- the layout of the three reference sketches, built for speed.
//   QUICK mode  : [customer name | phone] / keypad 4x3 / [pay | total] / [external | search] / stock list
//   NORMAL mode : [customer name | phone] / [external | search] / cart / [pay | total] / stock list
// Touching the stock list (or the search box, or adding anything) leaves quick mode: the keypad and the quick pay row
// disappear, the customer fields stay. The cart and the stock list are always laid out LEFT to RIGHT:
//   list : [Sku- product]  [price]  [A<purchase> Q<quantity>]        cart : [Sku- product]  [p=price]  [Q=quantity]  [X]
// Every button gives a bip, the pay button a double bip (setting: sale_beep).
import { mount, $, esc, header, toast, errText, openModal, confirmBox, showStrip, money, price4, qtyStr, partySuggest, priceShort } from './ui-core.js';
import { openExternal } from './ui-external.js';
import { money as M } from './index.js';
import { validPhone } from './phone.js';
import { beep } from './beep.js';

export async function renderSale(app) {   // "بيع بالفاتورة": the normal sale (cart); the quick sale lives in ui-calc.js
  const eng = app.engine;
  const cur = String(app.cfg?.currency || '').toLowerCase();
  let cart = [];            // {kind:'product', productId, sku, name, qty, price} | {kind:'ext', name, qty, price, cost}
  let quick = '';           // amount typed on the keypad
  let query = '';           // search text
  let normal = true;        // always the NORMAL mode (cart): the quick sale is the calculator screen (ui-calc.js)
  let busy = false;
  let rows = [];            // stock list shown (filtered by the search)

  mount(`<div class="screen">${header('بيع')}
    <div class="body sale2 q" id="sale">
      <div class="colB">
        <div class="s-cust" id="cust">
          <input id="cn" class="s-in" placeholder="اسم الزبون (اختياري)" autocomplete="off">
          <input id="cp" class="s-in" inputmode="tel" placeholder="هاتف الزبون (اختياري)" autocomplete="off">
          <div id="sg" class="s-sg"></div>
        </div>
        <div class="s-kpad" id="kpad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '.', '⌫'].map((k) => `<button class="key ${k === '⌫' ? 'fn' : ''}" data-k="${k}">${k}</button>`).join('')}</div>
        <div class="s-cart" id="cartwrap"></div>
        <div class="s-pay" id="paybar">
          <button class="s-paybtn paybtn" id="pay" data-dbl="1">دفع</button>
          <div class="s-tot"><span class="l">الإجمالي :</span><b id="tot">0</b></div>
        </div>
      </div>
      <div class="colA">
        <div class="s-srow" id="srow">
          <button class="s-ext" id="ext">🔦 منتج خارجي</button>
          <input id="q" class="s-srch" placeholder="🔍 بحث" autocomplete="off">
          <button class="s-toq" id="toQuick" title="بيع سريع">⌨</button>
        </div>
        <div class="s-list" id="list"></div>
      </div>
    </div></div>`);

  const root = $('#sale'), list = $('#list'), cartEl = $('#cartwrap');
  const qIn = $('#q'), cn = $('#cn'), cp = $('#cp');
  const isNormal = () => normal || cart.length > 0;

  // ---- totals (display only: the engine recomputes everything with exact arithmetic)
  const safe = (fn, d = 0) => { try { return fn(); } catch { return d; } };
  const lineTotal = (l) => safe(() => M.lineCents(M.parseQty(l.qty || 0), M.parsePrice(l.price || 0)));
  const cartTotal = () => cart.reduce((a, l) => a + lineTotal(l), 0);
  const quickCents = () => safe(() => M.parseMoney(quick || 0));
  const total = () => (cart.length ? cartTotal() : quickCents());
  function refreshTotals() {
    $('#tot').textContent = isNormal() ? money(cartTotal()) : (quick || '0');
    $('#pay').disabled = busy || total() <= 0;
  }

  // ---- customer (optional; mandatory only for a credit sale, asked again in the pay window)
  const custVal = () => ({ name: cn.value.trim(), phone: cp.value.trim() });
  const custOrNull = () => { const c = custVal(); return c.name && validPhone(c.phone, app.cfg?.wa_country_code || '212') ? c : null; };
  const clearCust = () => { cn.value = ''; cp.value = ''; $('#sg').innerHTML = ''; };
  partySuggest(app, 'customer', cn, cp, $('#sg'));
  cn.enterKeyHint = 'next'; cp.enterKeyHint = 'next';
  cn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); cp.focus(); } });
  cp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); qIn.focus(); } });

  // ---- what is on screen
  function draw() {
    const n = isNormal();
    root.classList.toggle('q', !n); root.classList.toggle('n', n); root.classList.toggle('empty', !cart.length);
    refreshTotals();
    if (n) drawCart();
    renderList();
  }

  // ---- keypad: 1 2 3 4 / 5 6 7 8 / 9 0 . ⌫  (left to right); long press on ⌫ clears everything
  const press = (k) => {
    if (k === '⌫') quick = quick.slice(0, -1);
    else if (k === 'C') quick = '';
    else if (k === '.') { if (!quick.includes('.')) quick = (quick || '0') + '.'; }
    else {
      if (quick.includes('.') && quick.split('.')[1].length + k.length > 2) return;
      if (quick.length + k.length > 9) return;
      quick = quick === '0' && !quick.includes('.') ? k : quick + k;
    }
    refreshTotals();
  };
  document.querySelectorAll('#kpad .key').forEach((b) => {
    let t = null, longed = false;
    const stop = () => clearTimeout(t);
    b.addEventListener('pointerdown', () => { longed = false; if (b.dataset.k === '⌫') t = setTimeout(() => { longed = true; press('C'); }, 600); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, stop));
    b.addEventListener('click', () => { if (longed) { longed = false; return; } press(b.dataset.k); });
  });
  // physical keyboard (touch PC): digits, Backspace, Delete = clear, Enter = pay -- only in quick mode, outside the fields
  const onKey = (e) => {
    if (!document.contains(root)) { document.removeEventListener('keydown', onKey); return; }
    if (isNormal() || document.querySelector('.modal') || /INPUT|TEXTAREA/.test(document.activeElement?.tagName || '')) return;
    if (/^[0-9]$/.test(e.key)) press(e.key); else if (e.key === '.' || e.key === ',') press('.');
    else if (e.key === 'Backspace') press('⌫'); else if (e.key === 'Delete' || e.key === 'Escape') press('C');
    else if (e.key === 'Enter') onPay(); else return;
    if (app.cfg?.sale_beep !== false) beep(e.key === 'Enter');
    e.preventDefault();
  };
  document.addEventListener('keydown', onKey);

  // ---- sound: a bip on every button of the sale screen (and its windows), a double bip on pay
  const onBeep = (e) => {
    if (!document.contains(root)) { document.removeEventListener('pointerdown', onBeep, true); return; }
    if (app.cfg?.sale_beep === false) return;
    const b = e.target.closest('button, .key');
    if (!b || b.disabled) return;
    beep(!!b.closest('[data-dbl]'));
  };
  document.addEventListener('pointerdown', onBeep, true);

  // ---- cart: [Sku- product] [p=price] [Q=quantity] [X]  (left to right)
  function drawCart() {
    cartEl.innerHTML = cart.map((l, i) => `
      <div class="sline ${l.kind === 'ext' ? 'ext' : ''}" data-i="${i}">
        <div class="nm">${l.kind === 'product' ? `<b class="sku">${l.sku}</b>- ` : '＋ '}${esc(l.name)}</div>
        <label class="pf"><b>p=</b><input class="p" inputmode="decimal" value="${esc(l.price)}"></label>
        <label class="pf"><b>Q=</b><input class="n" inputmode="decimal" value="${esc(l.qty)}"></label>
        <button class="x">✖</button></div>`).join('');
    cartEl.querySelectorAll('.sline').forEach((row) => {
      const l = cart[Number(row.dataset.i)];
      const pi = row.querySelector('.p'), ni = row.querySelector('.n');
      [pi, ni].forEach((inp) => inp.addEventListener('focus', () => inp.select()));
      pi.addEventListener('input', () => { l.price = pi.value; refreshTotals(); });
      ni.addEventListener('input', () => { l.qty = ni.value; refreshTotals(); });
      ni.addEventListener('change', renderList);
      pi.enterKeyHint = 'next'; ni.enterKeyHint = 'done';
      pi.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ni.focus(); } });
      ni.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); qIn.focus(); } });     // quantity typed -> straight back to the search
      row.querySelector('.x').addEventListener('click', () => {
        const i = Number(row.dataset.i), [gone] = cart.splice(i, 1); draw();
        showStrip({ warn: true, ms: 5000, html: `حُذف: ${esc(gone.name)}`, actions: [{ label: '↩ تراجع', cls: 'gold', onClick: () => { cart.splice(i, 0, gone); normal = true; draw(); } }] });
      });
    });
  }

  // ---- stock list: [Sku- product] [price] [A<purchase>Q<quantity>]  (left to right). Exact match (number or name) in green.
  function renderList() {
    const q = query.toLowerCase();
    const exact = (p) => !!q && (/^\d+$/.test(q) ? p.sku === q : p.name.toLowerCase() === q);
    const inCart = (p) => { const l = cart.find((x) => x.kind === 'product' && x.productId === p.id); return l ? `<span class="inc">×${esc(l.qty)}</span>` : ''; };
    list.innerHTML = rows.length ? rows.map((p) => `
      <button class="res rs ${exact(p) ? 'exact' : ''}" data-id="${p.id}"><span class="rn"><b class="sku">${p.sku}</b>- ${esc(p.name)}${inCart(p)}</span>
        <span class="rv">${priceShort(p.sale_price)}${esc(cur)}</span>
        <span class="rc"><span class="ra">A${priceShort(p.purchase_price)}</span><span class="rq ${p.qty <= 0 ? 'neg' : ''}">Q${qtyStr(p.qty) || 0}</span></span></button>`).join('')
      : '<div class="muted s-none">لا نتائج</div>';
  }
  async function loadRows() {
    try { rows = await eng.products.search(query, window.matchMedia('(min-width: 900px)').matches ? 100 : 60); } catch { rows = []; }
    renderList();
  }
  // touching the yellow area = no quick sale any more; touching a product adds it to the cart at once
  list.addEventListener('pointerdown', (e) => { if (e.target.closest('.res') && document.activeElement === qIn) e.preventDefault(); });   // keep the keyboard open between two products
  list.addEventListener('click', (e) => {
    const b = e.target.closest('.res');
    if (b) return addProduct(rows.find((r) => r.id === b.dataset.id));
    if (!isNormal()) { normal = true; draw(); }
  });

  function addProduct(p) {
    if (!p) return;
    const ex = cart.find((l) => l.kind === 'product' && l.productId === p.id);
    if (ex) ex.qty = String(safe(() => M.parseQty(ex.qty || 0) / 1000, 0) + 1);
    else cart.push({ kind: 'product', productId: p.id, sku: p.sku, name: p.name, qty: '1', price: price4(p.sale_price) });
    normal = true; draw();
    cartEl.scrollTop = cartEl.scrollHeight;                           // the newest line is always visible
    if (document.activeElement === qIn) qIn.select();                 // search stays open: type the next product (typing replaces the text)
    else if (query) { query = ''; qIn.value = ''; loadRows(); }
  }

  // ---- search
  let t;
  qIn.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { query = qIn.value.trim(); loadRows(); }, 120); });
  qIn.enterKeyHint = 'go';
  qIn.addEventListener('focus', () => { if (!isNormal()) { normal = true; draw(); } setTimeout(() => qIn.select(), 0); });
  qIn.addEventListener('keydown', async (e) => {                      // Enter: add the exact match (number or name), or the only result
    if (e.key !== 'Enter') return;
    e.preventDefault(); clearTimeout(t); query = qIn.value.trim();
    await loadRows();
    const q = query.toLowerCase();
    const hit = rows.find((p) => (/^\d+$/.test(q) ? p.sku === q : p.name.toLowerCase() === q)) || (rows.length === 1 ? rows[0] : null);
    if (hit) addProduct(hit); else if (!rows.length) toast('لا نتائج', true, 1200);
  });
  $('#toQuick').onclick = () => app.go('calc');                       // only offered while the cart is empty: the quick sale = the calculator
  $('#hdrBack').onclick = async () => { if (cart.length && !(await confirmBox('السلة غير فارغة', 'الخروج دون حفظ؟', 'خروج', 'بقاء'))) return; app.go('home'); };
  $('#ext').onclick = () => openExternal(app, (v) => { normal = true; cart.push({ kind: 'ext', name: v.name, qty: v.qty, price: v.price, cost: v.cost }); draw(); cartEl.scrollTop = cartEl.scrollHeight; loadRows(); });

  // ---- pay
  const onPay = async () => {
    if (busy || total() <= 0) return;
    if (!cart.length) return payQuick();
    payCart();
  };
  $('#pay').onclick = onPay;
  async function payQuick() {
    busy = true; refreshTotals();
    try {
      const r = await eng.quickSale(quick, custOrNull());
      showStrip({ ms: 3500, html: `✔ ${esc(r.invoice.invoice_no)} · <b>${money(r.invoice.total)}</b>` }); quick = ''; clearCust();
    } catch (e) { toast(errText(e), true, 3500); }
    busy = false; draw();
  }
  function payCart() {
    const T = cartTotal();
    openModal({
      title: `الدفع · ${money(T)}`,
      html: `<div class="lbl">المبلغ المدفوع</div><input id="paid" class="inp" inputmode="decimal" value="${money(T)}">
        <div class="chips2" id="tender">${tenders(T).map((c) => `<button class="chip ${c.cls}" data-v="${c.v}">${c.label}</button>`).join('')}</div>
        <div id="info" class="chg"></div>
        <div id="cust2" style="display:none;gap:8px;flex-direction:column"><input id="mcn" class="inp" placeholder="اسم الزبون" value="${esc(cn.value)}"><input id="mcp" class="inp" inputmode="tel" placeholder="رقم الهاتف" value="${esc(cp.value)}"><div id="msg"></div></div>
        <div class="err" id="perr"></div>`,
      buttons: [{ label: 'إلغاء' }, { label: 'تأكيد', cls: 'gold', onClick: (close, m) => confirmSale(m) }],
      onOpen: (m) => {
        m.querySelector('.mbtns .gold').dataset.dbl = '1';                                  // confirming the payment = double bip too
        const paid = m.querySelector('#paid'), info = m.querySelector('#info'), cust2 = m.querySelector('#cust2');
        const upd = () => {
          const p = safe(() => M.parseMoney(paid.value || 0), 0);
          if (p >= T) { info.textContent = p > T ? `الباقي للزبون: ${money(p - T)}` : ''; info.className = 'chg'; cust2.style.display = 'none'; }
          else { info.textContent = `دين على الزبون: ${money(T - p)}`; info.className = 'chg debt'; cust2.style.display = 'flex'; }
        };
        partySuggest(app, 'customer', m.querySelector('#mcn'), m.querySelector('#mcp'), m.querySelector('#msg'));
        paid.addEventListener('input', upd);
        m.querySelectorAll('#tender .chip').forEach((c) => c.addEventListener('click', () => { paid.value = c.dataset.v; upd(); }));
        upd(); paid.focus(); paid.select();
      },
    });
  }
  // one-tap amounts: exact, the next round notes above the total, or "all on credit"
  function tenders(T) {
    const out = [{ label: 'المبلغ كاملاً', v: money(T), cls: 'full' }], seen = new Set([T]);
    for (const d of [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000]) {
      const v = Math.ceil(T / (d * 100)) * d * 100;
      if (!seen.has(v) && seen.size < 4) { seen.add(v); out.push({ label: money(v), v: money(v), cls: '' }); }
    }
    out.push({ label: 'دين', v: '0', cls: 'debt' });
    return out;
  }
  async function confirmSale(m, allowBelowCost = false) {
    const err = m.querySelector('#perr');
    const paid = m.querySelector('#paid').value;
    const input = { paid, allowBelowCost,
      lines: cart.map((l) => (l.kind === 'product' ? { productId: l.productId, qty: l.qty, price: l.price }
        : { external: { name: l.name, cost: l.cost, price: l.price, qty: l.qty } })) };
    const credit = m.querySelector('#cust2').style.display !== 'none';                  // credit sale: the window asks for name + phone
    const c = credit ? { name: m.querySelector('#mcn').value.trim(), phone: m.querySelector('#mcp').value.trim() } : custOrNull();
    if (c && (c.name || c.phone)) input.customer = c;
    try {
      const r = await eng.sale(input);
      const msg = await eng.share.invoiceMessage(r.invoice.invoice_no).catch(() => null);
      cart = []; quick = ''; query = ''; qIn.value = ''; normal = true; clearCust(); loadRows(); draw();
      m.remove();
      done(r, msg);
      return false;
    } catch (e) {
      if (e.code === 'BELOW_COST') {
        const names = e.details.items.map((i) => i.name).join('، ');
        if (await confirmBox('بيع بأقل من التكلفة', `${names} — هل تريد المتابعة؟`)) return confirmSale(m, true);
        return false;
      }
      err.textContent = errText(e); return false;
    }
  }
  function done(r, msg) {
    const notes = r.warnings.filter((w) => w.type === 'NEGATIVE_STOCK').map((w) => `⚠ مخزون سالب: ${esc(w.name)}`).join(' · ');
    const first = r.change ? `الباقي للزبون <b>${money(r.change)}</b>` : r.invoice.credit_amount ? `دين <b>${money(r.invoice.credit_amount)}</b>` : `✔ <b>${money(r.invoice.total)}</b>`;
    showStrip({ warn: !!notes, ms: 20000, html: `${esc(r.invoice.invoice_no)} · ${first}${notes ? `<br>${notes}` : ''}`,
      actions: msg ? [{ label: 'واتساب', cls: 'gold', onClick: () => {
        window.open(msg.link || `https://wa.me/?text=${encodeURIComponent(msg.text)}`, '_blank');
        eng.share.markSent(msg.invoice_id).catch(() => {});
      } }] : [] });
  }

  draw();
  loadRows();
}

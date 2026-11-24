// Quick sale as a CALCULATOR (v1.5).   Type  14+3×5+5×2+18  then "=":  every term becomes an invoice line.
//   [customer name | phone]  /  expression  /  keypad  1 2 3 × · 4 5 6 − · 7 8 9 + · . 0 ÷ ⌫  /  [pay | = | total]  /  lines
//   line (left to right): [n- produit n] [price] [qty] [total]   -- newest on top. Tap a line to edit it.
// A product × product term asks which number is the QUANTITY (it is the quantity taken out of the stock when the
// invoice details are completed). The invoice prices are kept when they differ from the catalogue prices.
import { mount, $, esc, header, toast, errText, openModal, confirmBox, showStrip, money, partySuggest } from './ui-core.js';
import { money as M } from './index.js';
import { validPhone } from './phone.js';
import { beep } from './beep.js';
import { parseExpr, termsToLines } from './calc.js';

const KEYS = ['1', '2', '3', '×', '4', '5', '6', '-', '7', '8', '9', '+', '.', '0', '÷', '⌫'];
const OPS = new Set(['×', '-', '+', '÷']);
const ERR = { BAD: 'العملية غير صحيحة', NEGATIVE: 'النتيجة سالبة أو صفر', DIV0: 'القسمة على صفر', EMPTY: '' };

export async function renderCalc(app) {
  const eng = app.engine;
  let expr = '', lines = [], last = '', busy = false;       // lines: {name, price, qty}  (oldest first, shown newest first)

  mount(`<div class="screen">${header('بيع سريع')}
    <div class="body calc" id="calc">
      <div class="s-cust c-cust" id="cust">
        <input id="cn" class="s-in" placeholder="اسم الزبون (اختياري)" autocomplete="off">
        <input id="cp" class="s-in" inputmode="tel" placeholder="هاتف الزبون (اختياري)" autocomplete="off">
        <div id="sg" class="s-sg"></div>
      </div>
      <div class="c-disp"><div class="c-prev" id="prev"></div><div class="c-expr" id="expr" dir="ltr">0</div></div>
      <div class="c-kpad" id="kpad">${KEYS.map((k) => `<button class="ck ${OPS.has(k) ? 'op' : k === '⌫' ? 'bk' : k === '.' ? 'dot' : k === '0' ? 'zero' : 'dg'} ${k === '÷' ? 'div' : ''}" data-k="${k}">${k === '-' ? '−' : k}</button>`).join('')}</div>
      <div class="c-pay" id="paybar" data-dbl="1">
        <button class="c-paybtn" id="pay">دفع</button>
        <button class="c-eq" id="eq" data-nodbl="1">=</button>
        <div class="c-tot"><span class="l">الإجمالي :</span><b id="tot" dir="ltr">0</b></div>
      </div>
      <div class="c-lines" id="lines"></div>
    </div></div>`);

  const cn = $('#cn'), cp = $('#cp');
  const safe = (fn, d = 0) => { try { return fn(); } catch { return d; } };
  const lineTotal = (l) => safe(() => M.lineCents(M.parseQty(l.qty || 0), M.parsePrice(l.price || 0)));
  const total = () => lines.reduce((a, l) => a + lineTotal(l), 0);
  const custOrNull = () => { const n = cn.value.trim(), p = cp.value.trim(); return n && validPhone(p, app.cfg?.wa_country_code || '212') ? { name: n, phone: p } : null; };
  partySuggest(app, 'customer', cn, cp, $('#sg'));
  cn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); cp.focus(); } });
  cp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); cp.blur(); } });

  // ---------------------------------------------------------------- display
  function paint() {
    const shown = expr.replace(/-/g, '−');
    $('#expr').textContent = shown || '0';
    $('#expr').classList.toggle('empty', !expr);
    $('#tot').textContent = money(total());
    $('#pay').disabled = busy || !lines.length || total() <= 0;
    $('#pay').classList.toggle('wait', !!expr);                     // the expression is not committed yet: "=" first
    $('#eq').classList.toggle('hot', !!expr);
    // live result of what is typed (quantity = second number), so the employee sees the sum before pressing "="
    const r = parseExpr(expr);
    const live = !r.error ? r.terms.reduce((a, t) => a + safe(() => (t.kind === 'single' ? Number(t.amount) : Number(t.a) * Number(t.b)), 0), 0) : null;
    $('#prev').textContent = expr ? (live ? `≈ ${Math.round(live * 100) / 100}` : '') : (last ? `${last.replace(/-/g, '−')} =` : '');
    $('#lines').innerHTML = lines.length ? lines.map((l, i) => ({ l, i })).reverse().map(({ l, i }) => `
      <button class="cl ${/^produit \d+$/.test(l.name) ? 'dflt' : ''}" data-i="${i}">
        <span class="t">${M.fmtMoney(lineTotal(l))}</span><span class="q ${l.qty !== '1' ? 'hot' : ''}">${esc(l.qty)}</span><span class="p">${esc(l.price)}</span>
        <span class="n">${i + 1}- ${esc(l.name)}</span></button>`).join('')
      : '<div class="muted c-none">اكتب العملية مثل <bdi dir="ltr">14+3×5+5×2+18</bdi> ثم اضغط <bdi>=</bdi></div>';
  }

  // ---------------------------------------------------------------- keypad
  function press(k) {
    if (k === '⌫') { expr = expr.slice(0, -1); return paint(); }
    if (k === 'C') { expr = ''; return paint(); }
    if (k === '=') return commit();
    const lastCh = expr.slice(-1), cur = (expr.match(/[\d.]*$/) || [''])[0];
    if (OPS.has(k)) {
      if (!expr) return;                                              // an operation needs a number before it
      expr = OPS.has(lastCh) ? expr.slice(0, -1) + k : expr + k;
    } else if (k === '.') {
      if (cur.includes('.')) return;
      expr += cur === '' ? '0.' : '.';
    } else {
      if (cur.includes('.') ? cur.split('.')[1].length >= 4 : cur.length >= 9) return;
      expr = cur === '0' ? expr.slice(0, -1) + k : expr + k;          // 0 then 5 -> 5
    }
    paint();
  }
  document.querySelectorAll('#kpad .ck, #eq').forEach((b) => {
    let t = null, longed = false;
    const k = () => b.dataset.k || '=';
    b.addEventListener('pointerdown', () => { longed = false; if (k() === '⌫') t = setTimeout(() => { longed = true; clearAll(); }, 600); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, () => clearTimeout(t)));
    b.addEventListener('click', () => { if (longed) { longed = false; return; } press(k()); });
  });
  async function clearAll() {                                         // long press on ⌫: the expression, then (second time) all the lines
    if (expr) { expr = ''; return paint(); }
    if (lines.length && await confirmBox('مسح الفاتورة', 'حذف كل الأسطر؟', 'حذف', 'بقاء')) { lines = []; last = ''; paint(); }
  }
  const onKey = (e) => {
    if (!document.contains($('#calc'))) { document.removeEventListener('keydown', onKey); return; }
    if (document.querySelector('.modal') || /INPUT|TEXTAREA/.test(document.activeElement?.tagName || '')) return;
    let k = null;
    if (/^[0-9]$/.test(e.key)) k = e.key; else if (e.key === '.' || e.key === ',') k = '.';
    else if (e.key === '*' || e.key === 'x' || e.key === 'X') k = '×'; else if (e.key === '/') k = '÷';
    else if (e.key === '+' || e.key === '-') k = e.key; else if (e.key === 'Backspace') k = '⌫';
    else if (e.key === 'Delete' || e.key === 'Escape') k = 'C'; else if (e.key === '=' || (e.key === 'Enter' && expr)) k = '=';
    else if (e.key === 'Enter') { onPay(); e.preventDefault(); return; } else return;
    press(k); if (app.cfg?.sale_beep !== false) beep(false); e.preventDefault();
  };
  document.addEventListener('keydown', onKey);
  const onBeep = (e) => {
    if (!document.contains($('#calc'))) { document.removeEventListener('pointerdown', onBeep, true); return; }
    if (app.cfg?.sale_beep === false) return;
    const b = e.target.closest('button, .ck'); if (!b || b.disabled) return;
    beep(!!b.closest('[data-dbl]') && b.id === 'pay');
  };
  document.addEventListener('pointerdown', onBeep, true);

  // ---------------------------------------------------------------- "=": terms -> lines (asks the quantity of every a×b)
  function askQuantities(muls) {
    return new Promise((resolve) => {
      let pick = muls.map(() => 'b');
      openModal({
        title: 'أي الرقمين هو الكمية؟',
        html: `<div class="qa-note">الكمية هي التي تخرج من المخزون، والآخر هو الثمن</div>` + muls.map((t, i) => `
          <div class="qa" data-i="${i}"><button class="qb" data-s="a">${esc(t.a)}</button><span class="qx">×</span><button class="qb on" data-s="b">${esc(t.b)}</button></div>`).join(''),
        buttons: [{ label: 'إلغاء', onClick: () => resolve(null) }, { label: 'تأكيد', cls: 'gold', onClick: () => resolve(pick) }],
        onOpen: (m) => m.querySelectorAll('.qa').forEach((row) => row.querySelectorAll('.qb').forEach((b) => b.addEventListener('click', () => {
          pick[Number(row.dataset.i)] = b.dataset.s; row.querySelectorAll('.qb').forEach((x) => x.classList.toggle('on', x === b));
        }))),
      });
    });
  }
  async function commit() {
    if (!expr) return;
    const r = parseExpr(expr);
    if (r.error) return toast(ERR[r.error] || 'العملية غير صحيحة', true, 1800);
    const muls = r.terms.filter((t) => t.kind === 'mul');
    let choices = [];
    if (muls.length) { choices = await askQuantities(muls); if (!choices) return; }
    const fresh = termsToLines(r.terms, choices, lines.length + 1);
    try { fresh.forEach((l) => { M.parsePrice(l.price); if (M.parseQty(l.qty) <= 0 || M.parsePrice(l.price) <= 0) throw new Error('x'); }); }
    catch { return toast('الكمية حتى 3 أرقام عشرية والثمن حتى 4، وبدون صفر', true, 2600); }
    lines.push(...fresh); last = expr; expr = ''; paint();
  }

  // ---------------------------------------------------------------- tap a line: edit name / price / quantity, or delete
  $('#lines').addEventListener('click', (e) => {
    const b = e.target.closest('.cl'); if (!b) return;
    const i = Number(b.dataset.i), l = lines[i];
    openModal({
      title: `تعديل السطر ${i + 1}`,
      html: `<div class="lbl">اسم المنتج</div><input id="en" class="inp" value="${esc(l.name)}" autocomplete="off">
        <div class="row"><div style="flex:1"><div class="lbl">الثمن</div><input id="ep" class="inp" inputmode="decimal" value="${esc(l.price)}"></div>
        <div style="flex:1"><div class="lbl">الكمية</div><input id="eq" class="inp" inputmode="decimal" value="${esc(l.qty)}"></div></div><div class="err" id="eerr"></div>`,
      buttons: [{ label: 'إلغاء' }, { label: 'حذف', cls: 'danger', onClick: () => { lines.splice(i, 1); lines.forEach((x, k) => { if (/^produit \d+$/.test(x.name)) x.name = `produit ${k + 1}`; }); paint(); } },
        { label: 'حفظ', cls: 'gold', onClick: (close, m) => {
          const name = m.querySelector('#en').value.trim() || l.name, price = m.querySelector('#ep').value.trim().replace(',', '.'), qty = m.querySelector('#eq').value.trim().replace(',', '.');
          try { if (M.parsePrice(price) <= 0 || M.parseQty(qty) <= 0) throw new Error('x'); } catch { m.querySelector('#eerr').textContent = 'ثمن وكمية صحيحان (أكبر من صفر)'; return false; }
          Object.assign(l, { name, price, qty }); paint();
        } }],
      onOpen: (m) => { const f = m.querySelector('#en'); f.focus(); f.select(); },
    });
  });

  // ---------------------------------------------------------------- pay: one invoice, one line per term
  async function onPay() {
    if (busy) return;
    if (expr) return commit();                                       // something typed but not committed: act like "="
    if (!lines.length || total() <= 0) return;
    busy = true; paint();
    try {
      const r = await eng.calcSale({ lines, customer: custOrNull() });
      showStrip({ ms: 6000, html: `✔ ${esc(r.invoice.invoice_no)} · <b>${money(r.invoice.total)}</b> · ${r.lines.length} أسطر`,
        actions: [{ label: 'التفاصيل', cls: 'gold', onClick: () => app.go('invoices', { open: r.invoice.id }) }] });
      lines = []; last = ''; expr = ''; cn.value = ''; cp.value = ''; $('#sg').innerHTML = '';
    } catch (e) { toast(errText(e), true, 3500); }
    busy = false; paint();
  }
  $('#pay').onclick = onPay;
  $('#hdrBack').onclick = async () => { if ((lines.length || expr) && !(await confirmBox('الفاتورة غير مدفوعة', 'الخروج دون حفظ؟', 'خروج', 'بقاء'))) return; app.go('home'); };
  paint();
}

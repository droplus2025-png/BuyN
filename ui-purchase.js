// Purchase screen: supplier, product lines (existing or new), partial payment -> supplier debt.
import { mount, $, esc, header, toast, errText, openModal, confirmBox, showStrip, money, price4, partySuggest } from './ui-core.js';
import { money as M } from './index.js';
import { codeBoxHtml, codePicker, lastCat, rememberCat, suggestSale, rememberMargin, CODE_OK } from './ui-productform.js';

export async function renderPurchase(app) {
  const eng = app.engine, can = app.session.permissions;
  const pc = document.body.classList.contains('pcmode');
  let lines = [];          // {sel, name, sku, code (new products), qty, cost, sale}
  let pvTouched = false;
  let sel = null;          // selected product, or {isNew:true, name}
  const createdNew = new Map();   // new products already created by a previous (failed) attempt: reuse them, never create twice

  mount(`<div class="screen">${header('شراء')}<div class="body"><div class="twocol"><div class="c1">
    <div class="row"><input id="sn" class="inp" placeholder="اسم المورد" style="flex:1.2" autocomplete="off">
      <input id="sp" class="inp" inputmode="tel" placeholder="هاتف المورد" style="flex:1"></div><div id="ssg"></div>
    <div class="card" style="display:flex;flex-direction:column;gap:8px">
      <input id="pk" class="inp" placeholder="🔍 رقم المنتج أو اسمه" autocomplete="off">
      <div id="sug"></div><div id="picked" class="muted"></div>
      <div id="newbox" style="display:none">${codeBoxHtml()}</div>
      <div class="row"><input id="qt" class="inp" inputmode="decimal" placeholder="الكمية"><input id="pa" class="inp" inputmode="decimal" placeholder="سعر الشراء"><input id="pv" class="inp" inputmode="decimal" placeholder="سعر البيع"></div>
      <button class="btn gold" id="addl">إضافة</button></div></div><div class="c2">
    <div id="list" style="flex:1;overflow:auto;min-height:0"></div>
    <div class="payrow"><button class="btn teal" id="pay" disabled>تأكيد</button><div class="totalbox"><div class="l">الإجمالي</div><div class="v" id="tot">0</div></div></div>
  </div></div></div></div>`);
  $('#hdrBack').onclick = async () => { if (lines.length && !(await confirmBox('قائمة الشراء غير فارغة', 'الخروج دون حفظ؟', 'خروج', 'بقاء'))) return; app.go('home'); };

  const safe = (fn, d = 0) => { try { return fn(); } catch { return d; } };
  const lineTotal = (l) => safe(() => M.lineCents(M.parseQty(l.qty), M.parsePrice(l.cost)));
  const total = () => lines.reduce((a, l) => a + lineTotal(l), 0);
  function drawList() {
    $('#tot').textContent = money(total()); $('#pay').disabled = !lines.length;
    $('#list').innerHTML = lines.map((l, i) => `<div class="line" style="grid-template-columns:1fr 54px 64px 64px 30px" data-i="${i}">
      <div class="nm">${l.sel.isNew ? `<span style="color:var(--lime)">جديد ${esc(l.code || '')} · </span>` : `<span class="muted">${l.sku} · </span>`}${esc(l.name)}</div>
      <div>${esc(l.qty)}</div><div>${esc(l.cost)}</div><div class="muted">${esc(l.sale || '—')}</div><button class="x">✖</button></div>`).join('');
    nextStep();
    document.querySelectorAll('#list .x').forEach((b) => b.addEventListener('click', () => { lines.splice(Number(b.closest('.line').dataset.i), 1); drawList(); }));
  }

  // computer: the program points to the next step (notice in the top bar + pulsing target)
  function nextStep() {
    if (!pc) return;
    document.querySelectorAll('.next').forEach((x) => x.classList.remove('next'));
    let text, target;
    if (!sel) [text, target] = lines.length ? (!$('#sn').value.trim() ? ['اكتب اسم المورد، ثم اضغط تأكيد', '#sn'] : ['أضف منتجاً آخر، أو اضغط تأكيد للدفع', '#pay']) : ['ابحث عن المنتج برقمه أو باسمه', '#pk'];
    else if (!$('#qt').value) [text, target] = ['اكتب الكمية المشتراة', '#qt'];
    else if (!$('#pa').value && !$('#pa').disabled) [text, target] = ['اكتب سعر الشراء', '#pa'];
    else [text, target] = ['اضغط إضافة', '#addl'];
    const note = $('#note'); if (note) note.textContent = text;
    $(target)?.classList.add('next');
  }
  // known suppliers are suggested while typing a name or a phone
  partySuggest(app, 'supplier', $('#sn'), $('#sp'), $('#ssg'));

  // product search / selection
  function lockFields() {
    $('#pa').disabled = !!(sel && !sel.isNew && !can.edit_purchase_price);
    $('#pv').disabled = !!(sel && !sel.isNew && !can.edit_sale_price);
  }
  function pick(p) {
    sel = p; $('#sug').innerHTML = ''; $('#pk').value = '';
    $('#picked').innerHTML = p.isNew ? `✔ <b style="color:var(--lime)">منتج جديد:</b> ${esc(p.name)}` : `✔ <b style="color:var(--gold)">${p.sku}</b> · ${esc(p.name)} <span class="muted">(المخزون ${M.fmtQty(p.qty)})</span>`;
    $('#pa').value = p.isNew ? '' : price4(p.purchase_price); $('#pv').value = p.isNew ? '' : price4(p.sale_price); $('#qt').value = '1';
    $('#newbox').style.display = p.isNew ? '' : 'none'; pvTouched = false;
    if (p.isNew) cp.setCat(lastCat());
    lockFields(); $('#qt').focus(); nextStep();
  }
  let results = [];
  async function suggest() {
    const q = $('#pk').value.trim();
    if (!q) { $('#sug').innerHTML = ''; results = []; return; }
    results = await eng.products.search(q, 6);
    const exact = results.some((p) => p.name.toLowerCase() === q.toLowerCase());
    $('#sug').innerHTML = `<div class="results">${results.map((p) => `<button class="res" data-id="${p.id}"><span class="sku">${p.sku}</span><span>${esc(p.name)}</span><span class="muted">${price4(p.purchase_price)}</span><span class="p">${price4(p.sale_price)}</span></button>`).join('')}
      ${!/^\d+$/.test(q) && can.add_product && !exact ? `<button class="res" data-new="1" style="grid-template-columns:1fr;color:var(--lime)">＋ منتج جديد: ${esc(q)}</button>` : ''}</div>`;
    document.querySelectorAll('#sug .res').forEach((b) => b.addEventListener('click', () => pick(b.dataset.new ? { isNew: true, name: q } : results.find((p) => p.id === b.dataset.id))));
  }
  let t; $('#pk').addEventListener('input', () => { sel = null; $('#picked').textContent = ''; clearTimeout(t); t = setTimeout(suggest, 120); });
  $('#pk').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    await suggest();
    const q = $('#pk').value.trim();
    const sameName = results.find((p) => p.name.toLowerCase() === q.toLowerCase());
    const exact = /^\d+$/.test(q) ? results.find((p) => p.sku === q) : sameName || (results.length === 1 ? results[0] : null);
    if (sameName) toast('هذا المنتج موجود — ستُضاف الكمية إلى مخزونه');
    if (exact) pick(exact);
  });
  [['qt', 'pa'], ['pa', 'pv']].forEach(([a, b]) => $(`#${a}`).addEventListener('keydown', (e) => { if (e.key === 'Enter') { const n = $(`#${b}`); (n.disabled ? $('#addl') : n).focus(); if (n.disabled) $('#addl').click(); } }));
  $('#pv').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#addl').click(); });
  [$('#qt'), $('#pa'), $('#pv')].forEach((i) => i.addEventListener('focus', () => i.select()));

  $('#addl').onclick = () => {
    if (!sel) { toast('اختر منتجاً أو أنشئ منتجاً جديداً', true); return; }
    try {
      if (M.parseQty($('#qt').value || '0') <= 0) throw Object.assign(new Error(), { code: 'BAD_NUMBER' });
      M.parsePrice($('#pa').value || '0'); if ($('#pv').value) M.parseScaled($('#pv').value, 2);
    } catch (e) { toast(errText(e), true); return; }
    const code = sel.isNew ? cp.code : sel.sku;
    if (sel.isNew && !CODE_OK.test(code)) { toast('الرقم: خانة الصنف ثم رقم المنتج (مثل 823)', true); return; }
    if (sel.isNew && lines.some((l) => l.sel.isNew && l.code === code)) { toast('هذا الرقم مستعمل في القائمة', true); return; }
    const twin = lines.find((l) => (sel.isNew ? l.sel.isNew && l.name.toLowerCase() === sel.name.toLowerCase() : !l.sel.isNew && l.sel.id === sel.id));
    if (twin) { twin.qty = String(Number(String(twin.qty).replace(',', '.')) + Number(String($('#qt').value).replace(',', '.'))); toast('هذا المنتج موجود في القائمة — أُضيفت الكمية'); }   // never twice: add the quantity
    else {
      lines.push({ sel, name: sel.name, sku: sel.sku, code, qty: $('#qt').value, cost: $('#pa').value || '0', sale: $('#pv').value });
      if (sel.isNew) { rememberCat(code[0]); rememberMargin(code[0], $('#pa').value, $('#pv').value); }
    }
    sel = null; $('#picked').textContent = ''; ['qt', 'pa', 'pv'].forEach((id) => { $(`#${id}`).value = ''; $(`#${id}`).disabled = false; });
    $('#newbox').style.display = 'none';
    drawList(); $('#pk').focus();
  };

  // ---- confirm & pay
  $('#pay').onclick = () => {
    const T = total();
    openModal({
      title: `الدفع للمورد · ${money(T)}`,
      html: `<div class="lbl">المبلغ المدفوع الآن</div><input id="paid" class="inp" inputmode="decimal" value="${money(T)}"><div id="info" class="muted"></div><div class="err" id="perr"></div>`,
      buttons: [{ label: 'إلغاء' }, { label: 'تأكيد', cls: 'gold', onClick: (close, m) => confirmPurchase(m) }],
      onOpen: (m) => {
        const paid = m.querySelector('#paid'), info = m.querySelector('#info');
        const upd = () => { const p = safe(() => M.parseMoney(paid.value || 0), 0); info.textContent = p > T ? '⚠ المبلغ أكبر من الفاتورة' : p < T ? `دين للمورد: ${money(T - p)}` : ''; };
        paid.addEventListener('input', upd); paid.addEventListener('focus', () => paid.select());
        upd(); paid.focus(); paid.select();
      },
    });
  };
  async function confirmPurchase(m) {
    const err = m.querySelector('#perr');
    try {
      if (!$('#sn').value.trim()) { $('#sn').focus(); throw Object.assign(new Error(), { code: 'SUPPLIER_REQUIRED' }); }   // checked BEFORE any new product is created
      // new products are created first (smallest free SKU); then ONE atomic purchase
      if (safe(() => M.parseMoney(m.querySelector('#paid').value || 0), 0) > total()) throw Object.assign(new Error(), { code: 'OVERPAYMENT' });
      const created = createdNew;
      for (const l of lines) if (l.sel.isNew && !created.has(l.name.toLowerCase())) {
        created.set(l.name.toLowerCase(), (await eng.products.create({ name: l.name, purchasePrice: l.cost, salePrice: l.sale || '0', sku: l.code })).id);
      }
      const input = { supplier: { name: $('#sn').value, phone: $('#sp').value }, paid: m.querySelector('#paid').value,
        lines: lines.map((l) => {
          const o = { productId: l.sel.isNew ? created.get(l.name.toLowerCase()) : l.sel.id, qty: l.qty, price: l.cost };
          if (!l.sel.isNew && l.sale && safe(() => M.parseScaled(l.sale, 2) * 100) !== l.sel.sale_price) o.salePrice = l.sale;   // only a real change
          return o;
        }) };
      const r = await eng.purchase(input);
      const msg = await eng.share.invoiceMessage(r.invoice.invoice_no).catch(() => null);
      lines = []; createdNew.clear(); $('#sn').value = ''; $('#sp').value = ''; drawList(); m.remove(); done(r, msg);
      return false;
    } catch (e) { err.textContent = e.code === 'SUPPLIER_REQUIRED' ? 'اكتب اسم المورد' : errText(e); return false; }
  }
  function done(r, msg) {
    const neg = r.warnings.some((w) => w.type === 'CASH_NEGATIVE');
    showStrip({ warn: neg, ms: 15000,
      html: `✔ ${esc(r.invoice.invoice_no)} · <b>${money(r.invoice.total)}</b>${r.invoice.credit_amount ? ` · دين للمورد ${money(r.invoice.credit_amount)}` : ''}${neg ? '<br>⚠ رصيد الصندوق سالب' : ''}`,
      actions: msg?.link ? [{ label: 'واتساب', cls: 'gold', onClick: () => { window.open(msg.link, '_blank'); eng.share.markSent(msg.invoice_id).catch(() => {}); } }] : [] });
  }
  const cp = codePicker(app, $('#newbox'), { taken: () => lines.filter((l) => l.sel.isNew).map((l) => l.code) });
  $('#pa').addEventListener('input', () => { if (sel?.isNew && !pvTouched) $('#pv').value = suggestSale(cp.cat, $('#pa').value); });
  $('#pv').addEventListener('input', () => { pvTouched = !!$('#pv').value; });
  $('#sn').addEventListener('input', nextStep);
  ['pk', 'qt', 'pa'].forEach((id) => $(`#${id}`).addEventListener('input', nextStep));
  drawList();
}

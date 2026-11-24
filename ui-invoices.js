// Invoices archive: search, filters, detail, WhatsApp, and product details for quick sales.
import { mount, $, esc, header, toast, errText, openModal, confirmBox, money, price4, qtyStr, TYPE_AR, fmtWhen, fmtTime, priceShort, partySuggest } from './ui-core.js';
import { money as M } from './index.js';
import { openExternal } from './ui-external.js';

// modal showing the formatted text invoice with a WhatsApp button (used by other screens too)
export async function showInvoice(app, idOrNo) {
  const eng = app.engine;
  let msg;
  try { msg = await eng.share.invoiceMessage(idOrNo); } catch (e) { return toast(errText(e), true); }
  openModal({
    title: 'الفاتورة', tall: true,
    html: `<pre dir="auto" style="white-space:pre-wrap;margin:0;font:inherit;line-height:1.6;user-select:text">${esc(msg.text)}</pre>`,
    buttons: [{ label: 'إغلاق' }, { label: 'واتساب', cls: 'gold', onClick: () => {
      window.open(msg.link || `https://wa.me/?text=${encodeURIComponent(msg.text)}`, '_blank'); eng.share.markSent(msg.invoice_id).catch(() => {}); } }],
  });
}

const FILTERS = [
  ['all', 'الكل', null], ['sale', 'بيع', ['sale']], ['quick', 'سريع', ['quick_sale']], ['pending', '⏳ بدون تفاصيل', ['quick_sale']],
  ['purchase', 'شراء', ['purchase']], ['ret', 'إرجاع', ['return_customer', 'return_supplier']],
  ['pay', 'قبض/دفع', ['collect', 'pay_supplier']], ['other', 'أخرى', ['expense', 'deposit', 'withdrawal', 'cash_adjustment', 'opening_debt_customer', 'opening_debt_supplier']],
];

export async function renderInvoices(app, params = {}) {
  const eng = app.engine, can = app.session.permissions;
  const pc = document.body.classList.contains('pcmode');            // computer: list and invoice side by side
  let filter = params.filter || 'all', back = () => app.go('home'), shown = null;
  const out = () => (pc ? $('#pane') : $('#main'));
  const controls = `<input id="q" class="inp" placeholder="🔍 رقم الفاتورة أو اسم / هاتف" autocomplete="off">
    <div class="chips" id="chips">${FILTERS.map(([k, l]) => `<button class="chip ${k === filter ? 'on' : ''}" data-k="${k}">${l}</button>`).join('')}</div>
    <div id="main" style="flex:1;overflow:auto;min-height:0;display:flex;flex-direction:column;gap:8px"></div>`;
  mount(`<div class="screen">${header('الفواتير')}${pc ? `<div class="body inv-split"><div class="inv-listcol">${controls}</div><div id="pane" class="inv-pane"><div class="muted" style="padding:14px">اختر فاتورة من القائمة</div></div></div>` : `<div class="body col">${controls}</div>`}</div>`);
  $('#hdrBack').onclick = () => back();

  async function list() {
    back = () => app.go('home'); $('#q').style.display = ''; $('#chips').style.display = '';
    const f = FILTERS.find((x) => x[0] === filter);
    let rows = await eng.reports.searchInvoices({ text: $('#q').value, types: f[2], limit: 150 });
    if (filter === 'pending') rows = rows.filter((i) => !i.has_detail);
    if (pc) nextStep(rows);
    $('#main').innerHTML = rows.length ? `<div class="results" style="max-height:none">${rows.map((i) => `
      <button class="res inv-row ${i.id === shown ? 'sel' : ''}" data-id="${i.id}">
        <span class="sku">${i.invoice_no}</span>
        <span class="inv-t"><b class="inv-op">${TYPE_AR[i.type] || i.type}</b>${i.party_name ? `<span class="inv-dot">·</span><span class="inv-cu">${esc(i.party_name)}</span>` : ''}</span>
        ${i.type === 'quick_sale' && !i.has_detail ? '<span class="pill amber">بدون تفاصيل</span>' : ''}${i.is_modified ? '<span class="pill">معدلة</span>' : ''}
        <span class="inv-tm" dir="ltr">${fmtTime(i.created_at, app.cfg?.timezone)}</span>
        <span class="p">${money(i.total)}</span></button>`).join('')}</div>` : '<div class="muted" style="padding:14px">لا توجد فواتير</div>';
    document.querySelectorAll('#main .res').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.id, r = rows.find((x) => x.id === id);
      if (r && r.type === 'quick_sale' && !r.has_detail && can.quick_sale) {            // an invoice waiting for its details: straight to the details screen
        const d = await eng.reports.invoice(id);
        if (d?.quick_pending) { clearTimeout(t); return editDetails(d, true); }
      }
      detail(id);
    }));
  }
  // computer: the program points to the next step (notice in the top bar + pulsing target)
  async function nextStep(rows) {
    document.querySelectorAll('.next').forEach((x) => x.classList.remove('next'));
    const note = $('#note'); if (!note) return;
    const n = (await eng.reports.pendingQuickSales().catch(() => ({ count: 0 }))).count;
    if (n && filter !== 'pending') { note.textContent = `⏳ ${n} فواتير سريعة بانتظار التفاصيل — المس «بدون تفاصيل»`; document.querySelector('.chip[data-k="pending"]')?.classList.add('next'); }
    else if (n) { note.textContent = 'المس فاتورة لإضافة تفاصيل منتجاتها'; document.querySelector('#main .res')?.classList.add('next'); }
    else note.textContent = rows.length ? 'المس فاتورة لعرضها وإرسالها' : '';
  }
  let t; $('#q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(list, 150); });
  $('#chips').addEventListener('click', (e) => { const b = e.target.closest('.chip'); if (!b) return; filter = b.dataset.k;
    document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === b)); list(); });

  // ---------------------------------------------------------------- one invoice
  async function detail(id) {
    clearTimeout(t);
    const d = await eng.reports.invoice(id);
    if (!d) return toast('الفاتورة غير موجودة', true);
    shown = id; if (!pc) { back = list; $('#q').style.display = 'none'; $('#chips').style.display = 'none'; } else document.querySelectorAll('#main .res').forEach((r) => r.classList.toggle('sel', r.dataset.id === id));
    const i = d.invoice;
    let msg; try { msg = await eng.share.invoiceMessage(id); } catch (e) { return toast(errText(e), true); }
    // the invoice looks EXACTLY like the one sent to the customer (same text, same template); internal figures (profit, returns) stay below it
    const inner = (d.returns.length ? d.returns.map((r) => `<div class="kv"><span class="muted">إرجاع ${r.invoice_no}</span><b>${money(r.total)}</b></div>`).join('') : '')
      + (can.view_cost_profit && i.profit !== undefined && ['sale', 'quick_sale', 'return_customer'].includes(i.type)
        ? `<div class="kv"><span>${d.has_detail ? 'الربح الحقيقي' : i.type === 'quick_sale' ? 'الربح (نسبة جزافية)' : 'الربح'}</span><b>${money(d.real_profit ?? i.profit)}</b></div>` : '');
    out().innerHTML = `
      <div class="inv-paper">${msg.text.split('\n').map((ln) => `<div dir="auto">${esc(ln) || '&nbsp;'}</div>`).join('')}</div>
      ${inner ? `<div class="card">${inner}</div>` : ''}
      <div class="row"><button class="btn gold big" id="wa" style="flex:1">واتساب / نسخ</button>
        ${d.quick_pending && can.quick_sale ? '<button class="btn amber big" id="det" style="flex:1">إضافة التفاصيل</button>' : ''}</div>`;
    $('#wa').onclick = () => { window.open(msg.link || `https://wa.me/?text=${encodeURIComponent(msg.text)}`, '_blank'); eng.share.markSent(msg.invoice_id).catch(() => {}); };
    $('#det')?.addEventListener('click', () => editDetails(d));
  }

  // ---------------------------------------------------------------- product details of a quick sale
  // Same freedom as a normal sale (product, external product, price, quantity). The WHOLE total must be distributed.
  // Layout (sketch): [customer | phone | difference | total] / [external | search] / lines / [save | save and send] / stock list
  function editDetails(d, direct = false) {
    back = direct ? list : () => detail(d.invoice.id);
    if (!pc) { $('#q').style.display = 'none'; $('#chips').style.display = 'none'; }
    const total = d.invoice.total, inv = d.invoice;
    const canPrice = !!can.edit_sale_price;                  // prices are those really charged; without the right to edit them the product's own price is used
    const cur = String(app.cfg?.currency || '').toLowerCase();
    // {kind:'product', id, sku, name, qty, price} | {kind:'ext', name, qty, price, cost} | {kind:'ph', name, qty, price}
    // 'ph' = a line typed on the calculator (produit n): choose its product from the stock list (quantity and INVOICE price are kept) or make it an external item
    let lines = (d.lines || []).filter((l) => l.kind === 'quick' && l.name !== 'بيع سريع').map((l) => ({ kind: 'ph', name: l.name, qty: qtyStr(l.qty), price: price4(l.unit_price) }));
    let timer, last = null, query = '', rows = [];
    let sel = lines.findIndex((l) => l.kind === 'ph');                // the placeholder the next product replaces
    const nextPh = (from = 0) => { const k = lines.findIndex((l, i) => i >= from && l.kind === 'ph'); return k >= 0 ? k : lines.findIndex((l) => l.kind === 'ph'); };
    out().innerHTML = `
      <div class="det2">
        <div class="s-info" id="info">
          <div><span class="l">زبون</span>${d.party ? `<b>${esc(d.party.name)}</b>` : '<input id="dcn" class="s-mini" placeholder="اختياري" autocomplete="off">'}</div>
          <div><span class="l">هاتف</span>${d.party ? `<b dir="ltr">${esc(d.party.phone)}</b>` : '<input id="dcp" class="s-mini" inputmode="tel" placeholder="اختياري" autocomplete="off" dir="ltr">'}</div>
          <div><span class="l">الفرق</span><b id="diff" dir="ltr">${money(total)}</b></div>
          <div><span class="l">الإجمالي</span><b dir="ltr" style="color:var(--gold)">${money(total)}</b></div>
          <div id="dsg" class="s-sg"></div>
        </div>
        <div class="s-srow"><button class="s-ext" id="ext">🔦 منتج خارجي</button><input id="ps" class="s-srch" placeholder="🔍 بحث" autocomplete="off"></div>
        <div class="s-cart" id="dl"></div>
        <div class="err" id="derr"></div><div id="sum" class="s-note"></div>
        <div class="s-pay"><button class="s-paybtn" id="save" disabled>حفظ</button><button class="s-paybtn s-send" id="saveSend" disabled>حفظ وإرسال</button></div>
        <div class="s-list" id="dsl"></div>
      </div>`;
    const dl = $('#dl'), dsl = $('#dsl'), ps = $('#ps');
    const dcn = $('#dcn'), dcp = $('#dcp');                    // optional customer (only when the sale has none yet)
    if (dcn) {
      partySuggest(app, 'customer', dcn, dcp, $('#dsg'));
      dcn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); dcp.focus(); } });
      dcp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ps.focus(); } });
    }

    function renderStock() {
      const q = query.toLowerCase();
      const exact = (p) => !!q && (/^\d+$/.test(q) ? p.sku === q : p.name.toLowerCase() === q);
      dsl.innerHTML = rows.length ? rows.map((p) => `
        <button class="res rs ${exact(p) ? 'exact' : ''}" data-id="${p.id}"><span class="rn"><b class="sku">${p.sku}</b>- ${esc(p.name)}</span>
          <span class="rv">${priceShort(p.sale_price)}${esc(cur)}</span>
          <span class="rc"><span class="ra">A${priceShort(p.purchase_price)}</span><span class="rq ${p.qty <= 0 ? 'neg' : ''}">Q${qtyStr(p.qty) || 0}</span></span></button>`).join('')
        : '<div class="muted s-none">لا نتائج</div>';
    }
    async function loadStock() { try { rows = await eng.products.search(query, 60); } catch { rows = []; } renderStock(); }
    function addProduct(p) {
      if (!p) return;
      if (sel >= 0 && lines[sel]?.kind === 'ph') {                    // replaces the selected calculator line, keeps its quantity and its invoice price
        const ph = lines[sel];
        lines[sel] = { kind: 'product', id: p.id, name: p.name, sku: p.sku, qty: ph.qty, price: ph.price };
        sel = nextPh(sel + 1); draw();
        if (document.activeElement === ps) ps.select(); else if (query) { query = ''; ps.value = ''; loadStock(); }
        return;
      }
      const ex = lines.find((l) => l.kind === 'product' && l.id === p.id);
      if (ex) ex.qty = String((Number(ex.qty) || 0) + 1); else lines.push({ kind: 'product', id: p.id, name: p.name, sku: p.sku, qty: '1', price: price4(p.sale_price) });
      draw(); dl.scrollTop = dl.scrollHeight;
      if (document.activeElement === ps) ps.select(); else if (query) { query = ''; ps.value = ''; loadStock(); }
    }
    dsl.addEventListener('pointerdown', (e) => { if (e.target.closest('.res') && document.activeElement === ps) e.preventDefault(); });
    dsl.addEventListener('click', (e) => { const b = e.target.closest('.res'); if (b) addProduct(rows.find((r) => r.id === b.dataset.id)); });
    let ts; ps.addEventListener('input', () => { clearTimeout(ts); ts = setTimeout(() => { query = ps.value.trim(); loadStock(); }, 120); });
    ps.addEventListener('focus', () => setTimeout(() => ps.select(), 0));
    ps.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault(); clearTimeout(ts); query = ps.value.trim(); await loadStock();
      const q = query.toLowerCase();
      const hit = rows.find((p) => (/^\d+$/.test(q) ? p.sku === q : p.name.toLowerCase() === q)) || (rows.length === 1 ? rows[0] : null);
      if (hit) addProduct(hit);
    });
    $('#ext').onclick = () => openExternal(app, (v) => { if (sel >= 0 && lines[sel]?.kind === 'ph') { const ph = lines[sel]; lines[sel] = { kind: 'ext', name: v.name, qty: ph.qty, price: ph.price, cost: v.cost }; sel = nextPh(sel + 1); } else lines.push({ kind: 'ext', name: v.name, qty: v.qty, price: v.price, cost: v.cost }); draw(); dl.scrollTop = dl.scrollHeight; loadStock(); });

    const payload = (extra = {}) => ({ invoice: d.invoice.id, ...extra,
      lines: lines.filter((l) => l.kind !== 'ph').map((l) => (l.kind === 'product' ? { productId: l.id, qty: l.qty, price: l.price } : { external: { name: l.name, cost: l.cost, price: l.price, qty: l.qty } })) });

    // lines, left to right: [Sku- product] [p=price] [Q=quantity] [X]
    function draw() {
      dl.innerHTML = lines.length ? lines.map((l, k) => `<div class="sline ${l.kind === 'ext' ? 'ext' : ''} ${l.kind === 'ph' ? 'ph' : ''} ${k === sel ? 'sel' : ''}" data-k="${k}">
        <div class="nm">${l.kind === 'product' ? `<b class="sku">${l.sku}</b>- ` : l.kind === 'ph' ? '❓ ' : '＋ '}${esc(l.name)}<span class="lt">${l.kind === 'ph' ? ' ← اختر المنتج من القائمة' : ''}</span></div>
        <label class="pf"><b>p=</b><input class="p" inputmode="decimal" value="${esc(l.price)}" ${canPrice ? '' : 'disabled'}></label><label class="pf"><b>Q=</b><input class="n" inputmode="decimal" value="${esc(l.qty)}"></label>
        <button class="x">✖</button></div>`).join('') : '<div class="muted s-none" style="direction:rtl">أضف المنتجات المباعة فعلاً بأسعارها الحقيقية، ويجب أن يساوي مجموعها المبلغ المدفوع تماماً</div>';
      dl.querySelectorAll('.sline').forEach((row) => {
        const l = lines[Number(row.dataset.k)], pi = row.querySelector('.p'), ni = row.querySelector('.n');
        if (l.kind === 'ph') row.querySelector('.nm').addEventListener('click', () => { sel = Number(row.dataset.k); draw(); });   // tap a calculator line to choose which one the next product fills
        [pi, ni].forEach((i) => i.addEventListener('focus', () => i.select()));
        pi.addEventListener('input', () => { l.price = pi.value; schedule(); });
        ni.addEventListener('input', () => { l.qty = ni.value; schedule(); });
        pi.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ni.focus(); } });
        ni.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ps.focus(); } });
        row.querySelector('.x').addEventListener('click', () => { lines.splice(Number(row.dataset.k), 1); sel = nextPh(0); draw(); });
      });
      schedule();
    }
    function setSave(on) { $('#save').disabled = !on; $('#saveSend').disabled = !on; }
    function schedule() { clearTimeout(timer); timer = setTimeout(preview, 150); }
    async function preview() {
      $('#derr').textContent = ''; setSave(false); last = null;
      const left = lines.filter((l) => l.kind === 'ph').length;
      if (!lines.some((l) => l.kind !== 'ph')) { $('#sum').innerHTML = left ? `<span style="color:var(--hot)">⚠ ${left} أسطر بانتظار تحديد المنتج</span>` : ''; $('#diff').textContent = money(total); $('#diff').style.color = left ? 'var(--hot)' : ''; return; }
      try {
        const p = await eng.previewQuickDetail(payload());
        last = p;
        dl.querySelectorAll('.sline').forEach((row, k) => { row.querySelector('.lt').textContent = ` = ${money(p.lines[k].line_total)}`; });
        const ok = p.remaining === 0;
        $('#diff').textContent = ok ? '0 ✓' : money(p.remaining); $('#diff').style.color = ok ? 'var(--ok)' : 'var(--red)';
        $('#sum').innerHTML = [
          left ? `<span style="color:var(--hot)">⚠ ${left} أسطر بانتظار تحديد المنتج</span>` : '',
          can.view_cost_profit ? `الربح الحقيقي <b style="color:var(--gold)">${money(p.real_profit)}</b> <span class="muted">(بدل التقديري ${money(p.flat_profit)})</span>` : '',
          p.below_cost.length ? `<span style="color:var(--red)">⚠ بيع بأقل من التكلفة: ${p.below_cost.map((x) => esc(x.name)).join('، ')}</span>` : '',
          p.warnings.filter((w) => w.type === 'NEGATIVE_STOCK').length ? `<span style="color:var(--red)">⚠ مخزون سالب: ${p.warnings.filter((w) => w.type === 'NEGATIVE_STOCK').map((w) => esc(w.name)).join('، ')}</span>` : '',
        ].filter(Boolean).join('<br>');
        setSave(ok);
      } catch (e) { $('#derr').textContent = errText(e); }
    }
    async function save(send, allowBelowCost = false) {
      setSave(false);
      const cname = dcn ? dcn.value.trim() : '', cphone = dcp ? dcp.value.trim() : '';
      if (!!cname !== !!cphone) { $('#derr').textContent = cname ? 'أدخل هاتف الزبون أيضاً، أو امسح الاسم' : 'أدخل اسم الزبون أيضاً، أو امسح الهاتف'; setSave(true); return; }
      try {
        await eng.detailQuickSale(payload({ allowBelowCost, customer: cname ? { name: cname, phone: cphone } : undefined })); toast('تمت إضافة التفاصيل');
        if (send) {                                          // save and send: the invoice goes to WhatsApp right away
          const msg = await eng.share.invoiceMessage(inv.invoice_no).catch(() => null);
          if (msg) {
            const w = window.open(msg.link || `https://wa.me/?text=${encodeURIComponent(msg.text)}`, '_blank');
            eng.share.markSent(msg.invoice_id).catch(() => {});
            if (!w) showInvoice(app, inv.id);                // popup refused: show the invoice with its WhatsApp button
          }
        }
        if (pc) { list(); detail(d.invoice.id); } else if (direct) list(); else detail(d.invoice.id);
      } catch (e) {
        if (e.code === 'BELOW_COST') {
          if (await confirmBox('بيع بأقل من التكلفة', `${e.details.items.map((i) => i.name).join('، ')} — هل تريد المتابعة؟`)) return save(send, true);
        } else $('#derr').textContent = errText(e);
        setSave(true);
      }
    }
    $('#save').onclick = () => save(false);
    $('#saveSend').onclick = () => save(true);
    draw(); loadStock();
  }
  list();
  if (params.open) detail(params.open);
}

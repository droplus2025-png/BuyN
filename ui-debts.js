// Customer debts / supplier dues. Tap a party -> its invoice archive with the remaining amount of each invoice.
import { mount, $, esc, header, toast, errText, openModal, money, TYPE_AR, fmtWhen, partySuggest } from './ui-core.js';
import { money as M } from './index.js';
import { showInvoice } from './ui-invoices.js';

export async function renderDebts(app, { mode = 'customer' } = {}) {
  const eng = app.engine, can = app.session.permissions, cust = mode === 'customer';
  let open = null;                                           // id of the expanded party
  let showAll = false;                                       // also list the people who owe nothing (their paid invoices are kept)
  mount(`<div class="screen">${header(cust ? 'ديون الزبناء' : 'مستحقات الموردين')}<div class="body col">
    <div class="card" style="display:flex;justify-content:space-between;align-items:center"><span class="muted">${cust ? 'إجمالي الديون' : 'إجمالي المستحقات'}</span><b id="sum" style="font-size:1.5rem;color:var(--gold)">0</b></div>
    <input id="q" class="inp" placeholder="🔍 بحث بالاسم أو الهاتف" autocomplete="off">
    <div class="chips"><button class="chip on" data-all="0">${cust ? 'عليهم دين' : 'لهم مستحقات'}</button><button class="chip" data-all="1">الكل (بما فيهم المسدَّدون)</button></div>
    ${can.add_previous_debt ? `<button class="btn" id="prev">+ ${cust ? 'إضافة دين سابق' : 'إضافة مستحق سابق'}</button>` : ''}
    <div id="list" style="flex:1;overflow:auto;min-height:0;display:flex;flex-direction:column;gap:8px"></div></div></div>`);
  $('#hdrBack').onclick = () => app.go('home');

  async function load() {
    const all = await (cust ? eng.reports.customers() : eng.reports.suppliers());
    const q = $('#q').value.trim().toLowerCase(), digits = q.replace(/\D/g, '');
    const rows = all.filter((p) => (showAll || p.balance > 0) && (!q || p.name.toLowerCase().includes(q) || (digits.length >= 3 && p.phone_norm.includes(digits.replace(/^0+/, '')))))
      .sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name));
    $('#sum').textContent = money(all.reduce((a, p) => a + Math.max(p.balance, 0), 0));
    $('#list').innerHTML = rows.length ? rows.map((p) => `
      <div class="party card" data-id="${p.id}" style="padding:0;overflow:hidden">
        <button class="res phead" style="grid-template-columns:1fr auto;padding:12px">
          <span><b>${esc(p.name)}</b><br><span class="muted" dir="ltr" style="font-size:.85rem">${esc(p.phone)}${p.last_movement ? ' · ' + fmtWhen(p.last_movement) : ''}</span></span>
          <span class="p" style="font-size:1.25rem;color:${p.balance > 0 ? 'var(--amber)' : 'var(--ok)'}">${p.balance > 0 ? money(p.balance) : 'مسدَّد ✓'}</span></button>
        <div class="pbody"></div></div>`).join('') : '<div class="muted" style="padding:14px">لا يوجد أحد</div>';
    document.querySelectorAll('.phead').forEach((b) => b.addEventListener('click', () => toggle(b.closest('.party').dataset.id)));
    if (open) { const el = document.querySelector(`.party[data-id="${open}"]`); if (el) expand(el, rows.find((r) => r.id === open)); else open = null; }
  }
  let t; $('#q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 150); });

  document.querySelectorAll('.chip').forEach((ch) => ch.addEventListener('click', () => { showAll = ch.dataset.all === '1'; document.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === ch)); open = null; load(); }));
  async function toggle(id) { open = open === id ? null : id; await load(); }

  async function expand(el, p) {
    const st = await eng.reports.partyStatement(cust ? { customer_id: p.id } : { supplier_id: p.id });
    const body = el.querySelector('.pbody');
    body.innerHTML = `<div style="padding:0 10px 10px;display:flex;flex-direction:column;gap:6px">
      ${p.balance > 0 ? `<div class="row"><button class="btn teal act" id="pay" style="flex:1;font-size:1.05rem">${cust ? 'قبض' : 'دفع'}</button>
        ${cust && can.send_reminder ? '<button class="btn gold act" id="rem" style="flex:1">تذكير واتساب</button>' : ''}</div>` : ''}
      <div class="muted" style="font-size:.8rem">أرشيف الفواتير</div>
      ${st.map((i) => `<button class="inv" data-id="${i.id}"><span class="sku">${i.invoice_no}</span>
        <span>${TYPE_AR[i.type] || i.type}<br><span class="muted" style="font-size:.78rem">${fmtWhen(i.created_at)}</span></span>
        <span style="text-align:left"><b>${money(i.total)}</b>${i.remaining > 0 ? `<br><span class="pill amber">متبقي ${money(i.remaining)}</span>` : (['sale', 'purchase', 'opening_debt_customer', 'opening_debt_supplier'].includes(i.type) ? '<br><span class="pill">مسدّدة ✓</span>' : '')}</span></button>`).join('')}
    </div>`;
    body.querySelectorAll('.inv').forEach((b) => b.addEventListener('click', () => showInvoice(app, b.dataset.id)));
    body.querySelector('#pay')?.addEventListener('click', () => pay(p));
    body.querySelector('#rem')?.addEventListener('click', async () => {
      try { const r = await eng.share.reminder(p.id); window.open(r.link, '_blank'); toast('تم تجهيز التذكير'); load(); } catch (e) { toast(errText(e), true); }
    });
  }

  function pay(p) {
    openModal({
      title: `${cust ? 'قبض من' : 'دفع إلى'} ${p.name}`,
      html: `<div class="muted">المتبقي: <b style="color:var(--amber)">${money(p.balance)}</b> — يُوزَّع على الأقدم أولاً</div>
        <input id="amt" class="inp" inputmode="decimal" value="${money(p.balance)}"><div class="err" id="perr"></div>`,
      buttons: [{ label: 'إلغاء' }, { label: 'تأكيد', cls: 'gold', onClick: async (close, m) => {
        try {
          const amount = m.querySelector('#amt').value;
          const r = await (cust ? eng.collect({ id: p.id }, amount) : eng.paySupplier({ id: p.id }, amount));
          toast(`تم · فاتورة ${r.invoice.invoice_no}${r.warnings?.length ? ' ⚠ الصندوق سالب' : ''}`, false, 3000); await load();
        } catch (e) { m.querySelector('#perr').textContent = errText(e); return false; }
      } }],
      onOpen: (m) => { const a = m.querySelector('#amt'); a.focus(); a.select(); },
    });
  }

  $('#prev')?.addEventListener('click', () => openModal({
    title: cust ? 'دين سابق (من الدفتر)' : 'مستحق سابق (من الدفتر)',
    html: `<input id="n" class="inp" placeholder="الاسم"><input id="ph" class="inp" inputmode="tel" placeholder="الهاتف"><div id="sg"></div><input id="a" class="inp" inputmode="decimal" placeholder="المبلغ"><div class="err" id="perr"></div>`,
    buttons: [{ label: 'إلغاء' }, { label: 'حفظ', cls: 'gold', onClick: async (close, m) => {
      try { await eng.previousDebt({ kind: mode, party: { name: m.querySelector('#n').value, phone: m.querySelector('#ph').value }, amount: m.querySelector('#a').value }); toast('تمت الإضافة'); await load(); }
      catch (e) { m.querySelector('#perr').textContent = errText(e); return false; }
    } }], onOpen: (m) => { partySuggest(app, mode, m.querySelector('#n'), m.querySelector('#ph'), m.querySelector('#sg')); m.querySelector('#n').focus(); },
  }));
  load();
}

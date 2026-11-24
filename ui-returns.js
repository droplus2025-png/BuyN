// Returns: find the original invoice (number, name or phone), choose quantities, confirm.
// The original stays frozen; the debt is reduced first, the rest goes through the till.
import { mount, $, esc, header, toast, errText, openModal, money, price4, qtyStr } from './ui-core.js';
import { money as M } from './index.js';

export async function renderReturn(app, { mode = 'customer' } = {}) {
  const eng = app.engine, cust = mode === 'customer';
  const types = cust ? ['sale', 'quick_sale'] : ['purchase'];
  mount(`<div class="screen">${header(cust ? 'إرجاع من زبون' : 'إرجاع للمورد')}<div class="body col">
    <input id="q" class="inp" placeholder="🔍 رقم الفاتورة أو اسم / هاتف ${cust ? 'الزبون' : 'المورد'}" autocomplete="off">
    <div id="main" style="flex:1;overflow:auto;min-height:0;display:flex;flex-direction:column;gap:8px"></div>
    <div id="foot"></div></div></div>`);
  let back = () => app.go('home');
  $('#hdrBack').onclick = () => back();

  const when = (iso) => new Date(iso).toLocaleString('ar-MA-u-nu-latn', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  async function list() {
    back = () => app.go('home'); $('#foot').innerHTML = ''; $('#q').style.display = '';
    const rows = await eng.reports.searchInvoices({ text: $('#q').value, types });
    $('#main').innerHTML = rows.length ? `<div class="results" style="max-height:none">${rows.map((i) => `
      <button class="res" data-id="${i.id}" style="grid-template-columns:auto 1fr auto"><span class="sku">${i.invoice_no}</span>
      <span>${esc(i.party_name || (cust ? 'بدون اسم' : ''))}<br><span class="muted" style="font-size:.8rem">${when(i.created_at)}${i.is_modified ? ' · معدلة' : ''}</span></span>
      <span class="p">${money(i.total)}</span></button>`).join('')}</div>` : '<div class="muted" style="padding:14px">لا فواتير مطابقة</div>';
    document.querySelectorAll('#main .res').forEach((b) => b.addEventListener('click', () => open(b.dataset.id)));
  }
  let t; $('#q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(list, 150); });   // the pending search must never override an opened invoice

  async function open(id) {
    clearTimeout(t);
    const d = await eng.reports.invoice(id);
    if (!d) return toast('الفاتورة غير موجودة', true);
    $('#q').style.display = 'none';
    back = list;
    const ret = {};                                          // lineId -> text typed by the user
    const avail = (l) => l.qty - l.returned;
    const lineVal = (l) => { try { return M.lineCents(M.parseQty(ret[l.id] || 0), l.unit_price); } catch { return 0; } };
    $('#main').innerHTML = `<div class="card"><b style="color:var(--gold)">${d.invoice.invoice_no}</b> · ${esc(d.party?.name || '')}
      <span class="muted"> · الإجمالي ${money(d.invoice.total)}${d.remaining ? ` · المتبقي ${money(d.remaining)}` : ''}</span></div>
      ${d.lines.map((l) => `<div class="line" style="grid-template-columns:1fr 60px 78px" data-id="${l.id}">
        <div class="nm">${esc(l.name)}<br><span class="muted" style="font-size:.78rem">${price4(l.unit_price)} × ${qtyStr(l.qty)}${l.returned ? ` · أُرجع ${qtyStr(l.returned)}` : ''}</span></div>
        <button class="btn all" ${avail(l) <= 0 ? 'disabled' : ''} style="padding:8px 4px">الكل</button>
        <input class="inp r" inputmode="decimal" placeholder="0" ${avail(l) <= 0 ? 'disabled' : ''}></div>`).join('')}`;
    const foot = () => {
      const total = d.lines.reduce((a, l) => a + lineVal(l), 0);
      const credit = Math.min(total, d.remaining), cash = total - credit;
      $('#foot').innerHTML = `<div class="card">
        <div class="kv"><span>قيمة المرتجع</span><b>${money(total)}</b></div>
        ${credit ? `<div class="kv"><span>يُخفَّض من ${cust ? 'دين الزبون' : 'دين المورد'}</span><b>${money(credit)}</b></div>` : ''}
        ${cash ? `<div class="kv"><span>${cust ? 'يُرجع نقداً للزبون' : 'يُسترد نقداً من المورد'}</span><b>${money(cash)}</b></div>` : ''}
        <div class="err" id="rerr"></div><button class="btn teal big" id="go" style="width:100%;font-size:1.2rem" ${total <= 0 ? 'disabled' : ''}>تأكيد الإرجاع</button></div>`;
      $('#go').onclick = confirm;
    };
    document.querySelectorAll('#main .line').forEach((row) => {
      const l = d.lines.find((x) => x.id === row.dataset.id), inp = row.querySelector('.r');
      inp.addEventListener('focus', () => inp.select());
      inp.addEventListener('input', () => { ret[l.id] = inp.value; foot(); });
      row.querySelector('.all').addEventListener('click', () => { inp.value = qtyStr(avail(l)); ret[l.id] = inp.value; foot(); });
    });
    async function confirm() {
      const lines = [];
      for (const l of d.lines) {
        if (!ret[l.id]) continue;
        let q; try { q = M.parseQty(ret[l.id]); } catch (e) { $('#rerr').textContent = errText(e); return; }
        if (q <= 0) continue;
        if (q > avail(l)) { $('#rerr').textContent = `${l.name}: المتاح للإرجاع ${qtyStr(avail(l))} فقط`; return; }
        lines.push({ originLineId: l.id, qty: ret[l.id] });
      }
      if (!lines.length) return;
      $('#go').disabled = true;
      try {
        const r = await (cust ? eng.customerReturn : eng.supplierReturn)({ invoice: d.invoice.id, lines });
        const msg = await eng.share.invoiceMessage(r.invoice.invoice_no).catch(() => null);
        done(r, msg); await open(id);
      } catch (e) {
        $('#rerr').textContent = e.code === 'STOCK_INSUFFICIENT' ? `المخزون لا يكفي (المتوفر ${qtyStr(e.details.available)})` : errText(e);
        $('#go').disabled = false;
      }
    }
    foot();
  }
  function done(r, msg) {
    openModal({
      title: `✔ تم الإرجاع · ${r.invoice.invoice_no}`,
      html: `<div class="kv"><span>قيمة المرتجع</span><b>${money(r.invoice.total)}</b></div>
        ${r.debt_reduced ? `<div class="kv"><span>خُفِّض من الدين</span><b>${money(r.debt_reduced)}</b></div>` : ''}
        ${r.refunded ? `<div class="kv"><span>${cust ? 'أُرجع نقداً' : 'استُرد نقداً'}</span><b>${money(r.refunded)}</b></div>` : ''}`,
      buttons: [{ label: 'تم' }, ...(msg?.link ? [{ label: 'واتساب', cls: 'gold', onClick: () => { window.open(msg.link, '_blank'); eng.share.markSent(msg.invoice_id).catch(() => {}); } }] : [])],
    });
  }
  list();
}

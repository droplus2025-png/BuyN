// Till. Employee: opening balance + BLIND closing count (he never sees the expected balance).
// Owner: expected balance live, closing history with differences, deposit / withdrawal.
import { mount, $, esc, header, toast, errText, openModal, money, fmtWhen } from './ui-core.js';

export async function renderCash(app) {
  const eng = app.engine, owner = app.session.role === 'owner', can = app.session.permissions;
  mount(`<div class="screen">${header('الصندوق')}<div class="body col" id="b"></div></div>`);
  $('#hdrBack').onclick = () => app.go('home');

  async function draw() {
    const st = await eng.cash.status();
    let html = '';
    if (owner) {
      const bal = await eng.reports.cashBalance();
      html += `<div class="card"><div class="kv"><span>الرصيد الآن (المتوقع)</span><b style="font-size:1.4rem;color:var(--gold)">${money(bal)}</b></div></div>`;
    }
    if (!st.open) {
      html += `<div class="card"><div class="muted">لا توجد جلسة مفتوحة للصندوق</div><button class="btn gold big" id="open" style="width:100%;margin-top:8px">بدء جلسة الصندوق</button></div>`;
    } else {
      html += `<div class="card"><div class="kv"><span>رصيد الافتتاح</span><b>${money(st.opening_balance)}</b></div>
        <div class="lbl" style="margin-top:8px">المبلغ المعدود في الصندوق الآن</div>
        <input id="counted" class="inp" inputmode="decimal" placeholder="اعدّ النقود ثم اكتب المبلغ"><div class="err" id="err"></div>
        <button class="btn teal big" id="close" style="width:100%;margin-top:8px;font-size:1.2rem">إغلاق الصندوق</button>
        <div class="muted" style="font-size:.8rem;margin-top:6px">الفرق (نقص أو زيادة) يُسجَّل نهائياً، ويصبح المبلغ المعدود رصيد الافتتاح التالي.</div></div>`;
    }
    if (owner || can.cash_deposit_withdraw) html += `<div class="row"><button class="btn" id="dep" style="flex:1">+ إيداع</button><button class="btn" id="wd" style="flex:1">− سحب</button></div>`;
    if (owner) {
      const sess = (await eng.reports.cashSessions()).filter((s) => s.closed_at).slice(0, 15);
      html += `<div class="card"><div class="grp" style="margin-top:0">آخر الإغلاقات</div>${sess.length ? sess.map((s) => `
        <div class="kv"><span>${fmtWhen(s.closed_at)}<br><span class="muted" style="font-size:.78rem">معدود ${money(s.counted_amount)} · متوقع ${money(s.expected_amount)}</span></span>
        <b style="color:${s.difference === 0 ? 'var(--ok)' : 'var(--red)'}">${s.difference === 0 ? 'مطابق ✓' : (s.difference > 0 ? '+' : '') + money(s.difference)}</b></div>`).join('') : '<div class="muted">لا إغلاقات بعد</div>'}</div>`;
    }
    $('#b').innerHTML = html;

    $('#open')?.addEventListener('click', async () => { try { await eng.cash.open(); draw(); } catch (e) { toast(errText(e), true); } });
    $('#close')?.addEventListener('click', async () => {
      $('#err').textContent = '';
      try {
        const r = await eng.cash.close($('#counted').value);
        toast(owner ? (r.difference === 0 ? 'تم الإغلاق: الصندوق مطابق ✓' : `تم الإغلاق · الفرق ${money(r.difference)}`) : 'تم إغلاق الصندوق', owner && r.difference !== 0, 3500);
        draw();
      } catch (e) { $('#err').textContent = errText(e); }
    });
    for (const [id, fn, title] of [['dep', 'deposit', 'إيداع في الصندوق'], ['wd', 'withdraw', 'سحب من الصندوق']]) {
      $(`#${id}`)?.addEventListener('click', () => openModal({
        title, html: `<input id="a" class="inp" inputmode="decimal" placeholder="المبلغ"><input id="n" class="inp" placeholder="ملاحظة (اختياري)"><div class="err" id="perr"></div>`,
        buttons: [{ label: 'إلغاء' }, { label: 'تأكيد', cls: 'gold', onClick: async (close, m) => {
          try { const r = await eng[fn](m.querySelector('#a').value, m.querySelector('#n').value || undefined); toast(`تم · ${r.invoice.invoice_no}${r.warnings?.length ? ' ⚠ الصندوق سالب' : ''}`); draw(); }
          catch (e) { m.querySelector('#perr').textContent = errText(e); return false; }
        } }], onOpen: (m) => m.querySelector('#a').focus(),
      }));
    }
  }
  draw();
}

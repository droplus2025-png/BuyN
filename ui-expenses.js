// Expenses: amount + free description, taken out of the till immediately.
import { mount, $, esc, header, toast, errText, money, fmtWhen, setNext } from './ui-core.js';

export async function renderExpenses(app) {
  const eng = app.engine, pc = document.body.classList.contains('pcmode');      // computer: form | list side by side
  mount(`<div class="screen">${header('مصاريف')}<div class="body col">${pc ? '<div class="cols2"><div class="cols2-item">' : ''}
    <div class="card" style="display:flex;flex-direction:column;gap:8px">
      <input id="amt" class="inp" inputmode="decimal" placeholder="المبلغ" autocomplete="off">
      <input id="desc" class="inp" placeholder="الوصف (كهرباء، نقل، إيجار…)" autocomplete="off">
      <div class="err" id="err"></div>
      <button class="btn teal big" id="go" style="font-size:1.3rem">تسجيل المصروف</button></div>
    <div class="card" style="display:flex;justify-content:space-between"><span class="muted">مصاريف اليوم</span><b id="today" style="color:var(--gold)">0</b></div>${pc ? '</div><div class="cols2-item">' : ''}
    <div id="list" style="flex:1;overflow:auto;min-height:0"></div>${pc ? '</div></div>' : ''}</div></div>`);
  $('#hdrBack').onclick = () => app.go('home');
  $('#amt').focus();
  $('#amt').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#desc').focus(); });
  $('#desc').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#go').click(); });

  // computer: the program points to the next step (notice in the top bar + pulsing target)
  function nextStep() {
    if (!pc) return;
    const [text, target] = !$('#amt').value ? ['اكتب مبلغ المصروف', '#amt'] : !$('#desc').value.trim() ? ['اكتب وصف المصروف', '#desc'] : ['اضغط تسجيل المصروف', '#go'];
    setNext(text, target);
  }
  ['amt', 'desc'].forEach((id) => $(`#${id}`).addEventListener('input', nextStep));

  async function load() {
    const rows = await eng.reports.invoices({ type: 'expense', limit: 60 });
    const key = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: app.cfg.timezone });
    const today = key(new Date().toISOString());
    $('#today').textContent = money(rows.filter((r) => key(r.created_at) === today).reduce((a, r) => a + r.total, 0));
    $('#list').innerHTML = rows.length ? `<div class="results" style="max-height:none">${rows.map((r) => `
      <div class="res" style="grid-template-columns:auto 1fr auto;cursor:default"><span class="sku">${r.invoice_no}</span>
      <span>${esc(r.note || '')}<br><span class="muted" style="font-size:.8rem">${fmtWhen(r.created_at)}</span></span><span class="p" style="color:var(--amber)">−${money(r.total)}</span></div>`).join('')}</div>`
      : '<div class="muted" style="padding:14px">لا مصاريف مسجلة</div>';
  }
  $('#go').onclick = async () => {
    $('#err').textContent = '';
    try {
      const r = await eng.expense($('#amt').value, $('#desc').value);
      toast(`تم · ${r.invoice.invoice_no}${r.warnings?.length ? ' ⚠ الصندوق سالب' : ''}`, false, 2500);
      $('#amt').value = ''; $('#desc').value = ''; $('#amt').focus(); await load(); nextStep();
    } catch (e) { $('#err').textContent = e.code === 'DESCRIPTION_REQUIRED' ? 'اكتب وصف المصروف' : errText(e); }
  };
  load(); nextStep();
}

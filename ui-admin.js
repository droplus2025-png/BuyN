// Administration (owner only): live store value, store settings, employees & permissions, reset.
import { mount, $, esc, header, toast, errText, openModal, confirmBox, money, qtyStr, download, fmtWhen, syncErrText, paperHtml } from './ui-core.js';
import { APP_VERSION } from './version.js';
import { renderInvoice } from './invoice-text.js';
import { DEFAULT_SETTINGS } from './settings.js';

const GROUPS = { sales: 'البيع', purchases: 'الشراء', returns: 'الإرجاع', money: 'المال والصندوق', stock: 'المخزون', other: 'أخرى' };

export async function renderAdmin(app) {
  const eng = app.engine, auth = app.auth, S = app.session, c = app.cfg;
  mount(`<div class="screen">${header('الإدارة')}<div class="body cards" id="b"></div></div>`);
  $('#hdrBack').onclick = () => app.go('home');
  $('#b').addEventListener('click', (e) => { const b = e.target.closest('.per'); if (b) { app.statDays = Number(b.dataset.d); draw(); } });

  async function draw() {
    const v = await eng.reports.storeValue();
    const emps = await auth.listEmployees(S);
    const days = await eng.reports.dailyReport();
    const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: c.timezone });
    const z = { sales_count: 0, sales_total: 0, returns_total: 0, gross_profit: 0, expenses: 0, net_profit: 0, undetailed_count: 0, undetailed_total: 0, estimated_profit: 0, real_profit: 0 };
    const t = days.find((x) => x.day === todayKey) || z;
    const last = await eng.admin.lastBackupAt();
    const sd = app.statDays ?? 30, cs = await eng.reports.categoryStats({ days: sd });
    const cn = (d) => (d === 'x' ? 'خارج المخزون' : (c.categories || {})[d] || 'بدون اسم');
    const maxRev = Math.max(1, ...cs.cats.map((x) => x.revenue)), best = [...cs.cats].filter((x) => x.cat !== 'x' && x.profit > 0).sort((a, b) => b.profit - a.profit)[0];
    const idle = cs.cats.filter((x) => x.cat !== 'x' && x.stock_count && x.revenue <= 0);
    const role = app.sync.role, tpl = c.invoice_template, canShare = !!(navigator.canShare && navigator.canShare({ files: [new File(['{}'], 'x.json', { type: 'application/json' })] }));
    $('#b').innerHTML = `
      <div class="card"><div class="grp" style="margin-top:0">تقرير اليوم</div>
        <div class="kv"><span>المبيعات (${t.sales_count} فاتورة)</span><b>${money(t.sales_total)}</b></div>
        <div class="kv"><span>المرتجعات</span><b>${money(t.returns_total)}</b></div>
        <div class="kv"><span>الربح الحقيقي <span class="muted" style="font-size:.78rem">(بيع عادي + بيع سريع مفصّل)</span></span><b>${money(t.real_profit)}</b></div>
        <div class="kv"><span>ربح تقديري <span class="muted" style="font-size:.78rem">(${t.undetailed_count} بيع سريع غير مفصّل بمبلغ ${money(t.undetailed_total)} × ${c.quick_sale_profit_pct}%)</span></span><b style="color:var(--amber)">${money(t.estimated_profit)}</b></div>
        <div class="kv"><span>إجمالي الربح</span><b style="color:var(--gold)">${money(t.gross_profit)}</b></div>
        <div class="kv"><span>المصاريف</span><b>−${money(t.expenses)}</b></div>
        <div class="kv" style="font-size:1.15rem"><span>صافي الربح</span><b style="color:var(--gold)">${money(t.net_profit)}</b></div>
        ${days.filter((x) => x.day !== todayKey).slice(0, 10).length ? `<div class="grp">الأيام السابقة</div>${days.filter((x) => x.day !== todayKey).slice(0, 10).map((x) => `<div class="kv"><span>${x.day}</span><span class="muted">مبيعات ${money(x.sales_total)}</span><b>${money(x.net_profit)}</b></div>`).join('')}` : ''}</div>

      <div class="card"><div class="grp" style="margin-top:0">قيمة المحل الآن</div>
        <div class="kv"><span>الصندوق</span><b>${money(v.cash)}</b></div>
        <div class="kv"><span>المخزون (بسعر الشراء)</span><b>${money(v.stock)}</b></div>
        <div class="kv"><span>ديون الزبناء</span><b>${money(v.customer_debts)}</b></div>
        <div class="kv"><span>مستحقات الموردين</span><b>−${money(v.supplier_dues)}</b></div>
        <div class="kv" style="font-size:1.2rem"><span>القيمة الإجمالية</span><b style="color:var(--gold)">${money(v.store_value)}</b></div></div>

      <div class="card"><div class="grp" style="margin-top:0">إعدادات المحل</div>
        ${[['store_name', 'اسم المحل'], ['store_phone', 'هاتف المحل'], ['store_address', 'العنوان'], ['thanks_text', 'عبارة الشكر'], ['currency', 'العملة (مثل DH)'], ['quick_sale_profit_pct', 'نسبة الربح في البيع السريع %']]
          .map(([k, l]) => `<div class="lbl">${l}</div><input class="inp cfg" data-k="${k}" value="${esc(c[k])}" ${k === 'quick_sale_profit_pct' ? 'inputmode="decimal"' : ''}>`).join('')}
        <label class="sw"><span>🔊 صوت أزرار شاشة البيع (بيب، وبيبان عند الدفع)</span><input type="checkbox" id="cfgBeep" ${c.sale_beep !== false ? 'checked' : ''}></label>
        <button class="btn gold" id="saveCfg" style="margin-top:8px;width:100%">حفظ الإعدادات</button></div>

      <div class="card"><div class="grp" style="margin-top:0">إحصائيات الأصناف</div>
        <div class="row" style="margin-bottom:8px">${[[1, 'اليوم'], [7, '7 أيام'], [30, '30 يوماً'], [0, 'الكل']].map(([d, t]) => `<button class="btn per ${sd === d ? 'gold' : ''}" data-d="${d}" style="flex:1">${t}</button>`).join('')}</div>
        ${best ? `<div class="kv"><span>🏆 أفضل صنف ربحاً</span><b style="color:var(--gold)">${best.cat} · ${esc(cn(best.cat))}</b></div>` : ''}
        ${idle.length ? `<div class="kv"><span>🐌 أصناف بلا مبيعات وفيها مخزون</span><b style="color:var(--amber)">${idle.map((x) => x.cat).join(' · ')}</b></div>` : ''}
        ${cs.cats.map((x) => `<div class="catstat"><div class="cs-h"><b>${x.cat === 'x' ? '＋' : x.cat}</b><span>${esc(cn(x.cat))}</span><em>${money(x.revenue)}</em></div>
          <div class="cs-bar"><i style="width:${Math.max(0, Math.round(x.revenue / maxRev * 100))}%"></i></div>
          <div class="cs-d"><span>ربح <b>${money(x.profit)}</b></span><span>كمية مباعة <b>${qtyStr(x.qty) || 0}</b></span>${x.cat === 'x' ? '' : `<span>مخزون <b>${x.stock_count}</b> منتج · ${money(x.stock_value)}</span>${x.zero_count ? `<span style="color:var(--red)">${x.zero_count} بقيمة صفر</span>` : ''}`}</div></div>`).join('') || '<div class="muted">لا بيانات بعد</div>'}</div>

      <div class="card"><div class="grp" style="margin-top:0">الأصناف ولوحة الحروف</div>
        <div class="muted" style="margin-bottom:6px">الصنف هو الرقم الأول من كود المنتج (0-9). لا يظهر أثناء البيع، ويُستعمل للجرد والإحصائيات.</div>
        ${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<div class="row" style="align-items:center;margin-bottom:6px"><b style="width:26px;color:var(--gold);font-size:1.2rem">${n}</b><input class="inp catn" data-d="${n}" maxlength="30" placeholder="اسم الصنف ${n}" value="${esc((c.categories || {})[n] || '')}"></div>`).join('')}
        <div class="lbl">لوحة الحروف في شاشة الحاسوب</div>
        <select class="inp" id="lettersLayout"><option value="latin" ${c.letters_layout !== 'ar' ? 'selected' : ''}>لاتينية (abc)</option><option value="ar" ${c.letters_layout === 'ar' ? 'selected' : ''}>عربية</option></select>
        <button class="btn gold" id="saveCats" style="margin-top:8px;width:100%">حفظ الأصناف واللوحة</button></div>

      <div class="card"><div class="grp" style="margin-top:0">الموظفون</div>
        ${emps.length ? emps.map((e) => `<div class="sw"><span>${esc(e.name)} ${e.active ? '' : '<span class="muted">(موقوف)</span>'}</span>
          <span class="row"><button class="btn" data-perm="${e.id}">الصلاحيات</button><button class="btn" data-act="${e.id}" data-on="${e.active ? 1 : 0}">${e.active ? 'إيقاف' : 'تفعيل'}</button></span></div>`).join('')
          : '<div class="muted">لا يوجد موظفون بعد</div>'}
        <button class="btn" id="addEmp" style="margin-top:8px;width:100%">+ إضافة موظف</button></div>

      <div class="card"><div class="grp" style="margin-top:0">النسخ الاحتياطي</div>
        <div class="kv"><span>آخر نسخة</span><b style="color:${last && (Date.now() - new Date(last)) < 3 * 864e5 ? 'var(--ok)' : 'var(--amber)'}">${last ? fmtWhen(last) : 'لم تُحفظ أي نسخة'}</b></div>
        <div class="row" style="margin-top:8px"><button class="btn gold" id="export" style="flex:1">⬇ حفظ نسخة احتياطية</button>
          ${canShare ? '<button class="btn" id="share" style="flex:1">مشاركة</button>' : ''}</div>
        <button class="btn" id="restore" style="width:100%;margin-top:8px">⬆ استعادة من ملف</button>
        <input type="file" id="restoreFile" accept=".json,application/json" style="display:none">
        <div class="muted" style="font-size:.78rem;margin-top:6px">الملف يحوي كل البيانات وبصمات كلمات المرور. احفظه في مكان آمن (Drive أو واتساب لنفسك). الاستعادة تفحص الملف أولاً وتستبدل كل ما في هذا الجهاز.</div></div>

      <div class="card"><div class="grp" style="margin-top:0">المزامنة والأجهزة</div>
        <div class="kv"><span>دور هذا الجهاز</span><b>${role === 'main' ? 'رئيسي' : role === 'linked' ? 'مرتبط' : 'غير مرتبط'}</b></div>
        <div class="kv"><span>الحالة</span><b id="syState">…</b></div>
        <div class="kv"><span>بانتظار الإرسال</span><b id="syPend">…</b></div>
        <div class="kv"><span>آخر مزامنة</span><b id="syLast">—</b></div>
        <div class="kv"><span>التفعيل صالح حتى (دون اتصال)</span><b dir="ltr">${app.sync.leaseUntil ? fmtWhen(app.sync.leaseUntil) : '—'}</b></div>
        <button class="btn gold" id="syNow" style="width:100%;margin-top:8px">مزامنة الآن</button>
        ${role === 'main' ? '<button class="btn" id="syCode" style="width:100%;margin-top:8px">+ رمز ربط جهاز جديد</button><button class="btn" id="syDevs" style="width:100%;margin-top:8px">الأجهزة المرتبطة</button>' : ''}
        <div class="muted" style="font-size:.78rem;margin-top:6px">تعمل المزامنة وحدها عند توفر الإنترنت. بدون إنترنت يستمر البرنامج بالعمل وتُرسل العمليات لاحقاً. الجهاز الرئيسي وحده يربط الأجهزة ويفصلها.</div></div>

      <div class="card" style="grid-column:1/-1"><div class="grp" style="margin-top:0">شكل الفاتورة (واتساب)</div>
        <div class="tplgrid">
          <div>${[['show_phone', 'إظهار هاتف المحل'], ['show_address', 'إظهار العنوان'], ['show_customer', 'إظهار اسم الزبون'], ['bold_total', 'المجموع بخط عريض']]
            .map(([k, l]) => `<label class="sw"><span>${l}</span><input type="checkbox" class="tpl" data-k="${k}" ${tpl[k] ? 'checked' : ''}></label>`).join('')}
            <div class="lbl">شكل سطر المنتج</div>
            <select class="inp tpl" data-k="line_format"><option value="${esc(DEFAULT_SETTINGS.invoice_template.line_format)}" ${tpl.line_format === DEFAULT_SETTINGS.invoice_template.line_format ? 'selected' : ''}>سطر واحد: المنتج ثم الكمية×السعر والمجموع (الافتراضي)</option>
              <option value="{n}. {name}\n   {qty}×{price}  {total}" ${tpl.line_format === '{n}. {name}\n   {qty}×{price}  {total}' ? 'selected' : ''}>سطران: الاسم ثم الكمية×السعر والمجموع</option></select>
            <div class="lbl">الفاصل</div><input class="inp tpl" data-k="separator" value="${esc(tpl.separator)}">
            <div class="lbl">عبارة الختام (تأخذ {thanks_text} من الإعدادات)</div><input class="inp tpl" data-k="footer" value="${esc(tpl.footer)}">
            ${Object.keys(DEFAULT_SETTINGS.invoice_template.labels).map((k) => `<div class="lbl">عنوان: ${k}</div><input class="inp tpl lab" data-k="${k}" value="${esc(tpl.labels[k])}">`).join('')}
          </div>
          <div><div class="lbl">معاينة مباشرة</div><div id="tplPreview" class="card inv-paper" style="margin:0"></div>
            <div class="row" style="margin-top:8px"><button class="btn" id="tplReset" style="flex:1">الافتراضي</button><button class="btn gold" id="tplSave" style="flex:1">حفظ الشكل</button></div></div>
        </div></div>

      <div class="card"><div class="grp" style="margin-top:0">الحساب والبرنامج</div>
        <button class="btn" id="chCode" style="width:100%">تغيير كلمة مرور المالك</button>
        <div class="kv"><span>إصدار البرنامج</span><b>${APP_VERSION}</b></div>
        <button class="btn red" id="reset" style="margin-top:8px;width:100%">تصفير العمليات (للتجارب) — يُبقي المنتجات والمخزون</button>
        <button class="btn red" id="resetStock" style="margin-top:8px;width:100%">حذف كل المنتجات — قابل للاسترجاع من المخزون ← «المحذوفة»</button></div>`;

    // ---- invoice template editor with live preview
    const readTpl = () => {
      const t2 = JSON.parse(JSON.stringify(tpl)); t2.labels = { ...tpl.labels };
      document.querySelectorAll('.tpl').forEach((el) => {
        const k = el.dataset.k;
        if (el.classList.contains('lab')) t2.labels[k] = el.value; else t2[k] = el.type === 'checkbox' ? el.checked : el.value;
      });
      return t2;
    };
    const sample = () => renderInvoice({
      invoice: { invoice_no: '61115001', type: 'sale', created_at: new Date().toISOString(), total: 12000, paid: 10000, credit_amount: 2000, note: null },
      lines: [{ name: 'منتج تجريبي 1', qty: 2000, unit_price: 250000, line_total: 5000 }, { name: 'منتج تجريبي 2', qty: 1000, unit_price: 700000, line_total: 7000 }],
      party: { name: 'اسم الزبون' }, settings: { ...c, invoice_template: readTpl() },
    });
    const paint = () => { $('#tplPreview').innerHTML = paperHtml(sample()); };
    document.querySelectorAll('.tpl').forEach((el) => { el.addEventListener('input', paint); el.addEventListener('change', paint); });
    paint();
    $('#tplSave').onclick = async () => { try { await eng.settings.set('invoice_template', readTpl()); await app.refreshCfg(); toast('تم حفظ شكل الفاتورة'); } catch (e) { toast(errText(e), true); } };
    $('#tplReset').onclick = async () => { await eng.settings.set('invoice_template', DEFAULT_SETTINGS.invoice_template); await app.refreshCfg(); toast('عادت الفاتورة للشكل الافتراضي'); draw(); };

    // ---- backup / restore
    const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    async function makeFile() {
      const file = await eng.admin.backup();
      return new File([JSON.stringify(file)], `pos-backup-${stamp()}.json`, { type: 'application/json' });
    }
    $('#export').onclick = async () => {
      try {
        const f = await makeFile(); download(f, f.name); toast('تم حفظ النسخة الاحتياطية'); draw();
      } catch (e) { toast(errText(e), true); }
    };
    $('#share')?.addEventListener('click', async () => {
      try { const f = await makeFile(); await navigator.share({ files: [f], title: 'نسخة احتياطية' }); draw(); }
      catch (e) { if (e.name !== 'AbortError') toast(errText(e), true); }
    });
    $('#restore').onclick = () => $('#restoreFile').click();
    $('#restoreFile').addEventListener('change', async (ev) => {
      const f = ev.target.files[0]; ev.target.value = '';
      if (!f) return;
      let file; try { file = JSON.parse(await f.text()); } catch { return toast('الملف ليس نسخة احتياطية صالحة', true); }
      let v; try { v = await eng.admin.verifyBackup(file); } catch (e) { return toast(errText(e), true, 3500); }
      if (!v.ok) return openModal({ title: 'ملف مرفوض', html: `<div class="err">الأرقام داخل الملف لا تتطابق (تالف أو مُعدَّل):</div>${v.problems.slice(0, 5).map((p) => `<div class="muted" style="font-size:.8rem">${esc(p.check)} · ${esc(p.ref)}</div>`).join('')}`, buttons: [{ label: 'إغلاق', cls: 'gold' }] });
      openModal({ title: 'استعادة نسخة احتياطية',
        html: `<div class="kv"><span>تاريخ النسخة</span><b>${v.exported_at ? new Date(v.exported_at).toLocaleString('ar-MA-u-nu-latn') : '—'}</b></div>
          <div class="kv"><span>المنتجات</span><b>${v.counts.products}</b></div><div class="kv"><span>الفواتير</span><b>${v.counts.invoices}</b></div>
          <div class="kv"><span>الزبناء / الموردون</span><b>${v.counts.customers} / ${v.counts.suppliers}</b></div>
          <div class="err">⚠ سيُستبدل كل ما في هذا الجهاز بمحتوى هذه النسخة، وستدخل بكلمات مرورها.</div>`,
        buttons: [{ label: 'إلغاء' }, { label: 'استعادة', cls: 'gold', onClick: async () => {
          try { await eng.admin.restoreBackup(file); toast('تمت الاستعادة، سيُعاد تشغيل البرنامج'); setTimeout(() => location.reload(), 900); }
          catch (e) { toast(errText(e), true, 3500); }
        } }] });
    });

    $('#saveCats').onclick = async () => {
      try {
        const cats = {}; document.querySelectorAll('.catn').forEach((i) => { cats[i.dataset.d] = i.value.trim(); });
        await eng.settings.set('categories', cats); await eng.settings.set('letters_layout', $('#lettersLayout').value);
        await app.refreshCfg(); toast('تم حفظ الأصناف واللوحة');
      } catch (e) { toast(errText(e), true, 3000); }
    };
    $('#saveCfg').onclick = async () => {
      try {
        for (const inp of document.querySelectorAll('.cfg')) {
          const k = inp.dataset.k; let val = inp.value;
          if (k === 'quick_sale_profit_pct') val = Number(String(val).replace(',', '.'));
          if (val !== c[k]) await eng.settings.set(k, val);
        }
        const beepOn = $('#cfgBeep').checked;
        if (beepOn !== (c.sale_beep !== false)) await eng.settings.set('sale_beep', beepOn);
        await app.refreshCfg(); toast('تم حفظ الإعدادات');
      } catch (e) { toast(errText(e), true, 3000); }
    };
    // ---- sync card: the main device makes link codes and disconnects devices
    const SY = { off: 'غير مرتبط', idle: 'متزامن ✔', syncing: 'جارٍ المزامنة…', offline: 'بلا إنترنت', error: 'خطأ', badcode: 'مفتاح الجهاز غير صحيح', revoked: 'مفصول' };
    const paintSy = (s) => {
      if (!$('#syState')) return;
      $('#syState').textContent = SY[s.state] + (s.error && s.state === 'error' ? ` (${s.error.slice(0, 40)})` : '');
      $('#syPend').textContent = s.pending; $('#syLast').textContent = s.last ? new Date(s.last).toLocaleTimeString('ar-MA-u-nu-latn', { hour: '2-digit', minute: '2-digit' }) : '—';
    };
    app.syncHook = paintSy; paintSy(app.sync.status);
    $('#syNow')?.addEventListener('click', () => app.sync.syncNow());
    $('#syCode')?.addEventListener('click', async () => {
      try {
        const { code, expires_at: exp } = await app.sync.pairingCode();
        openModal({ title: 'رمز ربط جهاز جديد', html: `<div class="muted" style="text-align:center">أدخله في الجهاز الجديد (شاشة «ربط بالجهاز الرئيسي»). صالح 10 دقائق ولمرة واحدة.</div>
          <div style="font-size:2.4rem;font-weight:900;color:var(--gold);text-align:center;direction:ltr;letter-spacing:4px">${esc(code.slice(0, 4))} ${esc(code.slice(4))}</div>
          <div class="muted" style="text-align:center">ينتهي ${esc(new Date(exp).toLocaleTimeString('ar-MA-u-nu-latn', { hour: '2-digit', minute: '2-digit' }))}</div>`, buttons: [{ label: 'إغلاق', cls: 'gold' }] });
      } catch (e) { toast(syncErrText(e), true, 3500); }
    });
    $('#syDevs')?.addEventListener('click', () => devices());
    $('#addEmp').onclick = () => openModal({
      title: 'إضافة موظف', html: `<input id="n" class="inp" placeholder="اسم الموظف"><input id="c" class="inp" type="password" placeholder="كلمة مروره (4 أحرف على الأقل)"><div class="err" id="err"></div>`,
      buttons: [{ label: 'إلغاء' }, { label: 'حفظ', cls: 'gold', onClick: async (close, m) => {
        try { await auth.addEmployee(S, { name: m.querySelector('#n').value.trim() || 'موظف', code: m.querySelector('#c').value }); draw(); }
        catch (e) { m.querySelector('#err').textContent = errText(e); return false; }
      } }], onOpen: (m) => m.querySelector('#n').focus() });
    $('#chCode').onclick = () => openModal({
      title: 'كلمة مرور جديدة', html: `<input id="c" class="inp" type="password" placeholder="الكلمة الجديدة"><div class="err" id="err"></div>`,
      buttons: [{ label: 'إلغاء' }, { label: 'حفظ', cls: 'gold', onClick: async (close, m) => {
        try { await auth.changeCode(S, S.userId, m.querySelector('#c').value); toast('تم التغيير'); }
        catch (e) { m.querySelector('#err').textContent = errText(e); return false; }
      } }], onOpen: (m) => m.querySelector('#c').focus() });
    document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
      await auth.setEmployeeActive(S, b.dataset.act, b.dataset.on !== '1'); draw();
    }));
    document.querySelectorAll('[data-perm]').forEach((b) => b.addEventListener('click', () => permissions(b.dataset.perm)));
    // empty the stock: a backup file is saved first, then the word "تصفير" must be typed
    $('#resetStock').onclick = async () => {
      let n = 0; try { n = (await eng.products.search('', 100000)).length; } catch { /* count only */ }
      openModal({ title: 'حذف كل المنتجات',
        html: `<div class="err" style="margin-bottom:8px">سيُخفى ${n ? `<b>${n}</b> ` : ''}منتج من المخزون. لا يُحذف شيء نهائياً: الأرقام تبقى محجوزة، والكميات والأسعار محفوظة، ويمكن استرجاعها من المخزون ← «المحذوفة» (منتجاً منتجاً أو الكل).</div>
          <div class="lbl">اكتب كلمة «تصفير» للتأكيد</div><input id="w" class="inp" autocomplete="off"><div class="err" id="err"></div>`,
        buttons: [{ label: 'إلغاء' }, { label: 'حذف الكل', cls: 'red', onClick: async (close, m) => {
          if (m.querySelector('#w').value.trim() !== 'تصفير') { m.querySelector('#err').textContent = 'اكتب الكلمة كما هي'; return false; }
          try { const r = await eng.admin.resetStock(); toast(`حُذف ${r.products_removed} منتج (قابلة للاسترجاع)`, false, 3500); draw(); }
          catch (e) { m.querySelector('#err').textContent = errText(e); return false; }
        } }],
        onOpen: (m) => m.querySelector('#w').focus() });
    };
    $('#reset').onclick = () => openModal({ title: 'تصفير العمليات',
      html: `<div class="err" style="margin-bottom:8px">ستُحذف كل الفواتير والزبناء والموردين والديون والصندوق. تبقى المنتجات والمخزون. لا يمكن التراجع إلا بالنسخة الاحتياطية التي تُحفظ تلقائياً الآن.</div>
        <div class="lbl">اكتب كلمة «تصفير» للتأكيد</div><input id="w" class="inp" autocomplete="off"><div class="err" id="err"></div>`,
      buttons: [{ label: 'إلغاء' }, { label: 'حفظ نسخة ثم تصفير', cls: 'red', onClick: async (close, m) => {
        if (m.querySelector('#w').value.trim() !== 'تصفير') { m.querySelector('#err').textContent = 'اكتب الكلمة كما هي'; return false; }
        try {
          const f = await makeFile(); download(f, `avant-reset-operations-${f.name}`);                // safety copy first
          const r = await eng.admin.resetOperations(); toast(`تم التصفير · ${r.products_kept} منتج محفوظ`); draw();
        } catch (e) { m.querySelector('#err').textContent = errText(e); return false; }
      } }],
      onOpen: (m) => m.querySelector('#w').focus() });
  }

  // the devices of the shop (main device): who, when last seen, disconnect with the owner's choice (lock / wipe)
  async function devices() {
    let list;
    try { list = await app.sync.devices(); } catch (e) { return toast(syncErrText(e), true, 3500); }
    const ST = (d) => (d.status === 'active' ? '<span class="pill">نشط</span>' : d.revoke_mode === 'wipe' ? `<span class="pill amber">${d.wipe_confirmed_at ? 'مفصول · مُسحت بياناته' : 'مفصول · بانتظار المسح'}</span>` : '<span class="pill amber">مفصول · مقفل</span>');
    const me = list.find((d) => d.role === 'main' && d.status === 'active');
    openModal({ title: 'الأجهزة المرتبطة', tall: true,
      html: `<div class="muted" style="font-size:.78rem">معرّف المحل: <span dir="ltr" style="user-select:text">${esc(app.sync.shopId || '')}</span></div>`
        + list.map((d) => `<div class="sw"><span>${esc(d.name || d.id)} <span class="muted">(${d.role === 'main' ? 'رئيسي' : 'مرتبط'})</span><br><span class="muted" style="font-size:.78rem">${d.last_seen_at ? 'آخر ظهور ' + fmtWhen(d.last_seen_at) : 'لم يتصل بعد'}</span></span>
          <span class="row">${ST(d)}${d.status === 'active' && d !== me && d.role !== 'main' ? `<button class="btn red" data-rv="${esc(d.id)}">فصل</button>` : ''}</span></div>`).join(''),
      buttons: [{ label: 'إغلاق', cls: 'gold' }],
      onOpen: (m) => m.querySelectorAll('[data-rv]').forEach((b) => b.addEventListener('click', () => revoke(b.dataset.rv, list.find((d) => d.id === b.dataset.rv)))) });
  }
  function revoke(id, d) {
    openModal({ title: `فصل ${d?.name || 'الجهاز'}`,
      html: `<div>اختر ما يحدث لبيانات المحل على هذا الجهاز عند أول اتصال له بالإنترنت:</div>
        <div class="muted" style="font-size:.85rem"><b>قفل:</b> يُقفل البرنامج وتبقى البيانات مخزّنة (يعود بعد رمز ربط جديد).<br><b>مسح:</b> تُمسح كل بيانات المحل من الجهاز نهائياً.<br>إن كان الجهاز بلا إنترنت فيعمل محلياً حتى يتصل.</div>`,
      buttons: [{ label: 'إلغاء' }, { label: 'قفل فقط', cls: 'gold', onClick: () => doRevoke(id, 'lock') }, { label: 'مسح البيانات', cls: 'red', onClick: () => doRevoke(id, 'wipe') }] });
  }
  async function doRevoke(id, mode) {
    try { await app.sync.revoke(id, mode); toast(mode === 'wipe' ? 'تم الفصل: ستُمسح بياناته عند اتصاله' : 'تم الفصل: سيُقفل عند اتصاله'); }
    catch (e) { toast(syncErrText(e), true, 3500); }
  }

  // permissions of one employee, chosen by the owner
  async function permissions(userId) {
    const rows = (await auth.listPermissions(S)).filter((r) => r.user_id === userId).sort((a, b) => a.sort - b.sort);
    const name = rows[0]?.user_name || '';
    let last = '';
    const html = rows.map((r) => { const g = r.grp !== last ? `<div class="grp">${GROUPS[r.grp] || r.grp}</div>` : ''; last = r.grp;
      return `${g}<label class="sw"><span>${esc(r.label_ar)}</span><input type="checkbox" data-k="${r.key}" ${r.allowed ? 'checked' : ''}></label>`; }).join('');
    openModal({ title: `صلاحيات ${name}`, html, tall: true,
      buttons: [{ label: 'استعادة الافتراضي', onClick: async () => { await auth.resetUserPermissions(S, userId); toast('تمت الاستعادة'); } }, { label: 'إغلاق', cls: 'gold' }],
      onOpen: (m) => m.querySelectorAll('input[type=checkbox]').forEach((cb) => cb.addEventListener('change', async () => {
        try { await auth.setUserPermission(S, userId, cb.dataset.k, cb.checked); }
        catch (e) { toast(errText(e), true); cb.checked = !cb.checked; }
      })) });
  }
  draw();
}

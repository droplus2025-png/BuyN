import { mount, $, toast, errText, openModal } from './ui-core.js';

export function renderLogin(app) {
  mount(`<div class="screen"><div class="center">
    <img src="logo.png" alt="">
    <div class="lbl">كلمة المرور</div>
    <input id="code" class="inp" type="password" autocomplete="off" inputmode="text" style="text-align:center;max-width:300px" autofocus>
    <div class="err" id="err"></div>
    <button class="btn gold big" id="go" style="min-width:200px">دخول</button>
  </div></div>`);
  const submit = async () => {
    try { app.startSession(await app.auth.login($('#code').value)); }
    catch (e) { $('#err').textContent = errText(e); $('#code').select(); }
  };
  $('#go').onclick = submit;
  $('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

export function renderSetup(app) {
  mount(`<div class="screen"><div class="center">
    <img src="logo.png" alt=""><h2 style="margin:0;color:var(--gold)">الإعداد الأول</h2>
    <div class="muted">أنشئ كلمة مرور المالك (4 أحرف على الأقل)</div>
    <input id="name" class="inp" placeholder="اسمك" style="max-width:300px">
    <input id="c1" class="inp" type="password" placeholder="كلمة المرور" style="max-width:300px">
    <input id="c2" class="inp" type="password" placeholder="أعد كلمة المرور" style="max-width:300px">
    <div class="err" id="err"></div>
    <button class="btn gold big" id="go" style="min-width:200px">إنشاء</button>
    <button class="btn" id="join" style="min-width:200px">لدي محل مرتبط — إضافة هذا الجهاز</button>
  </div></div>`);
  // second / third device: download the whole shop with the link code, then log in with the existing code
  $('#join').onclick = () => openModal({
    title: 'ربط هذا الجهاز بمحل', html: `<div class="muted">أدخل رمز ربط المحل (نفسه في كل الأجهزة). يلزم اتصال بالإنترنت لمرة واحدة.</div>
      <input id="lc" class="inp" placeholder="رمز الربط" autocomplete="off" style="direction:ltr;text-align:center"><div class="err" id="err"></div>`,
    buttons: [{ label: 'إلغاء' }, { label: 'ربط', cls: 'gold', onClick: async (close, m) => {
      const btn = m.querySelector('.mbtns .gold'); btn.disabled = true; btn.textContent = 'جارٍ التحميل…';
      try {
        await app.sync.linkNew(m.querySelector('#lc').value.trim());
        if (!(await app.auth.hasOwner())) throw Object.assign(new Error('NO_OWNER'), { kind: 'server' });
        toast('تم تحميل بيانات المحل'); app.go('login');
      } catch (e) {
        app.sync.unlink();
        m.querySelector('#err').textContent = e.kind === 'badcode' ? 'رمز الربط غير صحيح' : e.message === 'SERVER_EMPTY' ? 'المحل فارغ في السحابة: أنشئ الإعداد الأول من الجهاز الرئيسي ثم اربطه أولاً' : e.kind === 'network' ? 'لا يوجد اتصال بالإنترنت' : errText(e);
        btn.disabled = false; btn.textContent = 'ربط'; return false;
      }
    } }], onOpen: (m) => m.querySelector('#lc').focus() });
  $('#go').onclick = async () => {
    if ($('#c1').value !== $('#c2').value) { $('#err').textContent = 'كلمتا المرور غير متطابقتين'; return; }
    try { await app.startSession(await app.auth.setupOwner({ name: $('#name').value.trim() || 'المالك', code: $('#c1').value })); toast('مرحباً'); }
    catch (e) { $('#err').textContent = errText(e); }
  };
}

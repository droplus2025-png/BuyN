import { mount, $, toast, errText, openModal, syncErrText, deviceName } from './ui-core.js';

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

// first launch on a NEW device: a shop on this device, join the shop of a main device, or take the place of a lost main device
export function renderSetup(app) {
  mount(`<div class="screen"><div class="center">
    <img src="logo.png" alt=""><h2 style="margin:0;color:var(--gold)">الإعداد الأول</h2>
    <button class="btn gold big" id="local" style="min-width:260px">محل جديد على هذا الجهاز</button>
    <button class="btn big" id="join" style="min-width:260px">ربط بالجهاز الرئيسي (رمز ربط)</button>
    <button class="btn" id="recover" style="min-width:260px">استرجاع المحل (الجهاز الرئيسي ضاع)</button>
    <div class="err" id="err"></div>
  </div></div>`);
  $('#local').onclick = async () => { try { await app.startLocal(); } catch (e) { $('#err').textContent = errText(e); } };
  const ask = (title, html, run) => openModal({ title, html: `${html}<div class="err" id="merr"></div>`,
    buttons: [{ label: 'إلغاء' }, { label: 'متابعة', cls: 'gold', onClick: async (close, m) => {
      const btn = m.querySelector('.mbtns .gold'); btn.disabled = true; btn.textContent = 'جارٍ التحميل…';
      try { await run(m); toast('تم تحميل بيانات المحل'); }
      catch (e) { m.querySelector('#merr').textContent = syncErrText(e); btn.disabled = false; btn.textContent = 'متابعة'; return false; }
    } }], onOpen: (m) => m.querySelector('input').focus() });
  const nm = (m) => (m.querySelector('#dn').value.trim() || deviceName());
  const dn = `<div class="lbl">اسم هذا الجهاز</div><input id="dn" class="inp" value="${deviceName()}" autocomplete="off">`;
  $('#join').onclick = () => ask('ربط بالجهاز الرئيسي',
    `<div class="muted">اطلب من الجهاز الرئيسي «رمز ربط جهاز جديد» (من الإدارة). يلزم اتصال بالإنترنت.</div><input id="lc" class="inp" inputmode="numeric" placeholder="رمز الربط (8 أرقام)" autocomplete="off" style="direction:ltr;text-align:center">${dn}`,
    async (m) => { await app.sync.join(m.querySelector('#lc').value.trim(), nm(m)); await app.openDownloaded(); });
  $('#recover').onclick = () => ask('استرجاع المحل',
    `<div class="muted">يصبح هذا الجهاز هو الرئيسي ويُمسح الجهاز الرئيسي القديم. تحتاج مفتاح الإعداد السري ومعرّف المحل (موجود في جدول shops في Supabase).</div>
      <input id="sk" class="inp" type="password" placeholder="مفتاح الإعداد" autocomplete="off" style="direction:ltr"><input id="sh" class="inp" placeholder="معرّف المحل" autocomplete="off" style="direction:ltr">${dn}`,
    async (m) => { await app.sync.recover(m.querySelector('#sk').value, m.querySelector('#sh').value.trim(), nm(m)); await app.openDownloaded(); });
}

// this device was disconnected from the shop by the main device
export function renderLocked(app, { mode }) {
  document.body.classList.remove('pcmode'); document.getElementById('app').innerHTML = '';
  const wipe = mode === 'wipe';
  mount(`<div class="screen"><div class="center">
    <img src="logo.png" alt=""><h2 style="margin:0;color:var(--gold)">تم فصل هذا الجهاز عن المحل</h2>
    <div class="muted" style="text-align:center">${wipe ? 'مُسحت بيانات المحل من هذا الجهاز.' : 'البرنامج مقفل على هذا الجهاز وبياناته محفوظة. لاستعماله من جديد اطلب من الجهاز الرئيسي رمز ربط.'}</div>
    ${wipe ? '' : `<input id="lc" class="inp" inputmode="numeric" placeholder="رمز الربط (8 أرقام)" autocomplete="off" style="max-width:300px;direction:ltr;text-align:center"><div class="err" id="err"></div>`}
    <button class="btn gold big" id="go" style="min-width:220px">${wipe ? 'البدء من جديد' : 'ربط الجهاز'}</button>
  </div></div>`);
  $('#go').onclick = async () => {
    if (wipe) return location.reload();
    $('#go').disabled = true;
    try { await app.sync.join($('#lc').value.trim(), deviceName()); localStorage.removeItem('buyn_locked'); location.reload(); }
    catch (e) { $('#err').textContent = syncErrText(e); $('#go').disabled = false; }
  };
}

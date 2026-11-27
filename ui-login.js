import { mount, $, esc, toast, errText, openModal, syncErrText, deviceName } from './ui-core.js';

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

// ACTIVATION: the program works only with a phone number registered by its provider + the activation code he gave.
// The first device of a shop becomes the main one. Other devices join it with a link code from the main device.
export function renderSetup(app) {
  mount(`<div class="screen"><div class="center">
    <img src="logo.png" alt=""><h2 style="margin:0;color:var(--gold)">تفعيل البرنامج</h2>
    <div class="muted" style="text-align:center;max-width:340px">أدخل رقم الهاتف ورمز التفعيل اللذين حصلت عليهما من المزوّد. يلزم الإنترنت لمرة واحدة.</div>
    <input id="ph" class="inp" inputmode="tel" placeholder="رقم الهاتف" autocomplete="off" style="max-width:300px;direction:ltr;text-align:center">
    <input id="ac" class="inp" type="password" placeholder="رمز التفعيل" autocomplete="off" style="max-width:300px;direction:ltr;text-align:center">
    <input id="dn" class="inp" value="${esc(deviceName())}" placeholder="اسم هذا الجهاز" autocomplete="off" style="max-width:300px;text-align:center">
    <div class="err" id="err"></div>
    <button class="btn gold big" id="go" style="min-width:260px">تفعيل</button>
    <button class="btn" id="join" style="min-width:260px">لدي رمز ربط من الجهاز الرئيسي</button>
  </div></div>`);
  const go = async () => {
    $('#err').textContent = ''; $('#go').disabled = true; $('#go').textContent = 'جارٍ التفعيل…';
    try { await app.sync.activate($('#ph').value, $('#ac').value, $('#dn').value.trim() || deviceName()); await app.enter(); }
    catch (e) { $('#err').textContent = syncErrText(e); $('#go').disabled = false; $('#go').textContent = 'تفعيل'; }
  };
  $('#go').onclick = go;
  $('#ac').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  $('#join').onclick = () => openModal({
    title: 'ربط بالجهاز الرئيسي',
    html: `<div class="muted">اطلب من الجهاز الرئيسي «رمز ربط جهاز جديد» (من الإدارة). يلزم اتصال بالإنترنت.</div>
      <input id="lc" class="inp" inputmode="numeric" placeholder="رمز الربط (8 أرقام)" autocomplete="off" style="direction:ltr;text-align:center">
      <div class="lbl">اسم هذا الجهاز</div><input id="jn" class="inp" value="${esc(deviceName())}" autocomplete="off"><div class="err" id="merr"></div>`,
    buttons: [{ label: 'إلغاء' }, { label: 'ربط', cls: 'gold', onClick: async (close, m) => {
      const btn = m.querySelector('.mbtns .gold'); btn.disabled = true; btn.textContent = 'جارٍ التحميل…';
      try { await app.sync.join(m.querySelector('#lc').value.trim(), m.querySelector('#jn').value.trim() || deviceName()); await app.enterJoined(); toast('تم تحميل بيانات المحل'); }
      catch (e) { m.querySelector('#merr').textContent = syncErrText(e); btn.disabled = false; btn.textContent = 'ربط'; return false; }
    } }], onOpen: (m) => m.querySelector('#lc').focus() });
}

// this device is locked: disconnected by the main device (lock / wipe), or its license is suspended / ended / not renewed
const LICENSE_MSG = { suspended: 'الترخيص موقوف. تواصل مع المزوّد. بيانات المحل محفوظة وتعود فور تجديد الترخيص.',
  expired: 'انتهى الترخيص. تواصل مع المزوّد. بيانات المحل محفوظة وتعود فور تجديد الترخيص.',
  lease: 'يلزم الاتصال بالإنترنت لتجديد التفعيل. بيانات المحل محفوظة، وسيفتح البرنامج تلقائياً عند الاتصال.' };
export function renderLocked(app, { mode, kind }) {
  document.body.classList.remove('pcmode'); document.getElementById('app').innerHTML = '';
  const wipe = mode === 'wipe', lic = mode === 'license';
  mount(`<div class="screen"><div class="center">
    <img src="logo.png" alt=""><h2 style="margin:0;color:var(--gold)">${lic ? 'البرنامج مقفل' : 'تم فصل هذا الجهاز عن المحل'}</h2>
    <div class="muted" style="text-align:center;max-width:340px">${lic ? LICENSE_MSG[kind] || LICENSE_MSG.suspended : wipe ? 'مُسحت بيانات المحل من هذا الجهاز.' : 'البرنامج مقفل على هذا الجهاز وبياناته محفوظة. لاستعماله من جديد اطلب من الجهاز الرئيسي رمز ربط.'}</div>
    ${wipe || lic ? '' : `<input id="lc" class="inp" inputmode="numeric" placeholder="رمز الربط (8 أرقام)" autocomplete="off" style="max-width:300px;direction:ltr;text-align:center">`}
    <div class="err" id="err"></div>
    <button class="btn gold big" id="go" style="min-width:220px">${lic ? 'إعادة المحاولة' : wipe ? 'البدء من جديد' : 'ربط الجهاز'}</button>
  </div></div>`);
  $('#go').onclick = async () => {
    if (wipe) return location.reload();
    $('#go').disabled = true;
    try {
      if (lic) { await app.sync.syncNow(); $('#err').textContent = app.sync.status.state === 'idle' ? '' : (app.sync.status.state === 'offline' ? syncErrText({ kind: 'network' }) : 'لم يُجدَّد الترخيص بعد'); }
      else { await app.sync.join($('#lc').value.trim(), deviceName()); localStorage.removeItem('buyn_locked'); location.reload(); }
    } catch (e) { $('#err').textContent = syncErrText(e); }
    $('#go').disabled = false;
  };
}

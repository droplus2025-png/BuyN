// Keyboard-proof layout. The soft keyboard must never hide what the employee is typing in.
//  --vvh / --vvt : height / top offset of the VISIBLE area (visualViewport) -> #app and the modals follow it
//  body.kb       : a text field is focused and the keyboard is open -> screens switch to a compact layout
// Also: numeric fields select their content on focus (the typed value replaces the suggested one),
// and a focused field is always scrolled into view.
const root = document.documentElement;
const vv = window.visualViewport;
let base = Math.max(window.innerHeight, vv ? vv.height : 0);
const isText = (el) => !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'file', 'submit'].includes(el.type)));

function sync() {
  const h = vv ? vv.height : window.innerHeight;
  const focused = isText(document.activeElement);
  if (!focused) base = Math.max(h, window.innerHeight);           // no keyboard: this is the full height
  root.style.setProperty('--vvh', `${Math.round(h)}px`);
  root.style.setProperty('--vvt', `${Math.round(vv ? vv.offsetTop : 0)}px`);
  document.body.classList.toggle('kb', focused && h < base - 120 && window.innerWidth < 900);
}
function reveal(el) { if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }

if (vv) { vv.addEventListener('resize', sync); vv.addEventListener('scroll', sync); }
window.addEventListener('resize', sync);
window.addEventListener('orientationchange', () => { base = 0; setTimeout(sync, 300); });
document.addEventListener('focusin', (e) => {
  const el = e.target;
  if (!isText(el)) return;
  if (['decimal', 'numeric', 'tel'].includes(el.inputMode)) setTimeout(() => { try { el.select(); } catch { /* ignore */ } }, 0);
  sync();
  setTimeout(() => { sync(); reveal(el); }, 120);
  setTimeout(() => reveal(el), 350);                               // after the keyboard animation
});
document.addEventListener('focusout', () => setTimeout(sync, 80));
sync();

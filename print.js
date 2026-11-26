// Print an invoice (the same text sent on WhatsApp) through the system print window.
// Page = 80 mm wide receipt paper; with "Save as PDF" it can be tried without any printer.
// printHtml is pure (unit-tested); printText only needs a browser.
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// one block per line, direction chosen per line (Arabic right-to-left, Latin left-to-right); *text* is printed in bold
export function printHtml(text) {
  const rows = String(text).split('\n').map((ln) => `<div dir="auto">${escHtml(ln).replace(/\*([^*]+)\*/g, '<b>$1</b>') || '&nbsp;'}</div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>buyN</title><style>
@page{size:80mm auto;margin:3mm}
html,body{margin:0;background:#fff;color:#000}
body{width:72mm;font:11pt/1.5 "Noto Naskh Arabic","Tajawal","Dubai","Segoe UI",Tahoma,sans-serif;white-space:pre-wrap;word-break:break-word}
</style></head><body>${rows}</body></html>`;
}

export function printText(text) {
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(f);
  const d = f.contentDocument;
  d.open(); d.write(printHtml(text)); d.close();
  const clean = () => setTimeout(() => f.remove(), 500);
  f.contentWindow.addEventListener('afterprint', clean);
  setTimeout(() => { f.contentWindow.focus(); f.contentWindow.print(); setTimeout(clean, 120000); }, 200);   // short wait so the fonts are ready
}

// Smart product entry, shared by "add product" (stock) and the new-product part of a purchase.
// Goal: fewest taps. The program suggests the last category used, the smallest free number of that category,
// a sale price from the last margin of the category and a quantity of 1; every suggestion is selected,
// so the first key pressed replaces it. A product that already exists is never created twice: the quantity is added.
import { esc, toast, openModal, errText, price4 } from './ui-core.js';
import { catOf } from './products.js';

const ls = {
  get: (k, d = '') => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: suggestions just restart */ } },
};
const num = (t) => Number(String(t ?? '').replace(',', '.'));
export const CODE_OK = /^[0-9][1-9][0-9]*$/;
export const lastCat = () => { const c = ls.get('buyn_last_cat', '0'); return /^[0-9]$/.test(c) ? c : '0'; };
export const rememberCat = (c) => ls.set('buyn_last_cat', String(c));
export const suggestSale = (cat, purchase) => { const m = num(ls.get(`buyn_margin_${cat}`)), p = num(purchase); return m > 1 && p > 0 ? String(Math.round(p * m * 100) / 100) : ''; };
export const rememberMargin = (cat, purchase, sale) => { const p = num(purchase), s = num(sale); if (p > 0 && s > p) ls.set(`buyn_margin_${cat}`, String(s / p)); };

// category digits 0-9 (the chosen one is green) + "category : name" + "number : code"
export const codeBoxHtml = () => `<div class="codebox"><div class="catrow" dir="ltr">${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => `<button type="button" data-d="${d}">${d}</button>`).join('')}</div>
  <div class="pf-two"><div>الصنف : <b class="cn"></b></div><div class="pf-code">الرقم : <input class="inp code" inputmode="numeric" maxlength="8" dir="ltr" autocomplete="off"></div></div></div>`;

export function codePicker(app, root, { taken = () => [] } = {}) {
  const code = root.querySelector('.code'), cn = root.querySelector('.cn'), st = { cat: lastCat(), locked: false };
  const paint = () => {
    root.querySelectorAll('.catrow button').forEach((b) => b.classList.toggle('on', b.dataset.d === st.cat));
    cn.textContent = (app.cfg.categories || {})[st.cat] || 'بدون اسم';
  };
  async function setCat(c) { st.cat = String(c); paint(); code.value = await app.engine.products.nextCode(st.cat, taken()); }   // smallest free number
  root.querySelectorAll('.catrow button').forEach((b) => b.addEventListener('click', () => { if (!st.locked) setCat(b.dataset.d); }));
  code.addEventListener('input', () => { if (/^[0-9]/.test(code.value)) { st.cat = code.value[0]; paint(); } });   // typing a code moves the category
  code.addEventListener('focus', () => code.select());
  return {
    get cat() { return st.cat; }, get code() { return code.value.trim(); }, setCat,
    lock(sku) { st.locked = true; st.cat = catOf(sku); code.value = sku; code.disabled = true; root.classList.add('locked'); paint(); },
    unlock() { st.locked = false; code.disabled = false; root.classList.remove('locked'); return setCat(st.cat); },
  };
}

export function openProductForm(app, { onDone } = {}) {
  const eng = app.engine;
  let dup = null, pvAuto = true, cp, t;
  const useExisting = (m, p, focusQty) => {
    dup = p; cp.lock(p.sku);
    m.querySelector('#pa').value = price4(p.purchase_price); m.querySelector('#pv').value = price4(p.sale_price);
    m.querySelector('#pa').disabled = m.querySelector('#pv').disabled = true;
    m.querySelector('#dupe').textContent = `⚠ هذا المنتج موجود (كود ${p.sku}) — ستُضاف الكمية إلى مخزونه`; m.querySelector('#sg').innerHTML = '';
    if (focusQty) m.querySelector('#qt').focus();
  };
  async function onName(m) {
    const nm = m.querySelector('#nm'), v = nm.value.trim(), hit = v ? await eng.products.byName(v) : null;
    if (hit) useExisting(m, hit);
    else if (dup) { dup = null; m.querySelector('#dupe').textContent = ''; m.querySelector('#pa').disabled = m.querySelector('#pv').disabled = false; m.querySelector('#pa').value = ''; m.querySelector('#pv').value = ''; pvAuto = true; await cp.unlock(); }
    const list = v && !hit ? await eng.products.search(v, 5) : [];                      // remembered products that match what is typed
    m.querySelector('#sg').innerHTML = list.length ? `<div class="results">${list.map((p) => `<button type="button" class="res" data-id="${p.id}"><span class="sku">${p.sku}</span><span>${esc(p.name)}</span><span class="muted">${price4(p.purchase_price)} / ${price4(p.sale_price)}</span></button>`).join('')}</div>` : '';
    m.querySelectorAll('#sg .res').forEach((b) => b.addEventListener('click', () => { const p = list.find((x) => x.id === b.dataset.id); nm.value = p.name; useExisting(m, p, true); }));
  }
  async function save(m) {
    const q = (s) => m.querySelector(s), err = q('#err'), name = q('#nm').value.trim(), qty = q('#qt').value || '0';
    err.textContent = '';
    try {
      if (dup) { await eng.products.adjustStock(dup.id, qty); toast(`أُضيفت الكمية إلى ${dup.name} · كود ${dup.sku}`); onDone?.(); return undefined; }
      if (!CODE_OK.test(cp.code)) throw Object.assign(new Error(), { code: 'BAD_SKU' });
      const p = await eng.products.create({ name, sku: cp.code, purchasePrice: q('#pa').value || '0', salePrice: q('#pv').value || '0', qty });
      rememberCat(catOf(p.sku)); rememberMargin(catOf(p.sku), q('#pa').value, q('#pv').value);
      toast(`تمت الإضافة · كود ${p.sku}`); onDone?.(); return undefined;
    } catch (e) {
      if (e.code === 'PRODUCT_EXISTS') { const p = await eng.products.byName(name); if (p) { useExisting(m, p); err.textContent = 'هذا المنتج موجود — اضغط حفظ لإضافة الكمية'; return false; } }
      err.textContent = e.code === 'BAD_SKU' ? 'الرقم: خانة الصنف ثم رقم المنتج (مثل 823)' : errText(e);
      return false;
    }
  }
  openModal({
    title: 'إضافة منتج',
    html: `${codeBoxHtml()}<input id="nm" class="inp" placeholder="اسم المنتج" autocomplete="off"><div id="sg"></div><div id="dupe" class="dupe"></div>
      <div class="pf-two"><input id="pa" class="inp" inputmode="decimal" placeholder="سعر الشراء"><input id="pv" class="inp" inputmode="decimal" placeholder="سعر البيع"></div>
      <input id="qt" class="inp" inputmode="decimal" placeholder="الكمية" value="1"><div class="err" id="err"></div>`,
    buttons: [{ label: 'حفظ', cls: 'gold', onClick: (close, m) => save(m) }, { label: 'إلغاء' }],
    onOpen: (m) => {
      cp = codePicker(app, m.querySelector('.codebox')); cp.setCat(lastCat());
      m.querySelectorAll('input').forEach((i) => i.addEventListener('focus', () => i.select()));       // the first key replaces the suggestion
      m.querySelector('#nm').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => onName(m), 120); });
      m.querySelector('#pa').addEventListener('input', () => { if (!dup && pvAuto) m.querySelector('#pv').value = suggestSale(cp.cat, m.querySelector('#pa').value); });
      m.querySelector('#pv').addEventListener('input', () => { pvAuto = !m.querySelector('#pv').value; });
      m.querySelector('#nm').focus();
    },
  });
}

// Stock screen: products grouped by category, LTR table (code | product | purchase | sale | quantity).
// The owner taps a row to edit quantity, prices, number and name. A row with 0 in number / purchase / sale / quantity is RED.
import { catOf, parsePasteRows } from './products.js';
import { openProductForm } from './ui-productform.js';
import { mount, $, esc, header, toast, errText, openModal, confirmBox, price4, qtyStr, priceShort, download, setNext } from './ui-core.js';

export async function renderStock(app) {
  const eng = app.engine, can = app.session.permissions;
  const editable = can.manage_stock || can.edit_purchase_price || can.edit_sale_price;
  mount(`<div class="screen">${header('المنتجات')}<div class="body">
    <input id="q" class="inp" placeholder="🔍 بحث: اسم المنتج أو رقمه" autocomplete="off">
    <div class="row">
      ${can.add_product ? '<button class="btn gold" id="add" style="flex:1">+ إضافة</button>' : ''}
      ${can.manage_stock ? '<button class="btn" id="paste" style="flex:1">لصق من Excel</button><button class="btn" id="csv" style="flex:1">⬇ تصدير CSV</button><button class="btn" id="trash" style="flex:1">المحذوفة</button>' : ''}
    </div>
    <div class="muted" id="count"></div>
    <div id="list" style="overflow:auto;flex:1;min-height:0"></div></div></div>`);
  $('#hdrBack').onclick = () => app.go('home');

  const isBad = (p) => !p.sku || !p.purchase_price || !p.sale_price || !p.qty || p.qty < 0;      // 0 in any of the four cells (or negative stock)
  // ---- products grouped by category (first digit of the code); a group can be folded; table is left-to-right
  const catName = (d) => (app.cfg.categories || {})[d] || '';
  const folded = (app.stockFolded ||= new Set());
  async function load() {
    const rows = await eng.products.search($('#q').value.trim(), 1500);
    const bad = rows.filter(isBad).length;
    $('#count').innerHTML = `${rows.length} منتج${rows.length === 1500 ? ' (أول 1500)' : ''}${bad ? ` · <span style="color:var(--red)">${bad} سطر بقيمة صفر</span>` : ''}${editable ? ' · المس سطراً لتعديله' : ''}`;
    const groups = new Map(); rows.forEach((p) => { const d = catOf(p.sku); if (!groups.has(d)) groups.set(d, []); groups.get(d).push(p); });
    const head = `<div class="trow h" style="direction:ltr"><div>الكود</div><div>المنتج</div><div class="num">شراء</div><div class="num">بيع</div><div class="num">الكمية</div></div>`;
    const line = (p) => `<div class="trow ${isBad(p) ? 'bad' : ''}" data-id="${p.id}" style="direction:ltr;${editable ? 'cursor:pointer' : ''}">
        <div class="c0" style="font-weight:800">${p.sku}</div><div class="n" dir="auto">${esc(p.name)}</div>
        <div class="num ${!p.purchase_price ? 'z' : ''}">${priceShort(p.purchase_price)}</div><div class="num ${!p.sale_price ? 'z' : ''}">${priceShort(p.sale_price)}</div>
        <div class="num ${p.qty <= 0 ? 'z' : ''}">${qtyStr(p.qty) || 0}</div></div>`;
    $('#list').innerHTML = [...groups].map(([d, ps]) => {
      const nb = ps.filter(isBad).length, open = !folded.has(d);
      return `<div class="cat-h" data-d="${d}" style="direction:ltr"><span>${open ? '▾' : '▸'}</span><b>${d}</b><span class="cn">${esc(catName(d) || 'بدون اسم')}</span><span class="cc">${ps.length}${nb ? ` · <i style="color:var(--red)">${nb}</i>` : ''}</span></div>${open ? head + ps.map(line).join('') : ''}`;
    }).join('') || '<div class="muted">لا منتجات بعد</div>';
    document.querySelectorAll('#list .cat-h').forEach((h) => h.addEventListener('click', () => { const d = h.dataset.d; folded.has(d) ? folded.delete(d) : folded.add(d); load(); }));
    if (editable) document.querySelectorAll('#list .trow:not(.h)').forEach((r) => r.addEventListener('click', () => edit(rows.find((p) => p.id === r.dataset.id))));
    nextStep(rows, bad);
  }
  // ---- the program points to the next step (notice in the top bar + pulsing target)
  function nextStep(rows, bad) {
    const searching = !!$('#q').value.trim();
    let text = 'المس سطراً لتعديله', target = null;
    if (!rows.length && !searching) { text = 'ابدأ بإضافة أول منتج'; target = '#add'; }
    else if (!rows.length) text = 'لا نتيجة لهذا البحث';
    else if (bad) { text = `${bad} أسطر بقيمة صفر — أكمل الأسعار والكمية`; target = '#list .trow.bad'; }
    setNext(text, target);
  }
  let t; $('#q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 120); });

  // ---- edit one product (owner): name, number, prices, quantity. Every change is journaled.
  function edit(p) {
    openModal({
      title: `تعديل المنتج · ${p.sku}`, tall: true,
      html: `<div class="lbl">اسم المنتج</div><input id="n" class="inp" value="${esc(p.name)}">
        <div class="row"><div style="flex:1"><div class="lbl">الكود (الصنف + رقم المنتج)</div><input id="s" class="inp" inputmode="numeric" value="${p.sku}" ${can.manage_stock ? '' : 'disabled'}></div>
          <div style="flex:1"><div class="lbl">الكمية</div><input id="q" class="inp" inputmode="decimal" value="${qtyStr(p.qty) || 0}" ${can.manage_stock ? '' : 'disabled'}></div></div>
        <div class="row"><div style="flex:1"><div class="lbl">سعر الشراء</div><input id="pa" class="inp" inputmode="decimal" value="${price4(p.purchase_price) || 0}" ${can.edit_purchase_price ? '' : 'disabled'}></div>
          <div style="flex:1"><div class="lbl">سعر البيع</div><input id="pv" class="inp" inputmode="decimal" value="${price4(p.sale_price) || 0}" ${can.edit_sale_price ? '' : 'disabled'}></div></div>
        <div class="err" id="err"></div>`,
      buttons: [{ label: 'إلغاء' },
        ...(can.manage_stock ? [{ label: 'حذف', cls: 'red', onClick: async (close, m) => {
          if (!(await confirmBox('حذف المنتج', `حذف «${p.name}»؟ يبقى رقمه محجوزاً ولا يُعطى لمنتج آخر، ويمكنك استرجاعه في أي وقت من زر «المحذوفة».`, 'حذف', 'إلغاء'))) return false;
          try { await eng.products.remove(p.id); toast('تم الحذف'); load(); } catch (e) { m.querySelector('#err').textContent = errText(e); return false; }
        } }] : []),
        { label: 'حفظ', cls: 'gold', onClick: async (close, m) => {
          const v = (id) => m.querySelector(id).value.trim();
          try {
            const patch = {};
            if (v('#n') !== p.name) patch.name = v('#n');
            if (can.manage_stock && v('#s') !== p.sku) patch.sku = v('#s');
            if (can.edit_purchase_price && v('#pa') !== (price4(p.purchase_price) || '0')) patch.purchasePrice = v('#pa');
            if (can.edit_sale_price && v('#pv') !== (price4(p.sale_price) || '0')) patch.salePrice = v('#pv');
            if (Object.keys(patch).length) await eng.products.update(p.id, patch);
            if (can.manage_stock && v('#q') !== (qtyStr(p.qty) || '0')) await eng.products.setQty(p.id, v('#q'));
            toast('تم الحفظ'); load();
          } catch (e) { m.querySelector('#err').textContent = errText(e) + (e.details?.sku ? ` (رقم ${e.details.sku})` : ''); return false; }
        } }],
      onOpen: (m) => m.querySelectorAll('input').forEach((i) => i.addEventListener('focus', () => i.select())),
    });
  }

  $('#add')?.addEventListener('click', () => openProductForm(app, { onDone: load }));

  // ---- paste from Excel: the category MUST be chosen first (it gives the numbers of the lines that come without a code)
  $('#paste')?.addEventListener('click', () => openModal({
    title: 'لصق من Excel', tall: true,
    html: `<div class="lbl">1 · اختر الصنف (إلزامي)</div>
      <div class="catrow" dir="ltr" id="pcat">${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => `<button type="button" data-d="${d}">${d}</button>`).join('')}</div>
      <div class="muted" id="pcn" style="margin-bottom:.4rem">لم يُختر صنف بعد</div>
      <div class="lbl">2 · الصق القائمة</div>
      <div class="muted" style="font-size:.85rem">الأعمدة بالترتيب: الرقم ← المنتج ← سعر الشراء ← سعر البيع ← الكمية. الفاصل: Tab (من Excel) أو ;<br><b>عمود الأسماء وحده مقبول</b>: كل سطر باسم فقط يُضاف في الصنف المختار بكمية وأسعار 0. السطر الذي يبدأ برقم منتج يأخذ صنف رقمه.<br>الأسطر الفارغة تُتجاهل، والمكرر يبقى مرة واحدة.</div>
      <label style="display:flex;gap:.5rem;align-items:center;margin:.5rem 0"><input type="checkbox" id="names"> أسماء فقط (أول عمود = الاسم، والباقي يُهمل، والكمية والأسعار 0)</label>
      <textarea id="ta" class="inp" rows="7" dir="auto" placeholder="Marteau&#10;Vis 6mm&#10;Clou"></textarea><div class="err" id="err"></div>`,
    buttons: [{ label: 'إلغاء' }, { label: 'استيراد', cls: 'gold', onClick: async (close, m) => {
      const cat = m.dataset.cat;
      if (cat === undefined) { m.querySelector('#err').textContent = 'اختر الصنف أولاً'; return false; }
      const rows = parsePasteRows(m.querySelector('#ta').value, { namesOnly: m.querySelector('#names').checked }).map((r) => (r.sku ? r : { ...r, cat }));
      if (!rows.length) { m.querySelector('#err').textContent = 'الصق القائمة أولاً'; return false; }
      try { const r = await eng.products.import(rows); toast(`أُضيف ${r.created} · تُجوهل ${r.skipped.length}`, false, 3500); load(); }
      catch (e) { m.querySelector('#err').textContent = errText(e); return false; }
    } }],
    onOpen: (m) => {
      m.querySelectorAll('#pcat button').forEach((b) => b.addEventListener('click', () => {
        m.dataset.cat = b.dataset.d;
        m.querySelectorAll('#pcat button').forEach((x) => x.classList.toggle('on', x === b));
        m.querySelector('#pcn').innerHTML = `الصنف <b>${b.dataset.d}</b> · ${esc(catName(b.dataset.d) || 'بدون اسم')}`;
        m.querySelector('#err').textContent = '';
      }));
    },
  }));

  // ---- deleted products: never final, every one can come back (its number was never given to another product)
  $('#trash')?.addEventListener('click', async () => {
    let gone; try { gone = await eng.products.listDeleted(); } catch (e) { toast(errText(e), true); return; }
    const row = (p) => `<div class="trow" style="direction:ltr;display:grid;grid-template-columns:3.2rem 1fr 4rem auto;gap:6px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line)">
      <b>${esc(p.sku)}</b><span>${esc(p.name)}</span><span class="muted">${qtyStr(p.qty) || 0}</span><button class="btn" data-id="${p.id}">استرجاع</button></div>`;
    const m = openModal({ title: `المنتجات المحذوفة (${gone.length})`, tall: true,
      html: gone.length ? `<div id="gl" style="overflow:auto;max-height:55vh">${gone.map(row).join('')}</div><div class="err" id="err"></div>` : '<div class="muted">لا توجد منتجات محذوفة</div>',
      buttons: [{ label: 'إغلاق' }, ...(gone.length ? [{ label: 'استرجاع الكل', cls: 'gold', onClick: async (close, mm) => {
        try { const r = await eng.products.restoreAll(); toast(`أُرجع ${r.restored}${r.skipped.length ? ` · ${r.skipped.length} اسمها مستعمل الآن` : ''}`, false, 3500); load(); }
        catch (e) { mm.querySelector('#err').textContent = errText(e); return false; }
      } }] : [])],
    });
    m.el.querySelectorAll('#gl button[data-id]').forEach((b) => b.addEventListener('click', async () => {
      try { await eng.products.restore(b.dataset.id); b.closest('.trow').remove(); toast('تم الاسترجاع'); load(); }
      catch (e) { m.el.querySelector('#err').textContent = errText(e); }
    }));
  });

  // ---- CSV for Excel (UTF-8 with BOM so Arabic names display correctly)
  $('#csv')?.addEventListener('click', async () => {
    try {
      const csv = await eng.products.exportCsv();
      download(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }), `stock-${new Date().toISOString().slice(0, 10)}.csv`);
      toast('تم تصدير المخزون');
    } catch (e) { toast(errText(e), true); }
  });
  load();
}

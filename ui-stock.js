// Stock screen: products grouped by category, LTR table (code | product | purchase | sale | quantity).
// The owner taps a row to edit quantity, prices, number and name. A row with 0 in number / purchase / sale / quantity is RED.
import { catOf } from './products.js';
import { mount, $, esc, header, toast, errText, openModal, confirmBox, price4, qtyStr, priceShort } from './ui-core.js';

export async function renderStock(app) {
  const eng = app.engine, can = app.session.permissions;
  const editable = can.manage_stock || can.edit_purchase_price || can.edit_sale_price;
  mount(`<div class="screen">${header('المنتجات')}<div class="body">
    <input id="q" class="inp" placeholder="🔍 بحث: اسم المنتج أو رقمه" autocomplete="off">
    <div class="row">
      ${can.add_product ? '<button class="btn gold" id="add" style="flex:1">+ إضافة</button>' : ''}
      ${can.manage_stock ? '<button class="btn" id="paste" style="flex:1">لصق من Excel</button><button class="btn" id="csv" style="flex:1">⬇ تصدير CSV</button>' : ''}
    </div>
    <div class="muted" id="count"></div>
    <div id="list" style="overflow:auto;flex:1;min-height:0"></div></div></div>`);
  $('#hdrBack').onclick = () => app.go('home');

  const isBad = (p) => !p.sku || !p.purchase_price || !p.sale_price || !p.qty || p.qty < 0;      // 0 in any of the four cells (or negative stock)
  // ---- products grouped by category (first digit of the code); a group can be folded; table is left-to-right
  const catName = (d) => (app.cfg.categories || {})[d] || '';
  const catOpts = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => `<option value="${d}">${d}${catName(d) ? ` · ${esc(catName(d))}` : ''}</option>`).join('');
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
    document.querySelectorAll('.next').forEach((x) => x.classList.remove('next'));
    const searching = !!$('#q').value.trim();
    let text = 'المس سطراً لتعديله', target = null;
    if (!rows.length && !searching) { text = 'ابدأ بإضافة أول منتج'; target = '#add'; }
    else if (!rows.length) text = 'لا نتيجة لهذا البحث';
    else if (bad) { text = `${bad} أسطر بقيمة صفر — أكمل الأسعار والكمية`; target = '#list .trow.bad'; }
    const note = $('#note'); if (note) note.textContent = text;
    const el = target && document.querySelector(target); if (el) el.classList.add('next');
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
          if (!(await confirmBox('حذف المنتج', `حذف «${p.name}»؟ يبقى رقمه محجوزاً ولا يُعطى لمنتج آخر.`, 'حذف', 'إلغاء'))) return false;
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

  $('#add')?.addEventListener('click', () => openModal({
    title: 'إضافة منتج',
    html: `<input id="n" class="inp" placeholder="اسم المنتج"><div class="lbl">الصنف (أول رقم في كود المنتج)</div><select id="ct" class="inp">${catOpts}</select><div class="row"><input id="pa" class="inp" inputmode="decimal" placeholder="سعر الشراء">
      <input id="pv" class="inp" inputmode="decimal" placeholder="سعر البيع"></div>
      ${can.manage_stock ? '<input id="qt" class="inp" inputmode="decimal" placeholder="الكمية الأولية (اختياري)">' : ''}<div class="err" id="err"></div>`,
    buttons: [{ label: 'إلغاء' }, { label: 'حفظ', cls: 'gold', onClick: async (close, m) => {
      try {
        const p = await eng.products.create({ name: m.querySelector('#n').value, purchasePrice: m.querySelector('#pa').value || '0',
          salePrice: m.querySelector('#pv').value || '0', qty: m.querySelector('#qt')?.value || '0', cat: m.querySelector('#ct').value });
        toast(`تمت الإضافة · كود ${p.sku}`); load();
      } catch (e) { m.querySelector('#err').textContent = errText(e) + (e.details?.sku ? ` (رقم ${e.details.sku})` : ''); return false; }
    } }],
    onOpen: (m) => m.querySelector('#n').focus(),
  }));

  $('#paste')?.addEventListener('click', () => openModal({
    title: 'لصق من Excel', tall: true,
    html: `<div class="muted" style="font-size:.85rem">الأعمدة بالترتيب: الرقم ← المنتج ← سعر الشراء ← سعر البيع ← الكمية. الفاصل: Tab (من Excel) أو ;<br>الأسطر الفارغة تُتجاهل، والمكرر يبقى مرة واحدة. (ملف التصدير يُعاد استيراده كما هو.)</div>
      <textarea id="ta" class="inp" rows="7" dir="ltr" placeholder="1;Marteau;30;40;5"></textarea><div class="err" id="err"></div>`,
    buttons: [{ label: 'إلغاء' }, { label: 'استيراد', cls: 'gold', onClick: async (close, m) => {
      const rows = [];
      for (const line of m.querySelector('#ta').value.split('\n')) {
        const c = line.split(/\t|;/).map((x) => x.trim());
        if (c.length < 2 || !c[1]) continue;
        if (c[0] && !/^\d+$/.test(c[0])) continue;                      // header line
        rows.push({ sku: c[0] || undefined, name: c[1], purchasePrice: c[2] || '0', salePrice: c[3] || '0', qty: c[4] || '0' });
      }
      try { const r = await eng.products.import(rows); toast(`أُضيف ${r.created} · تُجوهل ${r.skipped.length}`, false, 3500); load(); }
      catch (e) { m.querySelector('#err').textContent = errText(e); return false; }
    } }],
    onOpen: (m) => m.querySelector('#ta').focus(),
  }));

  // ---- CSV for Excel (UTF-8 with BOM so Arabic names display correctly)
  $('#csv')?.addEventListener('click', async () => {
    try {
      const csv = await eng.products.exportCsv();
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }), a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `stock-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast('تم تصدير المخزون');
    } catch (e) { toast(errText(e), true); }
  });
  load();
}

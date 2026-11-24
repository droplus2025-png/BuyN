// External product window (an item bought for one customer, not in stock).
//  [إضافة]                       -> the line goes to the cart only
//  [إضافة للسلة والمخزون]        -> the line goes to the cart AND the product is created in the stock
//                                   (name + both prices, quantity 0) so it can be found next time
import { toast, errText, openModal } from './ui-core.js';
import { money as M } from './index.js';

export function openExternal(app, onAdd) {
  const can = app.session.permissions;
  const read = (m) => {
    const name = m.querySelector('#en').value.trim(), cost = m.querySelector('#ec').value.trim() || '0',
      price = m.querySelector('#ep').value.trim(), qty = m.querySelector('#eq').value.trim() || '1';
    try { M.parsePrice(cost); M.parsePrice(price); if (M.parseQty(qty) <= 0) throw Object.assign(new Error(), { code: 'BAD_NUMBER' }); if (!name) throw Object.assign(new Error(), { code: 'NAME_REQUIRED' }); }
    catch (e) { m.querySelector('#eerr').textContent = errText(e); return null; }
    return { name, cost, price, qty };
  };
  openModal({
    title: 'منتج خارجي (حسب الطلب)',
    html: `<input id="en" class="inp" placeholder="اسم المنتج" autocomplete="off"><div class="row"><input id="ec" class="inp" inputmode="decimal" placeholder="الشراء" style="flex:1">
      <input id="ep" class="inp" inputmode="decimal" placeholder="البيع" style="flex:1"><input id="eq" class="inp" inputmode="decimal" value="1" placeholder="الكمية" style="flex:.6"></div><div class="err" id="eerr"></div>`,
    buttons: [
      { label: 'إلغاء' },
      { label: 'إضافة', cls: 'gold', onClick: (close, m) => { const v = read(m); if (!v) return false; onAdd(v); } },
      ...(can.add_product ? [{ label: 'إضافة للسلة والمخزون', cls: 'green', row2: true, onClick: async (close, m) => {
        const v = read(m); if (!v) return false;
        try {
          const p = await app.engine.products.create({ name: v.name, purchasePrice: v.cost, salePrice: v.price, qty: '0' });
          toast(`أُضيف إلى المخزون · رقم ${p.sku}`);
        } catch (e) { m.querySelector('#eerr').textContent = errText(e) + (e.details?.sku ? ` (رقم ${e.details.sku}، اخترْه من البحث)` : ''); return false; }
        onAdd(v);
      } }] : []),
    ],
    onOpen: (m) => m.querySelector('#en').focus(),
  });
}

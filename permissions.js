// Permission catalog (mirrors the database table `permissions`) and the access object.
// Owner = everything, always. Employee = catalog default, overridden per employee by the owner.
import { fail } from './errors.js';

export const CATALOG = [
  ['sell', 'sales', 'البيع', true, true], ['quick_sale', 'sales', 'البيع السريع', true, true],
  ['external_product', 'sales', 'منتج خارجي (حسب الطلب)', true, false],
  ['edit_sale_price', 'sales', 'تعديل سعر البيع في السلة', true, false],
  ['sell_below_cost', 'sales', 'البيع بأقل من التكلفة', true, true],
  ['purchase', 'purchases', 'الشراء وإدخال البضاعة', true, true],
  ['edit_purchase_price', 'purchases', 'تعديل سعر الشراء', true, false],
  ['add_product', 'purchases', 'إنشاء منتج جديد من صفحة الشراء', true, true],
  ['return_customer', 'returns', 'إرجاع من زبون', true, true], ['return_supplier', 'returns', 'إرجاع للمورد', true, true],
  ['expense', 'money', 'تسجيل مصروف', true, true], ['collect_debt', 'money', 'قبض دين من زبون', true, true],
  ['pay_supplier', 'money', 'الدفع للمورد', true, true], ['send_reminder', 'money', 'إرسال تذكير الدين بالواتساب', true, false],
  ['add_previous_debt', 'money', 'إضافة دين / مستحق سابق', false, true], ['cash_count', 'money', 'عدّ الصندوق عند الإغلاق', true, true],
  ['cash_deposit_withdraw', 'money', 'إيداع وسحب من الصندوق', false, true],
  ['view_stock', 'stock', 'عرض المخزون والبحث', true, false],
  ['manage_stock', 'stock', 'تعديل المخزون: إدخال أولي، استيراد، حذف، تغيير SKU', false, true],
  ['view_invoices', 'other', 'أرشيف الفواتير', true, false], ['view_cost_profit', 'other', 'رؤية التكلفة والربح في الفواتير', true, false],
].map(([key, grp, label_ar, default_employee, enforced_by_db], i) => ({ key, grp, label_ar, default_employee, enforced_by_db, sort: (i + 1) * 10 }));

const KEYS = new Set(CATALOG.map(p => p.key));
export const isPermissionKey = (k) => KEYS.has(k);

const TYPE_PERM = {
  sale: 'sell', quick_sale: 'quick_sale', quick_detail: 'quick_sale', purchase: 'purchase', return_customer: 'return_customer',
  return_supplier: 'return_supplier', expense: 'expense', collect: 'collect_debt', pay_supplier: 'pay_supplier',
  deposit: 'cash_deposit_withdraw', withdrawal: 'cash_deposit_withdraw',
  opening_debt_customer: 'add_previous_debt', opening_debt_supplier: 'add_previous_debt', cash_adjustment: 'cash_count',
};

// defaults: the owner may change the default for all employees (stored in settings)
export function createAccess({ role, perms = {}, defaults = {} }) {
  const def = (k) => (k in defaults ? defaults[k] : CATALOG.find(p => p.key === k)?.default_employee ?? false);
  const can = (k) => {
    if (!KEYS.has(k)) fail('UNKNOWN_PERMISSION', `Unknown permission ${k}`);
    if (role === 'owner') return true;
    if (role !== 'employee') return false;
    return typeof perms[k] === 'boolean' ? perms[k] : def(k);
  };
  return {
    role,
    isOwner: role === 'owner',
    can,
    require(k) { if (!can(k)) fail('PERMISSION_DENIED', `Not allowed: ${k}`, { permission: k }); },
    requireOwner() { if (role !== 'owner') fail('PERMISSION_DENIED', 'Owner only', { permission: 'owner' }); },
    canPost(type) { const k = TYPE_PERM[type]; return !!k && can(k); },
    requirePost(type) { const k = TYPE_PERM[type]; if (!k) fail('BAD_TYPE', `Unknown invoice type ${type}`); this.require(k); },
    all() { return Object.fromEntries(CATALOG.map(p => [p.key, can(p.key)])); },   // what the app asks after login
  };
}

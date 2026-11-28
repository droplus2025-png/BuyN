// Settings edited from the Administration screen (owner). Everybody can read them.
import { fail } from './errors.js';

const LINE_FORMAT = '{n}- {name}   {qty}×{price}   {total}';   // one line per product, total at the far right

export const DEFAULT_SETTINGS = {
  store_name: 'اسم المحل', store_phone: '', store_address: '', thanks_text: 'شكراً لثقتكم، نتمنى رؤيتكم قريباً',
  currency: 'DH', wa_country_code: '212', timezone: 'Africa/Casablanca',
  quick_sale_profit_pct: 20,                                  // % of a quick sale counted as profit
  low_stock_threshold: 5,
  letters_layout: 'latin',                                    // PC on-screen letters: 'latin' | 'ar'
  categories: { 0: 'عام', 1: '', 2: '', 3: '', 4: '', 5: '', 6: '', 7: '', 8: '', 9: '' },   // digit -> name (stats / stocktaking only)
  sale_beep: true,                                            // sale screen: bip on every button, double bip on pay
  invoice_template: {
    separator: '━━━━━━━━━━━━━━', show_phone: true, show_address: true, show_customer: true, bold_total: true,
    line_format: LINE_FORMAT,
    labels: { product: 'produit', qp: 'q×p', line_total: 'Total', invoice: 'Fact n°', date: 'Date', time: 'Heure', items: 'Nombre des articles', total: 'Montant total',
      paid: 'Payé', remaining: 'Reste', phone: 'Tel', address: 'Adresse', customer: 'Client' },
    footer: '{thanks_text}',
  },
};
const EDITABLE = new Set(Object.keys(DEFAULT_SETTINGS));

export function settingsApi(ctx) {
  const { store } = ctx;
  return {
    async init() {                                            // first launch: fill what is missing
      return store.transaction(async (tx) => {
        for (const [key, value] of Object.entries(DEFAULT_SETTINGS))
          if (!(await tx.get('settings', key))) await tx.insert('settings', { key, value, updated_at: ctx.now().toISOString() });
      });
    },
    async get() {
      return store.transaction(async (tx) => {
        const out = {};
        for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = (await tx.get('settings', k))?.value ?? DEFAULT_SETTINGS[k];
        const t = out.invoice_template;                     // template saved earlier: old two-line format -> new one-line format, new labels filled in
        out.invoice_template = { ...t, line_format: t.line_format, labels: { ...DEFAULT_SETTINGS.invoice_template.labels, ...t.labels } };
        return out;
      });
    },
    // owner only: store identity, quick-sale %, invoice template ...
    async set(key, value) {
      ctx.access.requireOwner(); ctx.requireMain();
      if (!EDITABLE.has(key)) fail('UNKNOWN_SETTING', `Unknown setting ${key}`);
      if (key === 'categories') { const ok = value && typeof value === 'object' && Object.keys(value).every((d) => /^[0-9]$/.test(d) && String(value[d]).length <= 30); if (!ok) fail('BAD_CATEGORIES', 'Categories: digits 0-9, names up to 30 characters'); }
      if (key === 'letters_layout' && !['latin', 'ar'].includes(value)) fail('BAD_LAYOUT', 'Letters layout: latin or ar');
      if (key === 'quick_sale_profit_pct' && !(Number(value) >= 0 && Number(value) <= 100)) fail('BAD_NUMBER', 'Percentage must be between 0 and 100');
      return store.transaction(async (tx) => {
        const cur = await tx.get('settings', key);
        const row = { value, updated_at: ctx.now().toISOString() };
        if (cur) await tx.update('settings', key, row); else await tx.insert('settings', { key, ...row });
        await tx.insert('audit_log', { id: ctx.ids(), at: ctx.now().toISOString(), user_id: ctx.userId ?? null, action: 'update',
          entity: 'settings', entity_id: key, old_data: cur?.value ?? null, new_data: value });
      });
    },
  };
}

// Formatted text invoice, ready for one-tap WhatsApp sending. No PDF at all.
// The look comes from settings.invoice_template (editable in Administration).
import { fmtMoney, fmtQty, fmtPrice } from './money.js';
import { dayParts } from './invoice-number.js';

const MONTHS = ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc'];
const TITLES = { purchase: 'فاتورة شراء', return_customer: 'إرجاع من زبون', return_supplier: 'إرجاع للمورد',
  expense: 'مصروف', deposit: 'إيداع', withdrawal: 'سحب', collect: 'قبض دين', pay_supplier: 'دفع للمورد',
  opening_debt_customer: 'دين سابق', opening_debt_supplier: 'مستحق سابق', cash_adjustment: 'تسوية الصندوق' };

const LRM = '\u200E';                                       // forces left-to-right lines: product at the left, total at the far right
const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));

// data: { invoice, lines, party?, parentNo?, settings }
export function renderInvoice({ invoice: i, lines = [], party = null, parentNo = null, settings: s }) {
  const t = s.invoice_template, L = t.labels, cur = s.currency ? ` ${s.currency}` : '';
  const d = dayParts(new Date(i.created_at), s.timezone);
  const sep = t.separator;
  const bold = (x) => `*${x}*`;
  const out = [bold(s.store_name), sep, `${L.invoice} : ${i.invoice_no}`,
    `${L.date} : ${Number(d.day)} ${MONTHS[Number(d.month) - 1]} ${d.year}   ${L.time} : ${d.hour}:${d.minute}`];
  if (TITLES[i.type]) out.push(bold(TITLES[i.type]));
  if (parentNo) out.push(`${L.invoice} (origine) : ${parentNo}`);
  if (t.show_customer && party) out.push(`${L.customer} : ${party.name}`);
  out.push(sep);

  if (lines.length) {
    out.push(`${LRM}${L.product || 'produit'}   ${L.qp || 'q×p'}   ${L.line_total || 'Total'}`);
    lines.forEach((l, n) => out.push(LRM + fill(t.line_format, { n: n + 1, name: l.name, qty: fmtQty(l.qty), price: fmtPrice(l.unit_price), total: fmtMoney(l.line_total) })));
    out.push(sep, `${L.items} : ${fmtQty(lines.reduce((a, l) => a + l.qty, 0))}`);
  } else if (i.note) out.push(i.note);

  const total = `${L.total} : ${fmtMoney(i.total)}${cur}`;
  out.push(t.bold_total ? bold(total) : total);
  if (i.type === 'sale' && i.credit_amount > 0) out.push(`${L.paid} : ${fmtMoney(i.paid)}${cur}`, `${L.remaining} : ${fmtMoney(i.credit_amount)}${cur}`);
  out.push(sep);
  if (t.show_phone && s.store_phone) out.push(`${L.phone} : ${s.store_phone}`);
  if (t.show_address && s.store_address) out.push(`${L.address} : ${s.store_address}`);
  if (t.footer) out.push(fill(t.footer, { thanks_text: s.thanks_text }));
  return out.join('\n');
}

export function renderReminder({ party, balance, settings: s }) {
  const cur = s.currency ? ` ${s.currency}` : '';
  return [`السلام عليكم ${party.name}،`, `نذكّركم بأن المبلغ المتبقي عليكم: ${fmtMoney(balance)}${cur}`,
    s.store_name, s.store_phone ? `${s.invoice_template.labels.phone} : ${s.store_phone}` : '', s.thanks_text].filter(Boolean).join('\n');
}
export const waLink = (phoneNorm, text) => `https://wa.me/${phoneNorm}?text=${encodeURIComponent(text)}`;

// 06xxxxxxxx = +212 6xxxxxxxx = 00212 6xxxxxxxx  -> same number (mirrors fn_norm_phone)
export function normPhone(p, cc = '212') {
  const d = String(p ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) return d.slice(2);
  if (d.startsWith('0') && d.length === 10) return cc + d.slice(1);
  return d;
}
export const validPhone = (p, cc) => { const n = normPhone(p, cc); return !!n && n.length >= 6; };

// Invoice number  a mm jj ooo   (a = last digit of the year)   e.g. 61113001
// Same number met again (two offline devices, sync) -> suffix -1, -2 ...
export function dayParts(date, timeZone = 'Africa/Casablanca') {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const o = Object.fromEntries(f.formatToParts(date).map(p => [p.type, p.value]));
  return { year: o.year, month: o.month, day: o.day, hour: o.hour, minute: o.minute, key: `${o.year}-${o.month}-${o.day}` };
}
const invoiceBase = (date, seq, tz) => {
  const d = dayParts(date, tz);
  return `${d.year.slice(-1)}${d.month}${d.day}${String(seq).padStart(3, '0')}`;
};
// next order number of the day, looking at the numbers already used (suffixes ignored)
export function nextInvoiceNo(existingNos, date, tz) {
  const d = dayParts(date, tz);
  const prefix = `${d.year.slice(-1)}${d.month}${d.day}`;
  let max = 0;
  for (const no of existingNos) {
    const base = String(no).split('-')[0];
    if (base.length === 8 && base.startsWith(prefix)) max = Math.max(max, Number(base.slice(5)));
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}
export function uniqueInvoiceNo(existingNos, base) {
  const set = new Set(existingNos);
  if (!set.has(base)) return base;
  let n = 1;
  while (set.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

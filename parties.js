// Customers & suppliers: identity = normalised phone (one per phone, whatever the name).
import { fail } from './errors.js';
import { normPhone } from './phone.js';
import { getSetting, audit } from './post.js';

export async function findOrCreateParty(ctx, tx, table, { name, phone }) {
  const cc = await getSetting(tx, 'wa_country_code', '212');
  const norm = normPhone(phone, cc);
  const label = table === 'customers' ? 'customer' : 'supplier';
  if (!name || !String(name).trim()) fail('NAME_REQUIRED', `${label} name is required`);
  if (!norm || norm.length < 6) fail('PHONE_REQUIRED', `${label} phone is required (6 digits minimum)`);
  const existing = (await tx.find(table, r => r.phone_norm === norm))[0];
  if (existing) return existing;                      // same phone = same party, name kept
  const t = ctx.now().toISOString();
  const row = await tx.insert(table, { id: ctx.ids(), name: String(name).trim(), phone: String(phone).trim(), phone_norm: norm,
    last_reminder_at: null, origin_device: ctx.deviceId ?? null, created_at: t, updated_at: t });
  await audit(ctx, tx, 'insert', table, row.id, null, row);
  return row;
}

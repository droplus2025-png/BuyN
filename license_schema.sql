-- buyN LICENSES: activation by phone number. Run this file ONCE in the Supabase SQL editor, AFTER sync_schema.sql.
-- A phone number = a shop. Only numbers YOU add (with an activation code you give to the owner) can activate the program.
-- It replaces the "setup key" (create_shop / recover_main are removed).
--
-- Add a customer (run it yourself in the SQL editor; the code is stored hashed, keep your own list of codes):
--   select add_license('0663152474', 'THE-ACTIVATION-CODE', 'Shop name', 3);                 -- phone, code, name, max devices
--   select add_license('0663152474', 'NEW-CODE');                                              -- change the code of an existing number
-- Suspend / resume / set an end date (all that shop's devices lock at their next contact; nothing is deleted):
--   update licenses set status = 'suspended' where phone_norm = '212663152474';
--   update licenses set status = 'active', expires_at = '2027-12-31' where phone_norm = '212663152474';
-- Raise the device limit:   update licenses set max_devices = 5 where phone_norm = '212663152474';
-- (phone_norm = the number without the leading 0, with the country code 212.)

alter table devices add column if not exists lease_until timestamptz;       -- the device may work offline until this date; each contact renews it (14 days)
alter table pair_failures add column if not exists who text;

create table if not exists licenses (
  phone_norm text primary key,
  name text not null default '',
  activation_hash text not null,                                           -- sha256(phone_norm || ':' || code)
  status text not null default 'active' check (status in ('active', 'suspended')),
  max_devices int not null default 3 check (max_devices >= 1),
  expires_at timestamptz,
  shop_id uuid references shops(id) on delete set null,                    -- filled at the first activation
  created_at timestamptz not null default now()
);
alter table licenses enable row level security;
revoke all on licenses from anon, authenticated;

drop function if exists create_shop(text, text, text);
drop function if exists recover_main(text, uuid, text, text);
drop function if exists _setup_key_ok(text);

-- same rule as phone.js: 06xxxxxxxx = +212 6xxxxxxxx = 00212 6xxxxxxxx
create or replace function _norm_phone(p text, cc text default '212') returns text language sql immutable as $$
  select case when d = '' then null when d like '00%' then substr(d, 3) when d like '0%' and length(d) = 10 then cc || substr(d, 2) else d end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) x
$$;

-- you only (SQL editor): add a number or change its code / limits
create or replace function add_license(p_phone text, p_code text, p_name text default '', p_max int default 3, p_expires timestamptz default null, p_shop uuid default null) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare ph text := _norm_phone(p_phone);
begin
  if ph is null or length(ph) < 6 then raise exception 'BAD_PHONE'; end if;
  if length(coalesce(p_code, '')) < 6 then raise exception 'CODE_TOO_SHORT'; end if;
  insert into licenses (phone_norm, name, activation_hash, max_devices, expires_at, shop_id)
    values (ph, coalesce(p_name, ''), _sha(ph || ':' || p_code), p_max, p_expires, p_shop)
    on conflict (phone_norm) do update set activation_hash = excluded.activation_hash,
      name = case when p_name = '' then licenses.name else excluded.name end, max_devices = excluded.max_devices,
      expires_at = coalesce(excluded.expires_at, licenses.expires_at), shop_id = coalesce(excluded.shop_id, licenses.shop_id);
  return ph;
end $$;

-- null when the shop's license is valid, otherwise the reason. A shop without a license is refused.
create or replace function _license_error(p_shop uuid) returns text
language sql stable security definer set search_path = public as $$
  select case when l.status <> 'active' then 'LICENSE_SUSPENDED' when l.expires_at is not null and l.expires_at < now() then 'LICENSE_EXPIRED' end
    from licenses l where l.shop_id = p_shop
  union all
  select 'LICENSE_SUSPENDED' where not exists (select 1 from licenses where shop_id = p_shop)
  limit 1
$$;

-- every call: device key, not disconnected, license valid; the 14-day lease is renewed
create or replace function _auth(p_device text, p_token text, p_allow_revoked boolean default false) returns devices
language plpgsql security definer set search_path = public, extensions as $$
declare dv devices; err text;
begin
  select * into dv from devices where id = p_device and token_hash = _sha(coalesce(p_token, ''));
  if not found then raise exception 'BAD_TOKEN'; end if;
  if not p_allow_revoked then
    if dv.status = 'revoked' then raise exception 'DEVICE_REVOKED_%', upper(coalesce(dv.revoke_mode, 'lock')); end if;
    err := _license_error(dv.shop_id);
    if err is not null then raise exception '%', err; end if;
  end if;
  update devices set last_seen_at = now(), lease_until = case when p_allow_revoked then lease_until else now() + interval '14 days' end
    where id = dv.id returning * into dv;
  return dv;
end $$;

-- ACTIVATION: phone number + activation code. First time: creates the shop, this device is the MAIN device.
-- Again later (new phone, reinstall): this device becomes the main one and the previous main device is wiped.
create or replace function activate(p_phone text, p_code text, p_device text, p_name text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare ph text := _norm_phone(p_phone); lic licenses; tok text := _new_token(); s uuid; recovered boolean := false; lease timestamptz := now() + interval '14 days';
begin
  if ph is null or length(ph) < 6 then return jsonb_build_object('error', 'BAD_ACTIVATION'); end if;
  if (select count(*) from pair_failures where failed_at > now() - interval '10 minutes') >= 30
    or (select count(*) from pair_failures where failed_at > now() - interval '10 minutes' and who = ph) >= 5 then raise exception 'TOO_MANY_ATTEMPTS'; end if;
  delete from pair_failures where failed_at < now() - interval '1 day';
  select * into lic from licenses where phone_norm = ph and activation_hash = _sha(ph || ':' || coalesce(p_code, '')) for update;
  if not found then
    insert into pair_failures (who) values (ph);
    return jsonb_build_object('error', 'BAD_ACTIVATION');                  -- same answer for an unknown number and a wrong code; returned so the failure stays counted
  end if;
  if lic.status <> 'active' then return jsonb_build_object('error', 'LICENSE_SUSPENDED'); end if;
  if lic.expires_at is not null and lic.expires_at < now() then return jsonb_build_object('error', 'LICENSE_EXPIRED'); end if;
  if exists (select 1 from devices where id = p_device and shop_id is distinct from lic.shop_id) then raise exception 'DEVICE_TAKEN'; end if;
  s := lic.shop_id;
  if s is null then
    insert into shops default values returning id into s;
    update licenses set shop_id = s where phone_norm = ph;
  else
    recovered := true;
    update devices set status = 'revoked', revoke_mode = 'wipe', revoked_at = now(), wipe_confirmed_at = null
      where shop_id = s and role = 'main' and status = 'active' and id <> p_device;
  end if;
  if exists (select 1 from devices where id = p_device) then
    update devices set role = 'main', status = 'active', revoke_mode = null, revoked_at = null, wipe_confirmed_at = null,
      token_hash = _sha(tok), name = coalesce(p_name, name), lease_until = lease where id = p_device;
  else
    if (select count(*) from devices where shop_id = s and status = 'active') >= lic.max_devices then raise exception 'DEVICE_LIMIT'; end if;
    insert into devices (id, shop_id, name, role, token_hash, lease_until) values (p_device, s, coalesce(p_name, ''), 'main', _sha(tok), lease);
  end if;
  return jsonb_build_object('shop_id', s, 'token', tok, 'role', 'main', 'recovered', recovered, 'lease_until', lease);
end $$;

-- link code usage: license valid + device limit + lease
create or replace function join_shop(p_code text, p_device text, p_name text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare pc pairing_codes; tok text := _new_token(); prev devices; err text; lease timestamptz := now() + interval '14 days'; maxd int;
begin
  if (select count(*) from pair_failures where failed_at > now() - interval '10 minutes') >= 30 then raise exception 'TOO_MANY_ATTEMPTS'; end if;
  delete from pair_failures where failed_at < now() - interval '1 day';
  select * into pc from pairing_codes where code_hash = _sha(regexp_replace(coalesce(p_code, ''), '\D', '', 'g')) and used_at is null and expires_at > now() for update;
  if not found then
    insert into pair_failures default values;
    return jsonb_build_object('error', 'BAD_PAIR_CODE');                 -- returned, not raised: the failure must stay counted
  end if;
  err := _license_error(pc.shop_id);
  if err is not null then raise exception '%', err; end if;
  select max_devices into maxd from licenses where shop_id = pc.shop_id;
  if (select count(*) from devices where shop_id = pc.shop_id and status = 'active' and id <> p_device) >= maxd then raise exception 'DEVICE_LIMIT'; end if;
  select * into prev from devices where id = p_device;
  if found then
    if prev.shop_id <> pc.shop_id or prev.status = 'active' then raise exception 'DEVICE_TAKEN'; end if;
    update devices set status = 'active', revoke_mode = null, revoked_at = null, wipe_confirmed_at = null,
      token_hash = _sha(tok), name = coalesce(p_name, name), role = 'linked', lease_until = lease where id = p_device;       -- a disconnected device joins again
  else
    insert into devices (id, shop_id, name, role, token_hash, lease_until) values (p_device, pc.shop_id, coalesce(p_name, ''), 'linked', _sha(tok), lease);
  end if;
  update pairing_codes set used_at = now() where code_hash = pc.code_hash;
  return jsonb_build_object('shop_id', pc.shop_id, 'token', tok, 'role', 'linked', 'lease_until', lease);
end $$;

-- data: same as before, plus the lease date goes back to the device
create or replace function sync_push(p_device text, p_token text, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare dv devices; r jsonb; n int := 0; append_only text[] := array['invoice_lines', 'stock_movements', 'cash_ledger', 'debt_ledger', 'invoice_settlements', 'price_history', 'audit_log', 'sku_registry'];
  allowed text[] := array['app_users', 'settings', 'products', 'sku_registry', 'price_history', 'customers', 'suppliers', 'invoices', 'invoice_lines',
    'stock_movements', 'cash_ledger', 'debt_ledger', 'invoice_settlements', 'cash_sessions', 'audit_log'];
begin
  dv := _auth(p_device, p_token);
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'BAD_ROWS'; end if;
  if jsonb_array_length(p_rows) > 500 then raise exception 'TOO_MANY_ROWS'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if not ((r->>'t') = any (allowed)) then raise exception 'BAD_TABLE'; end if;
    if (r->>'t') = any (append_only) then
      insert into sync_rows (shop_id, t, k, d, u, dev) values (dv.shop_id, r->>'t', r->>'k', r->'d', (r->>'u')::timestamptz, dv.id)
        on conflict (shop_id, t, k) do nothing;
    else
      insert into sync_rows (shop_id, t, k, d, u, dev) values (dv.shop_id, r->>'t', r->>'k', r->'d', (r->>'u')::timestamptz, dv.id)
        on conflict (shop_id, t, k) do update set d = excluded.d, u = excluded.u, dev = excluded.dev, seq = nextval('sync_seq')
        where sync_rows.u <= excluded.u;
    end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'n', n, 'lease_until', dv.lease_until);
end $$;

create or replace function sync_pull(p_device text, p_token text, p_since bigint, p_limit int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare dv devices; res jsonb; last_seq bigint;
begin
  dv := _auth(p_device, p_token);
  select coalesce(jsonb_agg(jsonb_build_object('t', x.t, 'k', x.k, 'd', x.d, 'u', x.u, 's', x.seq) order by x.seq), '[]'::jsonb), coalesce(max(x.seq), p_since)
    into res, last_seq
    from (select * from sync_rows where shop_id = dv.shop_id and seq > p_since and dev <> dv.id order by seq limit least(greatest(p_limit, 1), 1000)) x;
  return jsonb_build_object('rows', res, 'last', last_seq, 'lease_until', dv.lease_until);
end $$;

-- who may call what
revoke all on function _norm_phone(text, text), _license_error(uuid), _auth(text, text, boolean), add_license(text, text, text, int, timestamptz, uuid) from public, anon, authenticated;
revoke all on function activate(text, text, text, text), join_shop(text, text, text), sync_push(text, text, jsonb), sync_pull(text, text, bigint, int) from public;
grant execute on function activate(text, text, text, text), join_shop(text, text, text), sync_push(text, text, jsonb), sync_pull(text, text, bigint, int) to anon, authenticated;

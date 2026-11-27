-- buyN cloud sync: ONE main device + linked devices. Run this whole file ONCE in the Supabase SQL editor
-- (a dedicated Supabase project for buyN). Nothing is reachable directly: every table is locked (RLS, no policy)
-- and the program talks only to the functions below, each one checking the device key.
--
--  main device   : creates the shop, makes link codes, sees the devices, disconnects any device
--  linked device : joined with a one-time link code, can only push / pull the shop data
--  disconnect    : the owner chooses 'lock' (the program locks, data stays) or 'wipe' (data erased at its next contact)
--
-- THEN run license_schema.sql (activation by phone number): it replaces the setup key used by create_shop / recover_main, which it removes.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- tables
create table if not exists app_config (key text primary key, value text not null);
insert into app_config (key, value) values ('setup_key_hash', '') on conflict (key) do nothing;

create table if not exists shops (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

create table if not exists devices (
  id text primary key,                                   -- the device_id the program generated
  shop_id uuid not null references shops(id) on delete cascade,
  name text not null default '',
  role text not null check (role in ('main', 'linked')),
  status text not null default 'active' check (status in ('active', 'revoked')),
  revoke_mode text check (revoke_mode in ('lock', 'wipe')),
  token_hash text not null,                              -- sha256 of the device key (the key itself is never stored)
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  wipe_confirmed_at timestamptz
);
create unique index if not exists one_main_per_shop on devices (shop_id) where role = 'main' and status = 'active';

create table if not exists pairing_codes (
  code_hash text primary key,
  shop_id uuid not null references shops(id) on delete cascade,
  created_by text not null references devices(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table if not exists pair_failures (failed_at timestamptz not null default now());

create sequence if not exists sync_seq;
create table if not exists sync_rows (
  shop_id uuid not null references shops(id) on delete cascade,
  t text not null,                                       -- table name in the program
  k text not null,                                       -- primary key of the row
  d jsonb not null,                                      -- the row
  u timestamptz not null,                                -- last change (set by the device that made it)
  dev text not null,                                     -- device that sent it last
  seq bigint not null default nextval('sync_seq'),
  primary key (shop_id, t, k)
);
create index if not exists sync_rows_seq on sync_rows (shop_id, seq);

alter table app_config enable row level security;
alter table shops enable row level security;
alter table devices enable row level security;
alter table pairing_codes enable row level security;
alter table pair_failures enable row level security;
alter table sync_rows enable row level security;
revoke all on app_config, shops, devices, pairing_codes, pair_failures, sync_rows from anon, authenticated;

-- ---------------------------------------------------------------- internal helpers (not callable from outside)
create or replace function _sha(p text) returns text language sql immutable as $$
  select encode(extensions.digest(p, 'sha256'), 'hex')
$$;

-- the device behind a key. A disconnected device is refused with a message the program understands.
create or replace function _auth(p_device text, p_token text, p_allow_revoked boolean default false) returns devices
language plpgsql security definer set search_path = public, extensions as $$
declare dv devices;
begin
  select * into dv from devices where id = p_device and token_hash = _sha(coalesce(p_token, ''));
  if not found then raise exception 'BAD_TOKEN'; end if;
  if dv.status = 'revoked' and not p_allow_revoked then
    raise exception 'DEVICE_REVOKED_%', upper(coalesce(dv.revoke_mode, 'lock'));
  end if;
  update devices set last_seen_at = now() where id = dv.id;
  return dv;
end $$;

create or replace function _require_main(p_device text, p_token text) returns devices
language plpgsql security definer set search_path = public, extensions as $$
declare dv devices;
begin
  dv := _auth(p_device, p_token);
  if dv.role <> 'main' then raise exception 'NOT_MAIN'; end if;
  return dv;
end $$;

-- a wrong key is counted: the failure is RETURNED as {error}, not raised (a raise would undo the count)
create or replace function _setup_key_ok(p_key text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare h text;
begin
  select value into h from app_config where key = 'setup_key_hash';
  if coalesce(h, '') = '' then raise exception 'SETUP_KEY_NOT_SET'; end if;
  if _sha(coalesce(p_key, '')) <> h then
    insert into pair_failures default values;
    return false;
  end if;
  return true;
end $$;

create or replace function _new_token() returns text language sql volatile as $$
  select encode(extensions.gen_random_bytes(24), 'hex')
$$;

-- ---------------------------------------------------------------- shop and devices
-- the first device creates the shop and becomes the MAIN device. Returns the device key (shown once: the program keeps it).
create or replace function create_shop(p_setup_key text, p_device text, p_name text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s uuid; tok text := _new_token();
begin
  if (select count(*) from pair_failures where failed_at > now() - interval '10 minutes') >= 10 then raise exception 'TOO_MANY_ATTEMPTS'; end if;
  if not _setup_key_ok(p_setup_key) then return jsonb_build_object('error', 'SETUP_KEY_BAD'); end if;
  if exists (select 1 from devices where id = p_device) then raise exception 'DEVICE_TAKEN'; end if;
  insert into shops default values returning id into s;
  insert into devices (id, shop_id, name, role, token_hash) values (p_device, s, coalesce(p_name, ''), 'main', _sha(tok));
  return jsonb_build_object('shop_id', s, 'token', tok, 'role', 'main');
end $$;

-- main device: an 8-digit link code, valid 10 minutes, usable once
create or replace function create_pairing_code(p_device text, p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare dv devices; code text; expires timestamptz := now() + interval '10 minutes';
begin
  dv := _require_main(p_device, p_token);
  delete from pairing_codes where shop_id = dv.shop_id and (used_at is not null or expires_at < now());
  if (select count(*) from pairing_codes where shop_id = dv.shop_id) >= 5 then raise exception 'TOO_MANY_CODES'; end if;
  code := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 100000000)::text, 8, '0');
  insert into pairing_codes (code_hash, shop_id, created_by, expires_at) values (_sha(code), dv.shop_id, dv.id, expires);
  return jsonb_build_object('code', code, 'expires_at', expires);
end $$;

-- a new device joins with the link code and receives its own key
create or replace function join_shop(p_code text, p_device text, p_name text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare pc pairing_codes; tok text := _new_token(); prev devices;
begin
  if (select count(*) from pair_failures where failed_at > now() - interval '10 minutes') >= 10 then raise exception 'TOO_MANY_ATTEMPTS'; end if;
  delete from pair_failures where failed_at < now() - interval '1 day';
  select * into pc from pairing_codes where code_hash = _sha(regexp_replace(coalesce(p_code, ''), '\D', '', 'g')) and used_at is null and expires_at > now() for update;
  if not found then
    insert into pair_failures default values;
    return jsonb_build_object('error', 'BAD_PAIR_CODE');                 -- returned, not raised: the failure must stay counted
  end if;
  select * into prev from devices where id = p_device;
  if found then
    if prev.shop_id <> pc.shop_id or prev.status = 'active' then raise exception 'DEVICE_TAKEN'; end if;
    update devices set status = 'active', revoke_mode = null, revoked_at = null, wipe_confirmed_at = null,
      token_hash = _sha(tok), name = coalesce(p_name, name), role = 'linked' where id = p_device;       -- a disconnected device joins again
  else
    insert into devices (id, shop_id, name, role, token_hash) values (p_device, pc.shop_id, coalesce(p_name, ''), 'linked', _sha(tok));
  end if;
  update pairing_codes set used_at = now() where code_hash = pc.code_hash;
  return jsonb_build_object('shop_id', pc.shop_id, 'token', tok, 'role', 'linked');
end $$;

-- main device: the shop's devices
create or replace function list_devices(p_device text, p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare dv devices;
begin
  dv := _require_main(p_device, p_token);
  return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'role', x.role, 'status', x.status, 'revoke_mode', x.revoke_mode,
      'created_at', x.created_at, 'last_seen_at', x.last_seen_at, 'wipe_confirmed_at', x.wipe_confirmed_at) order by x.created_at)
    from devices x where x.shop_id = dv.shop_id), '[]'::jsonb);
end $$;

-- main device: disconnect a device. p_mode = 'lock' (program locked, data stays) or 'wipe' (data erased at its next contact)
create or replace function revoke_device(p_device text, p_token text, p_target text, p_mode text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare dv devices;
begin
  dv := _require_main(p_device, p_token);
  if p_mode not in ('lock', 'wipe') then raise exception 'BAD_MODE'; end if;
  if p_target = dv.id then raise exception 'SELF_REVOKE'; end if;
  update devices set status = 'revoked', revoke_mode = p_mode, revoked_at = now(), wipe_confirmed_at = null
    where id = p_target and shop_id = dv.shop_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  return jsonb_build_object('ok', true);
end $$;

-- a disconnected device tells the server it erased its data (the main device then sees "erased")
create or replace function ack_revoked(p_device text, p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare dv devices;
begin
  dv := _auth(p_device, p_token, true);
  if dv.status <> 'revoked' then raise exception 'NOT_REVOKED'; end if;
  update devices set wipe_confirmed_at = now() where id = dv.id;
  return jsonb_build_object('ok', true);
end $$;

-- the main device is lost: with the setup key, a new device (restored from a backup file) becomes the main one.
-- The old main device is disconnected with 'wipe'. Needs the shop id (shown in the devices screen of the program).
create or replace function recover_main(p_setup_key text, p_shop uuid, p_device text, p_name text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare tok text := _new_token();
begin
  if (select count(*) from pair_failures where failed_at > now() - interval '10 minutes') >= 10 then raise exception 'TOO_MANY_ATTEMPTS'; end if;
  if not _setup_key_ok(p_setup_key) then return jsonb_build_object('error', 'SETUP_KEY_BAD'); end if;
  if not exists (select 1 from shops where id = p_shop) then raise exception 'NOT_FOUND'; end if;
  update devices set status = 'revoked', revoke_mode = 'wipe', revoked_at = now(), wipe_confirmed_at = null
    where shop_id = p_shop and role = 'main' and status = 'active' and id <> p_device;
  if exists (select 1 from devices where id = p_device) then
    update devices set role = 'main', status = 'active', revoke_mode = null, revoked_at = null, wipe_confirmed_at = null, token_hash = _sha(tok), name = coalesce(p_name, name)
      where id = p_device and shop_id = p_shop;
  else
    insert into devices (id, shop_id, name, role, token_hash) values (p_device, p_shop, coalesce(p_name, ''), 'main', _sha(tok));
  end if;
  return jsonb_build_object('shop_id', p_shop, 'token', tok, 'role', 'main');
end $$;

-- ---------------------------------------------------------------- the data
-- push: ledgers (append-only) are inserted once and never replaced; other tables keep the NEWEST change
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
  return jsonb_build_object('ok', true, 'n', n);
end $$;

-- pull: what OTHER devices of the shop did after the cursor `p_since`
create or replace function sync_pull(p_device text, p_token text, p_since bigint, p_limit int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare dv devices; res jsonb; last_seq bigint;
begin
  dv := _auth(p_device, p_token);
  select coalesce(jsonb_agg(jsonb_build_object('t', x.t, 'k', x.k, 'd', x.d, 'u', x.u, 's', x.seq) order by x.seq), '[]'::jsonb), coalesce(max(x.seq), p_since)
    into res, last_seq
    from (select * from sync_rows where shop_id = dv.shop_id and seq > p_since and dev <> dv.id order by seq limit least(greatest(p_limit, 1), 1000)) x;
  return jsonb_build_object('rows', res, 'last', last_seq);
end $$;

-- ---------------------------------------------------------------- who may call what (the program uses the public "anon" key)
revoke all on function _sha(text), _auth(text, text, boolean), _require_main(text, text), _setup_key_ok(text), _new_token() from public, anon, authenticated;
revoke all on function create_shop(text, text, text), create_pairing_code(text, text), join_shop(text, text, text), list_devices(text, text),
  revoke_device(text, text, text, text), ack_revoked(text, text), recover_main(text, uuid, text, text), sync_push(text, text, jsonb), sync_pull(text, text, bigint, int) from public;
grant execute on function create_shop(text, text, text), create_pairing_code(text, text), join_shop(text, text, text), list_devices(text, text),
  revoke_device(text, text, text, text), ack_revoked(text, text), recover_main(text, uuid, text, text), sync_push(text, text, jsonb), sync_pull(text, text, bigint, int) to anon, authenticated;

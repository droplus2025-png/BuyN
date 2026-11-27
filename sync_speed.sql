-- buyN SYNC SPEED. Run this file ONCE in the Supabase SQL editor, AFTER sync_schema.sql and license_schema.sql (safe to run again).
--  * sync_exchange : ONE request sends the waiting rows AND returns what the other devices did (the program used two requests).
--  * set-based writes : a batch of rows is written with ONE statement, not one row at a time.
--  * the device record is no longer rewritten on every call (at most once a minute).

-- helper: write a batch of rows of one shop. Ledgers are inserted once and never replaced; the other tables keep the NEWEST change.
create or replace function _push_rows(p_shop uuid, p_dev text, p_rows jsonb) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare
  append_only text[] := array['invoice_lines', 'stock_movements', 'cash_ledger', 'debt_ledger', 'invoice_settlements', 'price_history', 'audit_log', 'sku_registry'];
  allowed text[] := array['app_users', 'settings', 'products', 'sku_registry', 'price_history', 'customers', 'suppliers', 'invoices', 'invoice_lines',
    'stock_movements', 'cash_ledger', 'debt_ledger', 'invoice_settlements', 'cash_sessions', 'audit_log'];
  n int;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception 'BAD_ROWS'; end if;
  n := jsonb_array_length(p_rows);
  if n = 0 then return 0; end if;
  if n > 500 then raise exception 'TOO_MANY_ROWS'; end if;
  if exists (select 1 from jsonb_to_recordset(p_rows) as x(t text) where not (x.t = any (allowed))) then raise exception 'BAD_TABLE'; end if;

  insert into sync_rows (shop_id, t, k, d, u, dev)
    select p_shop, x.t, x.k, x.d, x.u, p_dev
    from jsonb_to_recordset(p_rows) as x(t text, k text, d jsonb, u timestamptz)
    where x.t = any (append_only)
    on conflict (shop_id, t, k) do nothing;

  insert into sync_rows (shop_id, t, k, d, u, dev)                      -- the same row twice in one batch: the newest only
    select distinct on (x.t, x.k) p_shop, x.t, x.k, x.d, x.u, p_dev
    from jsonb_to_recordset(p_rows) as x(t text, k text, d jsonb, u timestamptz)
    where not (x.t = any (append_only))
    order by x.t, x.k, x.u desc
    on conflict (shop_id, t, k) do update set d = excluded.d, u = excluded.u, dev = excluded.dev, seq = nextval('sync_seq')
      where sync_rows.u <= excluded.u;
  return n;
end $$;

-- helper: what OTHER devices of the shop did after the cursor
create or replace function _pull_rows(p_shop uuid, p_dev text, p_since bigint, p_limit int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare res jsonb; last_seq bigint;
begin
  select coalesce(jsonb_agg(jsonb_build_object('t', x.t, 'k', x.k, 'd', x.d, 'u', x.u, 's', x.seq) order by x.seq), '[]'::jsonb), coalesce(max(x.seq), p_since)
    into res, last_seq
    from (select t, k, d, u, seq from sync_rows where shop_id = p_shop and seq > p_since and dev <> p_dev order by seq limit least(greatest(p_limit, 1), 1000)) x;
  return jsonb_build_object('rows', res, 'last', last_seq);
end $$;

-- the device record is touched at most once a minute (the 14-day lease is renewed then); a lease date never goes backwards
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
  if dv.last_seen_at is null or dv.last_seen_at < now() - interval '1 minute' then
    update devices set last_seen_at = now(), lease_until = case when p_allow_revoked then lease_until else now() + interval '14 days' end
      where id = dv.id returning * into dv;
  end if;
  return dv;
end $$;

-- ONE call: send rows + receive rows
create or replace function sync_exchange(p_device text, p_token text, p_rows jsonb, p_since bigint, p_limit int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare dv devices; pulled jsonb;
begin
  dv := _auth(p_device, p_token);
  perform _push_rows(dv.shop_id, dv.id, p_rows);
  pulled := _pull_rows(dv.shop_id, dv.id, p_since, p_limit);
  return pulled || jsonb_build_object('lease_until', dv.lease_until);
end $$;

-- the older two calls now use the same helpers
create or replace function sync_push(p_device text, p_token text, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare dv devices; n int;
begin
  dv := _auth(p_device, p_token);
  n := _push_rows(dv.shop_id, dv.id, p_rows);
  return jsonb_build_object('ok', true, 'n', n, 'lease_until', dv.lease_until);
end $$;

create or replace function sync_pull(p_device text, p_token text, p_since bigint, p_limit int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare dv devices;
begin
  dv := _auth(p_device, p_token);
  return _pull_rows(dv.shop_id, dv.id, p_since, p_limit) || jsonb_build_object('lease_until', dv.lease_until);
end $$;

-- who may call what
revoke all on function _push_rows(uuid, text, jsonb), _pull_rows(uuid, text, bigint, int), _auth(text, text, boolean) from public, anon, authenticated;
revoke all on function sync_exchange(text, text, jsonb, bigint, int), sync_push(text, text, jsonb), sync_pull(text, text, bigint, int) from public;
grant execute on function sync_exchange(text, text, jsonb, bigint, int), sync_push(text, text, jsonb), sync_pull(text, text, bigint, int) to anon, authenticated;

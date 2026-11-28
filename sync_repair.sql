-- buyN SYNC REPAIR. Run this file ONCE in the Supabase SQL editor, AFTER sync_schema.sql, license_schema.sql and sync_speed.sql (safe to run again).
--  * pushes of one shop are serialised: the order of `seq` is the order of commit, so a device can never read past a row that is not visible yet
--    (before: two devices uploading at the same moment could make a third one skip the older rows for good).
--  * sync_counts : how many rows of each table the shop holds. Every device compares it with its own count and repairs itself when they differ.
--  * shop epoch : when the MAIN device restores a backup or empties the operations, it calls sync_reset. The shop's rows are replaced by the main device's
--    state, the epoch goes up, and every linked device that meets the new epoch erases its local copy and reads the shop again: linked devices always follow the main one.

alter table shops add column if not exists epoch int not null default 1;

create or replace function _push_rows(p_shop uuid, p_dev text, p_rows jsonb) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare
  append_only text[] := array['invoice_lines', 'stock_movements', 'cash_ledger', 'debt_ledger', 'invoice_settlements', 'price_history', 'audit_log', 'sku_registry'];
  allowed text[] := array['app_users', 'settings', 'products', 'sku_registry', 'price_history', 'customers', 'suppliers', 'invoices', 'invoice_lines',
    'stock_movements', 'cash_ledger', 'debt_ledger', 'invoice_settlements', 'cash_sessions', 'audit_log'];
  n int;
begin
  perform pg_advisory_xact_lock(hashtext('buyn-sync:' || p_shop::text));     -- one push per shop at a time: seq order = commit order
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

-- the epoch of the device is sent with every exchange: a device from an older epoch is told to start again and its rows are NOT accepted
drop function if exists sync_exchange(text, text, jsonb, bigint, int);
create or replace function sync_exchange(p_device text, p_token text, p_rows jsonb, p_since bigint, p_limit int, p_epoch int default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare dv devices; pulled jsonb; ep int;
begin
  dv := _auth(p_device, p_token);
  select epoch into ep from shops where id = dv.shop_id;
  if p_epoch is not null and p_epoch <> ep then
    return jsonb_build_object('reset', true, 'epoch', ep, 'rows', '[]'::jsonb, 'last', 0, 'lease_until', dv.lease_until);
  end if;
  perform _push_rows(dv.shop_id, dv.id, p_rows);
  pulled := _pull_rows(dv.shop_id, dv.id, p_since, p_limit);
  return pulled || jsonb_build_object('lease_until', dv.lease_until, 'epoch', ep);
end $$;

create or replace function sync_counts(p_device text, p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare dv devices; res jsonb; ep int;
begin
  dv := _auth(p_device, p_token);
  select epoch into ep from shops where id = dv.shop_id;
  select coalesce(jsonb_object_agg(t, n), '{}'::jsonb) into res from (select t, count(*) as n from sync_rows where shop_id = dv.shop_id group by t) x;
  return jsonb_build_object('counts', res, 'epoch', ep);
end $$;

-- MAIN device only: forget every row of the shop (the main device then sends its own state again) and start a new epoch
create or replace function sync_reset(p_device text, p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare dv devices; ep int;
begin
  dv := _require_main(p_device, p_token);
  perform pg_advisory_xact_lock(hashtext('buyn-sync:' || dv.shop_id::text));
  delete from sync_rows where shop_id = dv.shop_id;
  update shops set epoch = epoch + 1 where id = dv.shop_id returning epoch into ep;
  return jsonb_build_object('epoch', ep);
end $$;

revoke all on function sync_exchange(text, text, jsonb, bigint, int, int), sync_counts(text, text), sync_reset(text, text) from public;
grant execute on function sync_exchange(text, text, jsonb, bigint, int, int), sync_counts(text, text), sync_reset(text, text) to anon, authenticated;
revoke all on function _push_rows(uuid, text, jsonb) from public, anon, authenticated;

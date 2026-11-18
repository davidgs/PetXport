-- Applied on every `pnpm migrate` run, after table migrations. Idempotent.
-- :APP_ROLE is substituted by migrate.ts with the (validated) app role name.

create or replace function app_org() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.org_id', true), '')::uuid $$;

create or replace function app_user() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

do $$
declare
  t record;
begin
  -- Every table that has an org_id column is a tenant table.
  for t in
    select c.table_name
    from information_schema.columns c
    join information_schema.tables tb
      on tb.table_schema = c.table_schema and tb.table_name = c.table_name
    where c.table_schema = 'public'
      and c.column_name = 'org_id'
      and tb.table_type = 'BASE TABLE'
  loop
    execute format('alter table public.%I enable row level security', t.table_name);
    execute format('alter table public.%I force row level security', t.table_name);
    execute format('drop policy if exists tenant_isolation on public.%I', t.table_name);
    execute format(
      'create policy tenant_isolation on public.%I using (org_id = app_org()) with check (org_id = app_org())',
      t.table_name);
  end loop;
end $$;

-- A user may additionally READ their own memberships, to list the organizations they belong
-- to. Writes always go through tenant_isolation, so they are confined to the current organization.
drop policy if exists own_memberships on public.memberships;
create policy own_memberships on public.memberships for select using (user_id = app_user());

-- On PostgreSQL 14 and earlier every role may create objects in "public" by default.
revoke create on schema public from public;

-- The app can never make anyone a platform admin; that flag is set by the database owner
-- (or by listing an address in PLATFORM_ADMIN_EMAILS).
create or replace function protect_platform_admin() returns trigger
  language plpgsql
  as $$
begin
  if current_user = ':APP_ROLE' and new.is_platform_admin
     and (tg_op = 'INSERT' or not old.is_platform_admin) then
    raise exception 'is_platform_admin can only be set by the database owner';
  end if;
  return new;
end $$;
drop trigger if exists protect_platform_admin on public.users;
create trigger protect_platform_admin before insert or update on public.users
  for each row execute function protect_platform_admin();

grant usage on schema public to :APP_ROLE;
grant select, insert, update, delete on all tables in schema public to :APP_ROLE;
grant usage, select on all sequences in schema public to :APP_ROLE;
-- The record of applied database changes is not the app's business.
revoke all on table public.schema_migrations from :APP_ROLE;
grant execute on function app_org(), app_user() to :APP_ROLE;

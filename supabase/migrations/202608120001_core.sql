-- ΡΟΔΙΟΣ — ΝΕΑ ΑΝΕΞΑΡΤΗΤΗ ΒΑΣΗ
-- Εκτελείται μόνο στο ΝΕΟ Supabase project.

begin;

create extension if not exists pgcrypto;
create extension if not exists unaccent;

create table if not exists public.rodios_app_users (
  id text primary key,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  data jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.rodios_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.rodios_service_staff (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.rodios_issues (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.rodios_work_orders (
  id text primary key,
  issue_id text references public.rodios_issues(id) on delete restrict,
  data jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.rodios_payments (
  id text primary key,
  work_order_id text references public.rodios_work_orders(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.work_order_acknowledgments (
  id uuid primary key default gen_random_uuid(),
  work_order_id text not null unique references public.rodios_work_orders(id) on delete cascade,
  order_num text,
  ack_token text not null unique,
  acknowledged_at timestamptz,
  manual_ack boolean not null default false,
  manual_ack_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.rodios_protocols (
  id uuid primary key default gen_random_uuid(),
  work_order_id text not null unique references public.rodios_work_orders(id) on delete cascade,
  storage_bucket text not null,
  storage_path text not null,
  filename text not null,
  signature_count integer not null check (signature_count = 3),
  signer_names jsonb not null check (jsonb_typeof(signer_names) = 'array' and jsonb_array_length(signer_names) = 3),
  committee_names jsonb not null check (jsonb_typeof(committee_names) = 'array' and jsonb_array_length(committee_names) = 3),
  accepted_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz not null default now()
);

create table if not exists public.rodios_storage_cleanup_queue (
  id uuid primary key default gen_random_uuid(),
  storage_bucket text not null,
  storage_path text not null,
  created_at timestamptz not null default now(),
  unique(storage_bucket, storage_path)
);

create unique index if not exists rodios_issues_number_uq
  on public.rodios_issues ((data ->> 'issueNum'))
  where deleted_at is null and nullif(data ->> 'issueNum', '') is not null;

create unique index if not exists rodios_work_orders_number_uq
  on public.rodios_work_orders ((data ->> 'orderNum'))
  where deleted_at is null and nullif(data ->> 'orderNum', '') is not null;

create unique index if not exists rodios_work_orders_active_issue_uq
  on public.rodios_work_orders (issue_id)
  where deleted_at is null and issue_id is not null;

create index if not exists rodios_issues_updated_idx on public.rodios_issues(updated_at desc);
create index if not exists rodios_work_orders_updated_idx on public.rodios_work_orders(updated_at desc);
create index if not exists rodios_payments_updated_idx on public.rodios_payments(updated_at desc);

create or replace function public.rodios_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'rodios_app_users', 'rodios_settings', 'rodios_service_staff',
    'rodios_issues', 'rodios_work_orders', 'rodios_payments',
    'work_order_acknowledgments'
  ]
  loop
    execute format('drop trigger if exists %I on public.%I', 'touch_updated_at', v_table);
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.rodios_touch_updated_at()',
      'touch_updated_at', v_table
    );
  end loop;
end;
$$;

create or replace function public.rodios_is_active_user(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.rodios_app_users u
    where u.auth_user_id = p_user_id
      and u.deleted_at is null
  );
$$;

create or replace function public.rodios_is_admin(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.rodios_app_users u
    where u.auth_user_id = p_user_id
      and u.deleted_at is null
      and (
        u.id = 'admin'
        or lower(coalesce(u.data ->> 'tier', '')) = 'admin'
        or lower(coalesce(u.data ->> 'role', '')) = 'administrator'
      )
  );
$$;

create or replace function public.rodios_can_manage_settings(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.rodios_app_users u
    where u.auth_user_id = p_user_id
      and u.deleted_at is null
      and (
        u.id = 'admin'
        or lower(coalesce(u.data ->> 'tier', '')) in ('admin', 'manager')
      )
  );
$$;

revoke all on function public.rodios_is_active_user(uuid) from public;
revoke all on function public.rodios_is_admin(uuid) from public;
revoke all on function public.rodios_can_manage_settings(uuid) from public;
grant execute on function public.rodios_is_active_user(uuid) to authenticated, service_role;
grant execute on function public.rodios_is_admin(uuid) to authenticated, service_role;
grant execute on function public.rodios_can_manage_settings(uuid) to authenticated, service_role;

alter table public.rodios_app_users enable row level security;
alter table public.rodios_settings enable row level security;
alter table public.rodios_service_staff enable row level security;
alter table public.rodios_issues enable row level security;
alter table public.rodios_work_orders enable row level security;
alter table public.rodios_payments enable row level security;
alter table public.work_order_acknowledgments enable row level security;
alter table public.rodios_protocols enable row level security;
alter table public.rodios_storage_cleanup_queue enable row level security;

do $$
declare
  v_table text;
  v_policy text;
begin
  foreach v_table in array array[
    'rodios_app_users', 'rodios_settings', 'rodios_service_staff',
    'rodios_issues', 'rodios_work_orders', 'rodios_payments',
    'work_order_acknowledgments', 'rodios_protocols', 'rodios_storage_cleanup_queue'
  ]
  loop
    foreach v_policy in array array['active_select','active_insert','active_update','admin_delete','manager_write']
    loop
      execute format('drop policy if exists %I on public.%I', v_policy, v_table);
    end loop;
  end loop;
end;
$$;

create policy active_select on public.rodios_app_users
  for select to authenticated using (public.rodios_is_active_user());
create policy manager_write on public.rodios_app_users
  for all to authenticated
  using (public.rodios_is_admin())
  with check (public.rodios_is_admin());
create policy admin_delete on public.rodios_app_users
  for delete to authenticated using (public.rodios_is_admin());

create policy active_select on public.rodios_settings
  for select to authenticated using (public.rodios_is_active_user());
create policy manager_write on public.rodios_settings
  for all to authenticated
  using (public.rodios_can_manage_settings())
  with check (public.rodios_can_manage_settings());

create policy active_select on public.rodios_service_staff
  for select to authenticated using (public.rodios_is_active_user());
create policy manager_write on public.rodios_service_staff
  for all to authenticated
  using (public.rodios_can_manage_settings())
  with check (public.rodios_can_manage_settings());

create policy active_select on public.rodios_issues
  for select to authenticated using (public.rodios_is_active_user());
create policy active_insert on public.rodios_issues
  for insert to authenticated with check (public.rodios_is_active_user());
create policy active_update on public.rodios_issues
  for update to authenticated
  using (public.rodios_is_active_user()) with check (public.rodios_is_active_user());
create policy admin_delete on public.rodios_issues
  for delete to authenticated using (public.rodios_is_admin());

create policy active_select on public.rodios_work_orders
  for select to authenticated using (public.rodios_is_active_user());
create policy active_insert on public.rodios_work_orders
  for insert to authenticated with check (public.rodios_is_active_user());
create policy active_update on public.rodios_work_orders
  for update to authenticated
  using (public.rodios_is_active_user()) with check (public.rodios_is_active_user());
create policy admin_delete on public.rodios_work_orders
  for delete to authenticated using (public.rodios_is_admin());

create policy active_select on public.rodios_payments
  for select to authenticated using (public.rodios_is_active_user());
create policy active_insert on public.rodios_payments
  for insert to authenticated with check (public.rodios_is_active_user());
create policy active_update on public.rodios_payments
  for update to authenticated
  using (public.rodios_is_active_user()) with check (public.rodios_is_active_user());
create policy admin_delete on public.rodios_payments
  for delete to authenticated using (public.rodios_is_admin());

create policy active_select on public.work_order_acknowledgments
  for select to authenticated using (public.rodios_is_active_user());
create policy active_insert on public.work_order_acknowledgments
  for insert to authenticated with check (public.rodios_is_active_user());
create policy active_update on public.work_order_acknowledgments
  for update to authenticated
  using (public.rodios_is_active_user()) with check (public.rodios_is_active_user());
create policy admin_delete on public.work_order_acknowledgments
  for delete to authenticated using (public.rodios_is_admin());

create policy active_select on public.rodios_protocols
  for select to authenticated using (public.rodios_is_active_user());
create policy admin_delete on public.rodios_protocols
  for delete to authenticated using (public.rodios_is_admin());

revoke all on table public.rodios_app_users from anon;
revoke all on table public.rodios_settings from anon;
revoke all on table public.rodios_service_staff from anon;
revoke all on table public.rodios_issues from anon;
revoke all on table public.rodios_work_orders from anon;
revoke all on table public.rodios_payments from anon;
revoke all on table public.work_order_acknowledgments from anon;
revoke all on table public.rodios_protocols from anon;
revoke all on table public.rodios_storage_cleanup_queue from anon, authenticated;

grant select, insert, update on public.rodios_app_users to authenticated;
grant select, insert, update, delete on public.rodios_settings to authenticated;
grant select, insert, update, delete on public.rodios_service_staff to authenticated;
grant select, update on public.rodios_issues to authenticated;
grant select, update on public.rodios_work_orders to authenticated;
grant select, insert, update, delete on public.rodios_payments to authenticated;
grant select, insert, update on public.work_order_acknowledgments to authenticated;
grant select on public.rodios_protocols to authenticated;

-- Οι παρακάτω διαγραφές γίνονται μόνο από τις ελεγχόμενες SECURITY DEFINER
-- ροές/Edge Functions. Έτσι δεν μπορεί ένα γενικό frontend sync να παρακάμψει
-- το cascade, την αποδέσμευση αιτήματος ή τον καθαρισμό του Storage.
revoke delete on public.rodios_app_users from authenticated;
revoke insert on public.rodios_issues from authenticated;
revoke insert on public.rodios_work_orders from authenticated;
revoke delete on public.rodios_issues from authenticated;
revoke delete on public.rodios_work_orders from authenticated;
revoke delete on public.work_order_acknowledgments from authenticated;
revoke delete on public.rodios_protocols from authenticated;
grant all on public.rodios_app_users, public.rodios_settings, public.rodios_service_staff,
  public.rodios_issues, public.rodios_work_orders, public.rodios_payments,
  public.work_order_acknowledgments, public.rodios_protocols,
  public.rodios_storage_cleanup_queue to service_role;

create or replace view public.rodios_v9_counts
with (security_invoker = true)
as
  select 'issues'::text as table_name, count(*)::bigint as total
  from public.rodios_issues where deleted_at is null
  union all
  select 'work_orders', count(*) from public.rodios_work_orders where deleted_at is null
  union all
  select 'payments', count(*) from public.rodios_payments where deleted_at is null;

grant select on public.rodios_v9_counts to authenticated;

commit;

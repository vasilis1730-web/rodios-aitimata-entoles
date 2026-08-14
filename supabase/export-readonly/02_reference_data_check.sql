-- ΡΟΔΙΟΣ — ΑΝΑΓΝΩΣΤΙΚΟΣ ΕΛΕΓΧΟΣ ΕΞΑΓΩΓΗΣ
-- Περιέχει μόνο SELECT/CTE. Δεν μεταβάλλει κανένα δεδομένο.

with checks as (
  select 1 as sort_order, 'active_app_users'::text as check_name,
         count(*)::text as value
  from public.rodios_app_users
  where deleted_at is null

  union all

  select 2, 'active_service_staff', count(*)::text
  from public.rodios_service_staff
  where deleted_at is null

  union all

  select 3, 'settings_rows', count(*)::text
  from public.rodios_settings

  union all

  select 4, 'configured_committee_names', count(*)::text
  from public.rodios_settings s
  cross join lateral jsonb_array_elements(
    case
      when jsonb_typeof(s.value -> 'eSignUsers') = 'array' then s.value -> 'eSignUsers'
      else '[]'::jsonb
    end
  ) member
  where s.key = 'main'
    and nullif(trim(member ->> 'name'), '') is not null

  union all

  select 5, 'operational_issues_not_exported', count(*)::text
  from public.rodios_issues
  where deleted_at is null

  union all

  select 6, 'operational_work_orders_not_exported', count(*)::text
  from public.rodios_work_orders
  where deleted_at is null

  union all

  select 7, 'operational_payments_not_exported', count(*)::text
  from public.rodios_payments
  where deleted_at is null
)
select check_name, value
from checks
order by sort_order;

-- Τα τρία ονόματα που θα χρησιμοποιηθούν στον νέο απλό έλεγχο πρωτοκόλλου.
select
  member_number,
  member ->> 'name' as committee_name,
  member ->> 'role' as committee_role,
  member ->> 'username' as committee_username
from public.rodios_settings s
cross join lateral jsonb_array_elements(
  case
    when jsonb_typeof(s.value -> 'eSignUsers') = 'array' then s.value -> 'eSignUsers'
    else '[]'::jsonb
  end
) with ordinality as committee(member, member_number)
where s.key = 'main'
order by member_number;


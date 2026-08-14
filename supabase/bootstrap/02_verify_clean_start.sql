-- Τελικός έλεγχος του ΝΕΟΥ Supabase. Δεν αλλάζει δεδομένα.

select 1 as sort_order, 'settings'::text as item, count(*)::bigint as total from public.rodios_settings
union all
select 2, 'active_users', count(*) from public.rodios_app_users where deleted_at is null
union all
select 3, 'active_service_staff', count(*) from public.rodios_service_staff where deleted_at is null
union all
select 10, 'issues_MUST_BE_ZERO', count(*) from public.rodios_issues
union all
select 11, 'work_orders_MUST_BE_ZERO', count(*) from public.rodios_work_orders
union all
select 12, 'payments_MUST_BE_ZERO', count(*) from public.rodios_payments
union all
select 13, 'protocols_MUST_BE_ZERO', count(*) from public.rodios_protocols
union all
select 14, 'acknowledgments_MUST_BE_ZERO', count(*) from public.work_order_acknowledgments
order by sort_order;

select
  member ->> 'name' as committee_name,
  member ->> 'role' as committee_role
from public.rodios_settings s
cross join lateral jsonb_array_elements(coalesce(s.value -> 'eSignUsers', '[]'::jsonb)) member
where s.key = 'main'
order by committee_role, committee_name;

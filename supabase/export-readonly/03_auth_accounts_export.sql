-- ΡΟΔΙΟΣ — ΑΝΑΓΝΩΣΤΙΚΗ ΛΙΣΤΑ ΛΟΓΑΡΙΑΣΜΩΝ ΠΡΟΣ ΕΠΑΝΑΔΗΜΙΟΥΡΓΙΑ
-- Δεν εξάγει κωδικούς, hashes, tokens ή στοιχεία πολιτών.
-- Περιέχει μόνο SELECT/CTE. Δεν μεταβάλλει κανένα δεδομένο.

with active_profiles as (
  select
    p.id as profile_id,
    p.auth_user_id,
    p.data ->> 'name' as full_name,
    p.data ->> 'role' as application_role,
    p.data ->> 'tier' as access_tier,
    lower(trim(p.data ->> 'email')) as email,
    case lower(trim(coalesce(p.data ->> 'canEdit', ''))) when 'true' then true when 'false' then false else true end as can_edit,
    case lower(trim(coalesce(p.data ->> 'canOrders', ''))) when 'true' then true when 'false' then false else true end as can_orders,
    case lower(trim(coalesce(p.data ->> 'canDelete', ''))) when 'true' then true when 'false' then false else false end as can_delete,
    case lower(trim(coalesce(p.data ->> 'canPenalty', ''))) when 'true' then true when 'false' then false else false end as can_penalty
  from public.rodios_app_users p
  where p.deleted_at is null
)
select
  p.profile_id,
  p.full_name,
  p.application_role,
  p.access_tier,
  p.email,
  p.can_edit,
  p.can_orders,
  p.can_delete,
  p.can_penalty,
  (u.id is not null) as old_auth_account_found,
  u.email_confirmed_at,
  u.last_sign_in_at
from active_profiles p
left join auth.users u
  on u.id = p.auth_user_id
  or lower(u.email) = p.email
order by
  case when p.profile_id = 'admin' then 0 else 1 end,
  p.full_name,
  p.email;

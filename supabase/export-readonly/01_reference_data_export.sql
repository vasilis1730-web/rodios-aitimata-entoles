-- ΡΟΔΙΟΣ — ΑΝΑΓΝΩΣΤΙΚΗ ΕΞΑΓΩΓΗ ΔΕΔΟΜΕΝΩΝ ΑΝΑΦΟΡΑΣ
-- Περιέχει μόνο SELECT/CTE. Δεν μεταβάλλει κανένα δεδομένο.
-- Εξαιρούνται κωδικοί, tokens, λειτουργικά δεδομένα και παλιοί μετρητές.

with
active_profiles as (
  select
    p.id,
    p.auth_user_id,
    (
      coalesce(p.data, '{}'::jsonb)
      - 'password'
      - 'pin'
      - 'pwd'
      - 'passwordHash'
      - 'password_hash'
      - 'encrypted_password'
      - 'access_token'
      - 'refresh_token'
    ) as data
  from public.rodios_app_users p
  where p.deleted_at is null
),
profile_emails as (
  select distinct lower(trim(data ->> 'email')) as email
  from active_profiles
  where nullif(trim(data ->> 'email'), '') is not null
),
safe_settings as (
  select
    s.key,
    (
      coalesce(s.value, '{}'::jsonb)
      - 'issueSeq'
      - 'orderSeq'
      - 'edgeFnUrl'
      - 'supabaseUrl'
      - 'supabaseURL'
      - 'supabaseKey'
      - 'supabaseAnonKey'
    ) as value
  from public.rodios_settings s
),
active_staff as (
  select
    s.id,
    coalesce(s.data, '{}'::jsonb) as data
  from public.rodios_service_staff s
  where s.deleted_at is null
),
matched_auth_accounts as (
  select
    u.id,
    lower(u.email) as email,
    u.email_confirmed_at,
    u.created_at,
    u.last_sign_in_at,
    coalesce(u.raw_user_meta_data, '{}'::jsonb) as user_metadata
  from auth.users u
  join profile_emails p on p.email = lower(u.email)
)
select jsonb_pretty(
  jsonb_build_object(
    'format', 'rodios-reference-export-v1',
    'exported_at', now(),
    'settings', coalesce(
      (select jsonb_agg(jsonb_build_object('key', key, 'value', value) order by key) from safe_settings),
      '[]'::jsonb
    ),
    'app_users', coalesce(
      (select jsonb_agg(jsonb_build_object('id', id, 'auth_user_id_old', auth_user_id, 'data', data) order by id) from active_profiles),
      '[]'::jsonb
    ),
    'service_staff', coalesce(
      (select jsonb_agg(jsonb_build_object('id', id, 'data', data) order by id) from active_staff),
      '[]'::jsonb
    ),
    'auth_accounts', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'old_auth_user_id', id,
            'email', email,
            'email_confirmed_at', email_confirmed_at,
            'created_at', created_at,
            'last_sign_in_at', last_sign_in_at,
            'user_metadata', user_metadata
          )
          order by email
        )
        from matched_auth_accounts
      ),
      '[]'::jsonb
    )
  )
) as rodios_reference_export;


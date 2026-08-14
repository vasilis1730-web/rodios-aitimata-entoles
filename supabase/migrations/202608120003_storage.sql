-- Storage της ΝΕΑΣ εγκατάστασης. Εκτελείται μόνο στο ΝΕΟ Supabase.

begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'attachments', 'attachments', true, 52428800,
  array[
    'image/jpeg','image/png','image/webp','application/pdf','video/mp4','video/quicktime',
    'text/plain','application/octet-stream','application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'protocols', 'protocols', false, 20971520,
  array['application/pdf']::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists rodios_attachments_read on storage.objects;
drop policy if exists rodios_attachments_insert on storage.objects;
drop policy if exists rodios_attachments_update on storage.objects;
drop policy if exists rodios_attachments_delete on storage.objects;
drop policy if exists rodios_protocols_read on storage.objects;
drop policy if exists rodios_protocols_delete on storage.objects;

create policy rodios_attachments_read on storage.objects
  for select to authenticated
  using (bucket_id = 'attachments' and public.rodios_is_active_user());

create policy rodios_attachments_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'attachments' and public.rodios_is_active_user());

create policy rodios_attachments_update on storage.objects
  for update to authenticated
  using (bucket_id = 'attachments' and public.rodios_is_active_user())
  with check (bucket_id = 'attachments' and public.rodios_is_active_user());

create policy rodios_attachments_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'attachments' and public.rodios_is_active_user());

create policy rodios_protocols_read on storage.objects
  for select to authenticated
  using (bucket_id = 'protocols' and public.rodios_is_active_user());

-- Τα αποδεκτά πρωτόκολλα αφαιρούνται μόνο από την admin-delete Edge Function
-- με service role, μαζί με την εντολή και όλα τα εξαρτώμενα δεδομένα της.

commit;

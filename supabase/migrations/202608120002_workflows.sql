-- Ατομική αρίθμηση χωρίς κενά, οριστικές διαγραφές και παραλαβή πρωτοκόλλου.
-- Εκτελείται μετά το 202608120001_core.sql, μόνο στο ΝΕΟ Supabase.

begin;

create or replace function public.rodios_safe_numeric(p_value text, p_default numeric default 0)
returns numeric
language sql
immutable
as $$
  select case
    when trim(coalesce(p_value, '')) ~ '^-?[0-9]+([.][0-9]+)?$' then trim(p_value)::numeric
    else p_default
  end;
$$;

create or replace function public.rodios_normalize_person_name(p_name text)
returns text
language sql
immutable
as $$
  select coalesce(string_agg(token, ' ' order by token), '')
  from regexp_split_to_table(
    upper(unaccent(trim(coalesce(p_name, '')))),
    '[^A-ZΑ-Ω0-9]+'
  ) as token
  where token <> '';
$$;

create or replace function public.rodios_next_free_number(p_kind text, p_year integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next integer;
begin
  if p_kind not in ('issue', 'order') then
    raise exception 'invalid numbering kind';
  end if;
  if p_year < 2000 or p_year > 2200 then
    raise exception 'invalid numbering year';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('rodios:' || p_kind || ':' || p_year::text, 0));

  if p_kind = 'issue' then
    select min(candidate)
    into v_next
    from generate_series(
      1,
      coalesce((
        select max((split_part(i.data ->> 'issueNum', '-', 3))::integer)
        from public.rodios_issues i
        where i.deleted_at is null
          and i.data ->> 'issueNum' ~ ('^[^-]+-' || p_year::text || '-[0-9]+$')
      ), 0) + 1
    ) as g(candidate)
    where not exists (
      select 1
      from public.rodios_issues i
      where i.deleted_at is null
        and i.data ->> 'issueNum' = 'ΑΙΤ-' || p_year::text || '-' || lpad(candidate::text, greatest(3, length(candidate::text)), '0')
    );
  else
    select min(candidate)
    into v_next
    from generate_series(
      1,
      coalesce((
        select max((split_part(w.data ->> 'orderNum', '-', 3))::integer)
        from public.rodios_work_orders w
        where w.deleted_at is null
          and w.data ->> 'orderNum' ~ ('^[^-]+-' || p_year::text || '-[0-9]+$')
      ), 0) + 1
    ) as g(candidate)
    where not exists (
      select 1
      from public.rodios_work_orders w
      where w.deleted_at is null
        and w.data ->> 'orderNum' = 'ΕΕ-' || p_year::text || '-' || lpad(candidate::text, greatest(3, length(candidate::text)), '0')
    );
  end if;

  return coalesce(v_next, 1);
end;
$$;

create or replace function public.rodios_protect_operational_number()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_kind text := tg_argv[0];
  v_field text;
  v_prefix text;
  v_value text;
  v_year integer;
  v_number integer;
  v_expected integer;
begin
  if v_kind = 'issue' then
    v_field := 'issueNum';
    v_prefix := 'ΑΙΤ';
  elsif v_kind = 'order' then
    v_field := 'orderNum';
    v_prefix := 'ΕΕ';
  else
    raise exception 'invalid numbering trigger kind';
  end if;

  if new.deleted_at is not null then
    raise exception 'soft deletion is disabled for operational rows';
  end if;

  v_value := new.data ->> v_field;
  if tg_op = 'UPDATE' then
    if v_value is distinct from (old.data ->> v_field) then
      raise exception '% cannot be changed after creation', v_field;
    end if;
    return new;
  end if;

  if coalesce(v_value, '') !~ ('^' || v_prefix || '-[0-9]{4}-[0-9]{3,}$') then
    raise exception 'invalid canonical %', v_field;
  end if;
  v_year := split_part(v_value, '-', 2)::integer;
  v_number := split_part(v_value, '-', 3)::integer;
  v_expected := public.rodios_next_free_number(v_kind, v_year);
  if v_number <> v_expected then
    raise exception 'the next available % number is %', v_kind, v_expected;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_issue_number on public.rodios_issues;
create trigger protect_issue_number
before insert or update on public.rodios_issues
for each row execute function public.rodios_protect_operational_number('issue');

drop trigger if exists protect_order_number on public.rodios_work_orders;
create trigger protect_order_number
before insert or update on public.rodios_work_orders
for each row execute function public.rodios_protect_operational_number('order');

create or replace function public.rodios_protect_protocol_state()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_protected_keys text[] := array[
    'signedPdfData', 'signedPdfUrl', 'signedPdfBucket', 'signedPdfPath',
    'signedPdfName', 'signedAt', '_protocolReady', '_edgeSigCount',
    '_sigExtractedNames', '_edgeResult', 'sigOverride'
  ];
  v_key text;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  if coalesce(new.data ->> 'status', '') = 'Παραλήφθηκε'
     and (tg_op = 'INSERT' or coalesce(old.data ->> 'status', '') <> 'Παραλήφθηκε') then
    raise exception 'acceptance is allowed only through central protocol verification' using errcode = '42501';
  end if;

  foreach v_key in array v_protected_keys
  loop
    if tg_op = 'INSERT' then
      if new.data ? v_key then
        raise exception 'protocol field % is server-managed', v_key using errcode = '42501';
      end if;
    elsif (new.data -> v_key) is distinct from (old.data -> v_key) then
      raise exception 'protocol field % is server-managed', v_key using errcode = '42501';
    end if;
  end loop;

  if tg_op = 'UPDATE'
     and coalesce(old.data ->> 'status', '') = 'Παραλήφθηκε'
     and (
       new.data - 'protocolSentAt' - 'protocolSentTo' - 'contractorAck' - 'lastEmailResult'
     ) is distinct from (
       old.data - 'protocolSentAt' - 'protocolSentTo' - 'contractorAck' - 'lastEmailResult'
     ) then
    raise exception 'accepted work order is immutable' using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists protect_protocol_state on public.rodios_work_orders;
create trigger protect_protocol_state
before insert or update on public.rodios_work_orders
for each row execute function public.rodios_protect_protocol_state();

create or replace function public.rodios_create_issue(p_id text, p_data jsonb)
returns public.rodios_issues
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id text := nullif(trim(coalesce(p_id, '')), '');
  v_data jsonb := coalesce(p_data, '{}'::jsonb);
  v_year integer;
  v_number integer;
  v_row public.rodios_issues;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.rodios_is_active_user(auth.uid()) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_id is null then v_id := 'issue_' || replace(gen_random_uuid()::text, '-', ''); end if;
  if length(v_id) > 160 then raise exception 'invalid issue id'; end if;

  v_year := case
    when coalesce(v_data ->> 'date', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      then left(v_data ->> 'date', 4)::integer
    else extract(year from current_date)::integer
  end;

  v_number := public.rodios_next_free_number('issue', v_year);
  v_data := (v_data - 'issueNum') || jsonb_build_object(
    'id', v_id,
    'issueNum', 'ΑΙΤ-' || v_year::text || '-' || lpad(v_number::text, greatest(3, length(v_number::text)), '0'),
    'createdAt', coalesce(nullif(v_data ->> 'createdAt', ''), now()::text)
  );

  insert into public.rodios_issues(id, data, deleted_at)
  values (v_id, v_data, null)
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.rodios_create_work_order(p_id text, p_issue_id text, p_data jsonb)
returns public.rodios_work_orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id text := nullif(trim(coalesce(p_id, '')), '');
  v_issue_id text := nullif(trim(coalesce(p_issue_id, '')), '');
  v_data jsonb := coalesce(p_data, '{}'::jsonb);
  v_year integer;
  v_number integer;
  v_row public.rodios_work_orders;
begin
  if not public.rodios_is_active_user(auth.uid()) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_id is null then v_id := 'wo_' || replace(gen_random_uuid()::text, '-', ''); end if;
  if length(v_id) > 160 then raise exception 'invalid work-order id'; end if;
  if v_issue_id is not null and not exists (
    select 1 from public.rodios_issues where id = v_issue_id and deleted_at is null
  ) then
    raise exception 'linked issue not found';
  end if;

  v_year := case
    when coalesce(v_data ->> 'date', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      then left(v_data ->> 'date', 4)::integer
    else extract(year from current_date)::integer
  end;

  v_number := public.rodios_next_free_number('order', v_year);
  if coalesce(v_data ->> 'status', '') = 'Παραλήφθηκε' then
    raise exception 'a work order cannot be created as accepted';
  end if;
  v_data := (
    v_data
    - 'orderNum' - 'signedPdfData' - 'signedPdfUrl' - 'signedPdfBucket'
    - 'signedPdfPath' - 'signedPdfName' - 'signedAt' - '_protocolReady'
    - '_edgeSigCount' - '_sigExtractedNames' - '_edgeResult' - 'sigOverride'
  ) || jsonb_build_object(
    'id', v_id,
    'issueId', v_issue_id,
    'orderNum', 'ΕΕ-' || v_year::text || '-' || lpad(v_number::text, greatest(3, length(v_number::text)), '0'),
    'createdAt', coalesce(nullif(v_data ->> 'createdAt', ''), now()::text),
    'issuedAt', coalesce(nullif(v_data ->> 'issuedAt', ''), now()::text)
  );

  insert into public.rodios_work_orders(id, issue_id, data, deleted_at)
  values (v_id, v_issue_id, v_data, null)
  returning * into v_row;

  if v_issue_id is not null then
    update public.rodios_issues
    set data = data || jsonb_build_object('status', 'Συνεχιζόμενο', 'completionDate', '')
    where id = v_issue_id;
  end if;

  return v_row;
end;
$$;

-- Συμβατότητα για προεπισκόπηση μόνο. Η πραγματική δέσμευση γίνεται αποκλειστικά
-- μέσα στα rodios_create_issue / rodios_create_work_order μαζί με το INSERT.
create or replace function public.rodios_next_sequence(p_kind text, p_year integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.rodios_is_active_user(auth.uid()) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return public.rodios_next_free_number(p_kind, p_year);
end;
$$;

create or replace function public.rodios_enqueue_storage(p_bucket text, p_path text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if nullif(trim(coalesce(p_bucket, '')), '') is null
     or nullif(trim(coalesce(p_path, '')), '') is null then
    return null;
  end if;
  insert into public.rodios_storage_cleanup_queue(storage_bucket, storage_path)
  values (trim(p_bucket), trim(p_path))
  on conflict (storage_bucket, storage_path)
  do update set storage_path = excluded.storage_path
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.rodios_delete_work_order(p_order_id text, p_actor_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_order public.rodios_work_orders;
  v_item jsonb;
  v_payment record;
  v_queue_id uuid;
  v_queue_ids uuid[] := array[]::uuid[];
begin
  v_actor := case when coalesce(auth.role(), '') = 'service_role' then p_actor_id else auth.uid() end;
  if v_actor is null or not public.rodios_is_admin(v_actor) then
    raise exception 'administrator required' using errcode = '42501';
  end if;

  select * into v_order
  from public.rodios_work_orders
  where id = p_order_id and deleted_at is null
  for update;
  if not found then raise exception 'work order not found'; end if;

  v_queue_id := public.rodios_enqueue_storage(
    coalesce(nullif(v_order.data ->> 'signedPdfBucket', ''), 'protocols'),
    v_order.data ->> 'signedPdfPath'
  );
  if v_queue_id is not null then v_queue_ids := array_append(v_queue_ids, v_queue_id); end if;

  for v_item in
    select value from jsonb_array_elements(
      coalesce(v_order.data -> 'mediaBefore', '[]'::jsonb) || coalesce(v_order.data -> 'mediaAfter', '[]'::jsonb)
    )
  loop
    v_queue_id := public.rodios_enqueue_storage(
      coalesce(nullif(v_item ->> 'bucket', ''), 'attachments'),
      coalesce(v_item ->> 'path', v_item ->> 'storagePath')
    );
    if v_queue_id is not null then v_queue_ids := array_append(v_queue_ids, v_queue_id); end if;
  end loop;

  for v_item in
    select jsonb_build_object('bucket', p.storage_bucket, 'path', p.storage_path)
    from public.rodios_protocols p
    where p.work_order_id = p_order_id
  loop
    v_queue_id := public.rodios_enqueue_storage(v_item ->> 'bucket', v_item ->> 'path');
    if v_queue_id is not null then v_queue_ids := array_append(v_queue_ids, v_queue_id); end if;
  end loop;

  for v_payment in
    select data from public.rodios_payments where work_order_id = p_order_id
  loop
    v_queue_id := public.rodios_enqueue_storage(
      coalesce(nullif(v_payment.data ->> 'storageBucket', ''), 'attachments'),
      coalesce(v_payment.data ->> 'storagePath', v_payment.data ->> 'path')
    );
    if v_queue_id is not null then v_queue_ids := array_append(v_queue_ids, v_queue_id); end if;
  end loop;

  delete from public.rodios_work_orders where id = p_order_id;

  if v_order.issue_id is not null then
    update public.rodios_issues
    set data = (data - 'completionDate') || jsonb_build_object(
      'status', 'Προς ενέργεια',
      'completionDate', ''
    )
    where id = v_order.issue_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'deletedOrderId', p_order_id,
    'releasedIssueId', v_order.issue_id,
    'cleanup', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', q.id,
        'bucket', q.storage_bucket,
        'path', q.storage_path
      ))
      from public.rodios_storage_cleanup_queue q
      where q.id = any(v_queue_ids)
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.rodios_delete_issue(p_issue_id text, p_actor_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_issue public.rodios_issues;
  v_item jsonb;
  v_queue_id uuid;
  v_queue_ids uuid[] := array[]::uuid[];
begin
  v_actor := case when coalesce(auth.role(), '') = 'service_role' then p_actor_id else auth.uid() end;
  if v_actor is null or not public.rodios_is_admin(v_actor) then
    raise exception 'administrator required' using errcode = '42501';
  end if;

  select * into v_issue
  from public.rodios_issues
  where id = p_issue_id and deleted_at is null
  for update;
  if not found then raise exception 'issue not found'; end if;
  if exists (select 1 from public.rodios_work_orders where issue_id = p_issue_id and deleted_at is null) then
    raise exception 'issue is linked to a work order';
  end if;

  for v_item in select value from jsonb_array_elements(coalesce(v_issue.data -> 'attachments', '[]'::jsonb))
  loop
    if not exists (
      select 1
      from public.rodios_issues other
      cross join lateral jsonb_array_elements(coalesce(other.data -> 'attachments', '[]'::jsonb)) other_item
      where other.id <> p_issue_id
        and other.deleted_at is null
        and coalesce(other_item ->> 'path', other_item ->> 'storagePath') = coalesce(v_item ->> 'path', v_item ->> 'storagePath')
    ) then
      v_queue_id := public.rodios_enqueue_storage(
        coalesce(nullif(v_item ->> 'bucket', ''), 'attachments'),
        coalesce(v_item ->> 'path', v_item ->> 'storagePath')
      );
      if v_queue_id is not null then v_queue_ids := array_append(v_queue_ids, v_queue_id); end if;
    end if;
  end loop;

  delete from public.rodios_issues where id = p_issue_id;

  return jsonb_build_object(
    'ok', true,
    'deletedIssueId', p_issue_id,
    'cleanup', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', q.id,
        'bucket', q.storage_bucket,
        'path', q.storage_path
      ))
      from public.rodios_storage_cleanup_queue q
      where q.id = any(v_queue_ids)
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.rodios_accept_protocol(
  p_order_id text,
  p_actor_id uuid,
  p_bucket text,
  p_path text,
  p_filename text,
  p_signers jsonb,
  p_committee jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.rodios_work_orders;
  v_payment public.rodios_payments;
  v_list_total numeric := 0;
  v_discount numeric := 0;
  v_penalty numeric := 0;
  v_amount numeric := 0;
  v_signer_norm text[];
  v_committee_norm text[];
  v_payment_id text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_actor_id is null or not public.rodios_is_active_user(p_actor_id) then
    raise exception 'active application user required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_signers) <> 'array' or jsonb_array_length(p_signers) <> 3
     or jsonb_typeof(p_committee) <> 'array' or jsonb_array_length(p_committee) <> 3 then
    raise exception 'exactly three signatures and committee names are required';
  end if;

  select array_agg(public.rodios_normalize_person_name(value) order by public.rodios_normalize_person_name(value))
  into v_signer_norm from jsonb_array_elements_text(p_signers);
  select array_agg(public.rodios_normalize_person_name(value) order by public.rodios_normalize_person_name(value))
  into v_committee_norm from jsonb_array_elements_text(p_committee);
  if cardinality(array(select distinct x from unnest(v_signer_norm) x)) <> 3
     or cardinality(array(select distinct x from unnest(v_committee_norm) x)) <> 3
     or v_signer_norm <> v_committee_norm then
    raise exception 'signature names do not match the three committee members';
  end if;

  select * into v_order
  from public.rodios_work_orders
  where id = p_order_id and deleted_at is null
  for update;
  if not found then raise exception 'work order not found'; end if;
  if coalesce(v_order.data ->> 'orderType', 'contractor') = 'service' then
    raise exception 'service work order cannot receive contractor protocol';
  end if;
  if coalesce(v_order.data ->> 'status', '') <> 'Ολοκληρώθηκε - Εκκρεμούν Υπογραφές' then
    raise exception 'work order is not awaiting protocol signatures';
  end if;
  if p_bucket <> 'protocols'
     or nullif(trim(coalesce(p_path, '')), '') is null
     or p_path not like p_order_id || '/%' then
    raise exception 'invalid protocol storage target';
  end if;
  if exists (select 1 from public.rodios_protocols where work_order_id = p_order_id) then
    raise exception 'protocol already accepted';
  end if;

  select coalesce(sum(
    public.rodios_safe_numeric(item ->> 'unitPrice', 0)
    * public.rodios_safe_numeric(item ->> 'qty', 0)
  ), 0)
  into v_list_total
  from jsonb_array_elements(coalesce(v_order.data -> 'items', '[]'::jsonb)) item;
  v_discount := public.rodios_safe_numeric(v_order.data ->> 'discountPct', 0);
  v_penalty := public.rodios_safe_numeric(v_order.data ->> 'penaltyAmount', 0);
  v_amount := greatest(0, round((v_list_total * (1 - v_discount / 100)) - v_penalty, 2));

  update public.rodios_work_orders
  set data = (data
    - 'signedPdfData'
    - 'signedPdfUrl'
    - 'sigOverride'
  ) || jsonb_build_object(
    'status', 'Παραλήφθηκε',
    'completionDate', current_date::text,
    'signedPdfBucket', p_bucket,
    'signedPdfPath', p_path,
    'signedPdfName', p_filename,
    'signedAt', now()::text,
    '_protocolReady', true,
    '_edgeSigCount', 3,
    '_sigExtractedNames', p_signers,
    '_edgeResult', jsonb_build_object(
      'valid', true,
      'verified', null,
      'count', 3,
      'signers', p_signers,
      'message', 'Βρέθηκαν ακριβώς 3 διαφορετικές υπογραφές και τα 3 ονόματα της Επιτροπής.'
    )
  )
  where id = p_order_id
  returning * into v_order;

  if v_order.issue_id is not null then
    update public.rodios_issues
    set data = data || jsonb_build_object('status', 'Ολοκληρωμένο', 'completionDate', current_date::text)
    where id = v_order.issue_id;
  end if;

  insert into public.rodios_protocols(
    work_order_id, storage_bucket, storage_path, filename,
    signature_count, signer_names, committee_names, accepted_by
  ) values (
    p_order_id, p_bucket, p_path, p_filename,
    3, p_signers, p_committee, p_actor_id
  );

  if not exists (
    select 1 from public.rodios_payments p
    where p.work_order_id = p_order_id
      and p.deleted_at is null
      and lower(coalesce(p.data ->> 'isPenalty', 'false')) <> 'true'
  ) then
    v_payment_id := 'pay_' || replace(gen_random_uuid()::text, '-', '');
    insert into public.rodios_payments(id, work_order_id, data, deleted_at)
    values (
      v_payment_id,
      p_order_id,
      jsonb_build_object(
        'id', v_payment_id,
        'date', current_date::text,
        'amount', v_amount,
        'orderId', p_order_id,
        'invoiceNum', '',
        'month', to_char(current_date, 'YYYY-MM'),
        'notes', 'Παραλαβή εντολής ' || coalesce(v_order.data ->> 'orderNum', ''),
        'isPenalty', false,
        'autoCreated', true
      ),
      null
    )
    returning * into v_payment;
  end if;

  return jsonb_build_object(
    'ok', true,
    'order', to_jsonb(v_order),
    'payment', case when v_payment.id is null then null else to_jsonb(v_payment) end
  );
end;
$$;

create or replace function public.complete_work_order_ack(p_token text)
returns table(success boolean, order_num text, acknowledged_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ack public.work_order_acknowledgments;
begin
  update public.work_order_acknowledgments a
  set acknowledged_at = coalesce(a.acknowledged_at, now()),
      manual_ack = false
  where a.ack_token = p_token
  returning a.* into v_ack;

  if not found then
    return query select false, null::text, null::timestamptz;
    return;
  end if;

  update public.rodios_work_orders w
  set data = w.data || jsonb_build_object(
    'contractorAck', jsonb_build_object(
      'timestamp', v_ack.acknowledged_at,
      'manual', false,
      'by', 'contractor'
    )
  )
  where w.id = v_ack.work_order_id;

  return query select true, v_ack.order_num, v_ack.acknowledged_at;
end;
$$;

revoke all on function public.rodios_safe_numeric(text, numeric) from public;
revoke all on function public.rodios_normalize_person_name(text) from public;
revoke all on function public.rodios_next_free_number(text, integer) from public;
revoke all on function public.rodios_protect_operational_number() from public;
revoke all on function public.rodios_protect_protocol_state() from public;
revoke all on function public.rodios_create_issue(text, jsonb) from public;
revoke all on function public.rodios_create_work_order(text, text, jsonb) from public;
revoke all on function public.rodios_next_sequence(text, integer) from public;
revoke all on function public.rodios_enqueue_storage(text, text) from public;
revoke all on function public.rodios_delete_work_order(text, uuid) from public;
revoke all on function public.rodios_delete_issue(text, uuid) from public;
revoke all on function public.rodios_accept_protocol(text, uuid, text, text, text, jsonb, jsonb) from public;
revoke all on function public.complete_work_order_ack(text) from public;

grant execute on function public.rodios_create_issue(text, jsonb) to authenticated, service_role;
grant execute on function public.rodios_create_work_order(text, text, jsonb) to authenticated;
grant execute on function public.rodios_next_sequence(text, integer) to authenticated;
grant execute on function public.rodios_delete_work_order(text, uuid) to authenticated, service_role;
grant execute on function public.rodios_delete_issue(text, uuid) to authenticated, service_role;
grant execute on function public.rodios_accept_protocol(text, uuid, text, text, text, jsonb, jsonb) to service_role;
grant execute on function public.complete_work_order_ack(text) to anon, authenticated, service_role;

commit;

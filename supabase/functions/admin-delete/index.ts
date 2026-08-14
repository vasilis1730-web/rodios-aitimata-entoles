import {createClient} from 'npm:@supabase/supabase-js@2';
import {getSupabasePublicKey, getSupabaseSecretKey, handleOptions, json} from '../_shared/http.ts';

type CleanupItem = {id: string; bucket: string; path: string};

Deno.serve(async (req: Request) => {
  const options = handleOptions(req);
  if(options) return options;
  if(req.method !== 'POST') return json({ok: false, error: 'method_not_allowed'}, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const anonKey = getSupabasePublicKey();
  const serviceKey = getSupabaseSecretKey();
  if(!supabaseUrl || !anonKey || !serviceKey) return json({ok: false, error: 'server_not_configured'}, 500);

  const authorization = req.headers.get('Authorization') || '';
  const token = authorization.replace(/^Bearer\s+/i, '').trim();
  if(!token) return json({ok: false, error: 'missing_session'}, 401);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: {headers: {Authorization: `Bearer ${token}`}},
    auth: {persistSession: false, autoRefreshToken: false}
  });
  const {data: userData, error: userError} = await userClient.auth.getUser(token);
  const user = userData?.user;
  if(userError || !user) return json({ok: false, error: 'invalid_session'}, 401);

  const service = createClient(supabaseUrl, serviceKey, {
    auth: {persistSession: false, autoRefreshToken: false}
  });
  const {data: profile, error: profileError} = await service
    .from('rodios_app_users')
    .select('id,data')
    .eq('auth_user_id', user.id)
    .is('deleted_at', null)
    .maybeSingle();
  const tier = String(profile?.data?.tier || '').toLowerCase();
  const role = String(profile?.data?.role || '').toLowerCase();
  if(profileError || !profile || !(profile.id === 'admin' || tier === 'admin' || role === 'administrator')) {
    return json({ok: false, error: 'administrator_required'}, 403);
  }

  let body: {kind?: string; id?: string};
  try { body = await req.json(); }
  catch { return json({ok: false, error: 'invalid_json'}, 400); }
  const id = String(body.id || '').trim();
  if(!id) return json({ok: false, error: 'missing_id'}, 400);

  const rpcName = body.kind === 'issue'
    ? 'rodios_delete_issue'
    : body.kind === 'work_order'
      ? 'rodios_delete_work_order'
      : '';
  if(!rpcName) return json({ok: false, error: 'invalid_kind'}, 400);

  const rpcArgs = body.kind === 'issue'
    ? {p_issue_id: id, p_actor_id: user.id}
    : {p_order_id: id, p_actor_id: user.id};
  const {data: deleted, error: deleteError} = await service.rpc(rpcName, rpcArgs);
  if(deleteError) return json({ok: false, error: deleteError.message}, 409);

  // Καθαρίζει και τυχόν παλιότερες εκκρεμότητες. Αν κάποιο Storage delete
  // αποτύχει, η ουρά μένει ώστε η επόμενη διαγραφή να το ξαναδοκιμάσει.
  const {data: queued, error: queueError} = await service
    .from('rodios_storage_cleanup_queue')
    .select('id,storage_bucket,storage_path')
    .order('created_at', {ascending: true})
    .limit(200);
  if(queueError) return json({ok: true, deleted, cleanupPending: 1, warning: queueError.message}, 202);

  const items: CleanupItem[] = (queued || []).map(row => ({
    id: String(row.id),
    bucket: String(row.storage_bucket || ''),
    path: String(row.storage_path || '')
  })).filter(item => item.bucket && item.path);
  const byBucket = new Map<string, CleanupItem[]>();
  for(const item of items) byBucket.set(item.bucket, [...(byBucket.get(item.bucket) || []), item]);

  const cleanedIds: string[] = [];
  const failures: string[] = [];
  for(const [bucket, bucketItems] of byBucket.entries()) {
    const {error} = await service.storage.from(bucket).remove(bucketItems.map(item => item.path));
    if(error) failures.push(`${bucket}: ${error.message}`);
    else cleanedIds.push(...bucketItems.map(item => item.id));
  }
  if(cleanedIds.length) {
    const {error} = await service.from('rodios_storage_cleanup_queue').delete().in('id', cleanedIds);
    if(error) failures.push(`queue: ${error.message}`);
  }

  const cleanupPending = Math.max(0, items.length - cleanedIds.length);
  return json({
    ok: true,
    deleted,
    cleanupPending,
    warning: failures.length ? failures.join(' | ') : null
  }, cleanupPending ? 202 : 200);
});

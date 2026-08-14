import {createClient} from 'npm:@supabase/supabase-js@2';
import {getSupabasePublicKey, getSupabaseSecretKey, handleOptions, json} from '../_shared/http.ts';

function cleanProfile(value: Record<string, unknown>, authUserId: string): Record<string, unknown> {
  const tier = String(value.tier || '').toLowerCase() === 'manager' ? 'manager' : 'user';
  return {
    id: String(value.id || ''),
    authUserId,
    name: String(value.name || '').slice(0, 200),
    role: String(value.role || '').slice(0, 200),
    email: String(value.email || '').trim().toLowerCase(),
    username: String(value.username || '').slice(0, 100),
    color: String(value.color || '#2d4a8a').slice(0, 30),
    initials: String(value.initials || '').slice(0, 6),
    tier,
    canEdit: true,
    canOrders: true,
    canPenalty: true,
    canDelete: false
  };
}

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
  const actor = userData?.user;
  if(userError || !actor) return json({ok: false, error: 'invalid_session'}, 401);

  const service = createClient(supabaseUrl, serviceKey, {auth: {persistSession: false, autoRefreshToken: false}});
  const {data: actorProfile} = await service.from('rodios_app_users').select('id,data')
    .eq('auth_user_id', actor.id).is('deleted_at', null).maybeSingle();
  const actorTier = String(actorProfile?.data?.tier || '').toLowerCase();
  if(!actorProfile || !(actorProfile.id === 'admin' || actorTier === 'admin')) return json({ok: false, error: 'administrator_required'}, 403);

  let body: {action?: string; profile?: Record<string, unknown>; password?: string; oldEmail?: string};
  try { body = await req.json(); }
  catch { return json({ok: false, error: 'invalid_json'}, 400); }
  const action = String(body.action || '');
  const supplied = body.profile && typeof body.profile === 'object' ? body.profile : {};
  const profileId = String(supplied.id || '').trim();
  const email = String(supplied.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if(!profileId || profileId === 'admin') return json({ok: false, error: 'protected_or_invalid_profile'}, 400);

  if(action === 'create') {
    if(!email.includes('@') || password.length < 6) return json({ok: false, error: 'valid_email_and_password_required'}, 400);
    const {data: created, error: createError} = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {name: String(supplied.name || ''), app_profile_id: profileId}
    });
    if(createError || !created.user) return json({ok: false, error: createError?.message || 'auth_create_failed'}, 409);
    const data = cleanProfile(supplied, created.user.id);
    const {error: profileError} = await service.from('rodios_app_users').insert({
      id: profileId,
      auth_user_id: created.user.id,
      data,
      deleted_at: null
    });
    if(profileError) {
      await service.auth.admin.deleteUser(created.user.id);
      return json({ok: false, error: profileError.message}, 409);
    }
    return json({ok: true, id: profileId, authUserId: created.user.id});
  }

  const {data: existing, error: existingError} = await service.from('rodios_app_users')
    .select('id,auth_user_id,data').eq('id', profileId).is('deleted_at', null).maybeSingle();
  if(existingError || !existing || !existing.auth_user_id) return json({ok: false, error: 'profile_not_found'}, 404);
  const authUserId = String(existing.auth_user_id);

  if(action === 'update') {
    if(!email.includes('@')) return json({ok: false, error: 'valid_email_required'}, 400);
    const attributes: {email: string; password?: string; email_confirm: boolean; user_metadata: Record<string, unknown>} = {
      email,
      email_confirm: true,
      user_metadata: {name: String(supplied.name || ''), app_profile_id: profileId}
    };
    if(password) {
      if(password.length < 6) return json({ok: false, error: 'password_too_short'}, 400);
      attributes.password = password;
    }
    const {error: authError} = await service.auth.admin.updateUserById(authUserId, attributes);
    if(authError) return json({ok: false, error: authError.message}, 409);
    const data = cleanProfile(supplied, authUserId);
    const {error: updateError} = await service.from('rodios_app_users').update({data, auth_user_id: authUserId}).eq('id', profileId);
    if(updateError) return json({ok: false, error: updateError.message}, 500);
    return json({ok: true, id: profileId, authUserId});
  }

  if(action === 'delete') {
    const {error: authError} = await service.auth.admin.deleteUser(authUserId);
    if(authError) return json({ok: false, error: authError.message}, 409);
    const {error: deleteError} = await service.from('rodios_app_users').delete().eq('id', profileId);
    if(deleteError) return json({ok: false, error: deleteError.message}, 500);
    return json({ok: true, id: profileId});
  }

  return json({ok: false, error: 'unknown_action'}, 400);
});

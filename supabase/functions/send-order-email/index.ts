import {createClient} from 'npm:@supabase/supabase-js@2';
import {getSupabasePublicKey, getSupabaseSecretKey, handleOptions, json} from '../_shared/http.ts';

type Attachment = {name?: string; url?: string; type?: string};

Deno.serve(async (req: Request) => {
  const options = handleOptions(req);
  if(options) return options;
  if(req.method !== 'POST') return json({ok: false, error: 'method_not_allowed'}, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const anonKey = getSupabasePublicKey();
  const serviceKey = getSupabaseSecretKey();
  const resendKey = Deno.env.get('RESEND_API_KEY') || '';
  const mailFrom = Deno.env.get('MAIL_FROM') || '';
  if(!supabaseUrl || !anonKey || !serviceKey) return json({ok: false, error: 'server_not_configured'}, 500);
  if(!resendKey || !mailFrom) return json({ok: false, error: 'Λείπουν τα secrets RESEND_API_KEY ή MAIL_FROM.'}, 500);

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

  const service = createClient(supabaseUrl, serviceKey, {auth: {persistSession: false, autoRefreshToken: false}});
  const [{data: profile}, {data: settingsRow}] = await Promise.all([
    service.from('rodios_app_users').select('id').eq('auth_user_id', user.id).is('deleted_at', null).maybeSingle(),
    service.from('rodios_settings').select('value').eq('key', 'main').maybeSingle()
  ]);
  if(!profile) return json({ok: false, error: 'inactive_application_user'}, 403);
  const contractorEmail = String(settingsRow?.value?.contractorEmail || '').trim().toLowerCase();
  if(!contractorEmail) return json({ok: false, error: 'Δεν έχει οριστεί email αναδόχου στις Ρυθμίσεις.'}, 409);

  let body: {to?: string; subject?: string; body?: string; attachments?: Attachment[]};
  try { body = await req.json(); }
  catch { return json({ok: false, error: 'invalid_json'}, 400); }
  const to = String(body.to || '').trim().toLowerCase();
  const subject = String(body.subject || '').trim().slice(0, 300);
  const textBody = String(body.body || '').slice(0, 100_000);
  if(to !== contractorEmail) return json({ok: false, error: 'recipient_must_match_configured_contractor'}, 403);
  if(!subject || !textBody) return json({ok: false, error: 'missing_subject_or_body'}, 400);

  const allowedOrigin = new URL(supabaseUrl).origin;
  const attachments = (Array.isArray(body.attachments) ? body.attachments : []).slice(0, 12).flatMap(item => {
    try {
      const url = new URL(String(item?.url || ''));
      if(url.origin !== allowedOrigin) return [];
      return [{
        filename: String(item?.name || 'attachment').replace(/[\r\n]/g, '').slice(0, 180),
        path: url.toString()
      }];
    } catch { return []; }
  });

  const resendResponse = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: mailFrom,
      to: [contractorEmail],
      subject,
      text: textBody,
      attachments
    })
  });
  const raw = await resendResponse.text();
  let result: Record<string, unknown> = {};
  try { result = raw ? JSON.parse(raw) : {}; } catch { result = {message: raw}; }
  if(!resendResponse.ok) return json({ok: false, error: String(result.message || raw || `HTTP ${resendResponse.status}`)}, 502);

  return json({ok: true, id: result.id || null, attached: attachments.length, skipped: Math.max(0, (body.attachments?.length || 0) - attachments.length)});
});

import {createClient} from 'npm:@supabase/supabase-js@2';
import {decodeProtectedHeader, importX509, jwtVerify, type JWTPayload} from 'npm:jose@6';
import {getSupabaseSecretKey, handleOptions, json} from '../_shared/http.ts';

const FIREBASE_PROJECT_ID = Deno.env.get('FIREBASE_PROJECT_ID') || 'dimosrodou-otp';
const FIREBASE_CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const ALLOWED_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'video/mp4', 'video/quicktime',
  'text/plain', 'application/octet-stream', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
]);

type FirebaseClaims = JWTPayload & {phone_number?: string; auth_time?: number};

async function verifyFirebaseToken(token: string): Promise<FirebaseClaims> {
  const header = decodeProtectedHeader(token);
  if(header.alg !== 'RS256' || !header.kid) throw new Error('invalid_token_header');
  const response = await fetch(FIREBASE_CERTS_URL);
  if(!response.ok) throw new Error('firebase_keys_unavailable');
  const certificates = await response.json() as Record<string, string>;
  const certificate = certificates[header.kid];
  if(!certificate) throw new Error('unknown_token_key');
  const key = await importX509(certificate, 'RS256');
  const {payload} = await jwtVerify(token, key, {
    algorithms: ['RS256'],
    audience: FIREBASE_PROJECT_ID,
    issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`
  });
  const now = Math.floor(Date.now() / 1000);
  if(!payload.sub || !payload.iat || payload.iat > now) throw new Error('invalid_token_payload');
  const claims = payload as FirebaseClaims;
  if(!claims.auth_time || claims.auth_time > now) throw new Error('invalid_auth_time');
  if(!claims.phone_number) throw new Error('phone_number_missing');
  return claims;
}

function safeName(value: string): string {
  return String(value || 'file').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-100) || 'file';
}

function rhodesLocalDateTime(value = new Date()): {date: string; time: string} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Athens',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(value);
  const get = (type: string) => parts.find(part => part.type === type)?.value || '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`
  };
}

function cleanAttachments(value: unknown, uid: string): Array<Record<string, unknown>> {
  if(!Array.isArray(value)) return [];
  return value.slice(0, 12).flatMap(item => {
    if(!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const path = String(row.path || '');
    if(!path.startsWith(`citizen/${uid}/`)) return [];
    return [{
      name: String(row.name || '').slice(0, 160),
      type: String(row.type || '').slice(0, 100),
      size: Number(row.size || 0),
      path,
      url: String(row.url || '').slice(0, 1000),
      bucket: 'attachments'
    }];
  });
}

// Η συγκατάθεση του πολίτη για απάντηση, καθαρισμένη στον διακομιστή.
// Ο browser δεν μπορεί να δηλώσει κανάλι που δεν αναγνωρίζουμε, ούτε να
// περάσει email χωρίς να έχει ζητήσει ρητά απάντηση μέσω email.
const REPLY_CHANNELS = ['email', 'viber', 'whatsapp'] as const;

function cleanReplyPreference(supplied: Record<string, unknown>): {
  optIn: boolean; channels: string[]; email: string;
} {
  const optIn = supplied.replyOptIn === true;
  if(!optIn) return {optIn: false, channels: [], email: ''};

  const raw = Array.isArray(supplied.replyChannels) ? supplied.replyChannels : [];
  const channels = REPLY_CHANNELS.filter(c => raw.includes(c));

  let email = '';
  if(channels.includes('email')) {
    const candidate = String(supplied.citizenEmail || '').trim().toLowerCase().slice(0, 254);
    if(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(candidate)) email = candidate;
  }
  // Ζητήθηκε email αλλά δεν δόθηκε έγκυρο -> το κανάλι πέφτει.
  const final = email ? channels : channels.filter(c => c !== 'email');
  return {optIn: final.length > 0, channels: final, email};
}

Deno.serve(async (req: Request) => {
  const options = handleOptions(req);
  if(options) return options;
  if(req.method !== 'POST') return json({ok: false, error: 'method_not_allowed'}, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceKey = getSupabaseSecretKey();
  if(!supabaseUrl || !serviceKey) return json({ok: false, error: 'server_not_configured'}, 500);

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return json({ok: false, error: 'invalid_json'}, 400); }

  let claims: FirebaseClaims;
  try { claims = await verifyFirebaseToken(String(body.idToken || '')); }
  catch(error) { return json({ok: false, error: error instanceof Error ? error.message : 'invalid_firebase_token'}, 401); }
  const uid = String(claims.sub);
  const phone = String(claims.phone_number);
  const action = String(body.action || '');
  const service = createClient(supabaseUrl, serviceKey, {auth: {persistSession: false, autoRefreshToken: false}});

  if(action === 'create-upload') {
    const contentType = String(body.contentType || '').toLowerCase();
    const size = Number(body.size || 0);
    if(!ALLOWED_TYPES.has(contentType)) return json({ok: false, error: 'file_type_not_allowed'}, 415);
    if(!Number.isFinite(size) || size < 1 || size > 50 * 1024 * 1024) return json({ok: false, error: 'file_too_large'}, 413);
    const path = `citizen/${uid}/${Date.now()}_${crypto.randomUUID().slice(0, 8)}_${safeName(String(body.fileName || 'file'))}`;
    const {data, error} = await service.storage.from('attachments').createSignedUploadUrl(path);
    if(error || !data) return json({ok: false, error: error?.message || 'upload_ticket_failed'}, 500);
    return json({ok: true, path: data.path, token: data.token});
  }

  if(action === 'submit') {
    const supplied = (body.issue && typeof body.issue === 'object') ? body.issue as Record<string, unknown> : {};
    const reply = cleanReplyPreference(supplied);
    const id = `cit_${crypto.randomUUID().replaceAll('-', '')}`;
    const now = new Date();
    const local = rhodesLocalDateTime(now);
    const issue = {
      id,
      citizenRef: String(supplied.citizenRef || '').slice(0, 20),
      modifiesRef: supplied.modifiesRef ? String(supplied.modifiesRef).slice(0, 20) : null,
      createdAt: now.toISOString(),
      createdByUid: uid,
      source: 'citizen',
      date: local.date,
      time: local.time,
      receiptMethod: 'Αίτημα Πολίτη',
      citizenName: String(supplied.citizenName || '').slice(0, 160),
      citizenAddr: '',
      citizenMobile: phone,
      citizenPhone: phone,
      citizenEmail: reply.email,
      replyOptIn: reply.optIn,
      replyChannels: reply.channels,
      replies: [],
      contactInfo: `📱 ${phone}`,
      location: String(supplied.location || '').slice(0, 500),
      municipality: String(supplied.municipality || '').slice(0, 160),
      category: String(supplied.category || '').slice(0, 160),
      title: String(supplied.title || '').slice(0, 240),
      description: String(supplied.description || '').slice(0, 8000),
      priority: '',
      danger: 'Όχι',
      inspection: 'Όχι',
      status: 'Προς ενέργεια',
      notes: '',
      municipalNum: '',
      mapLat: supplied.mapLat ?? null,
      mapLng: supplied.mapLng ?? null,
      attachments: cleanAttachments(supplied.attachments, uid),
      completionDate: ''
    };
    if(!issue.citizenName || !issue.location || !issue.municipality || !issue.category || !issue.title || !issue.description) {
      return json({ok: false, error: 'required_fields_missing'}, 400);
    }
    const {data, error} = await service.rpc('rodios_create_issue', {p_id: id, p_data: issue});
    if(error || !data) return json({ok: false, error: error?.message || 'issue_create_failed'}, 409);
    return json({ok: true, issue: {...(data.data || {}), id: data.id}});
  }

  if(action === 'list') {
    const {data, error} = await service.from('rodios_issues')
      .select('id,data,updated_at')
      .eq('data->>createdByUid', uid)
      .is('deleted_at', null)
      .order('created_at', {ascending: true});
    if(error) return json({ok: false, error: error.message}, 500);
    return json({ok: true, issues: (data || []).map(row => ({...(row.data || {}), id: row.id}))});
  }

  if(action === 'update') {
    const supplied = (body.issue && typeof body.issue === 'object') ? body.issue as Record<string, unknown> : {};
    const id = String(supplied.id || '').trim();
    if(!id) return json({ok: false, error: 'missing_issue_id'}, 400);
    const {data: row, error: readError} = await service.from('rodios_issues').select('id,data,created_at')
      .eq('id', id).is('deleted_at', null).maybeSingle();
    if(readError || !row || String(row.data?.createdByUid || '') !== uid) return json({ok: false, error: 'issue_not_found'}, 404);
    const createdMs = new Date(String(row.data?.createdAt || row.created_at)).getTime();
    if(!Number.isFinite(createdMs) || Date.now() - createdMs > 10 * 60 * 1000) return json({ok: false, error: 'modify_window_expired'}, 409);
    const updated = {
      ...(row.data || {}),
      citizenName: String(supplied.citizenName || '').slice(0, 160),
      municipality: String(supplied.municipality || '').slice(0, 160),
      category: String(supplied.category || '').slice(0, 160),
      title: String(supplied.title || '').slice(0, 240),
      location: String(supplied.location || '').slice(0, 500),
      description: String(supplied.description || '').slice(0, 8000),
      mapLat: supplied.mapLat ?? null,
      mapLng: supplied.mapLng ?? null,
      attachments: cleanAttachments(supplied.attachments, uid),
      ...(() => {
        const r = cleanReplyPreference(supplied);
        return {citizenEmail: r.email, replyOptIn: r.optIn, replyChannels: r.channels};
      })(),
      lastModifiedAt: new Date().toISOString()
    };
    const {data, error} = await service.from('rodios_issues').update({data: updated}).eq('id', id).select('id,data').single();
    if(error || !data) return json({ok: false, error: error?.message || 'issue_update_failed'}, 500);
    return json({ok: true, issue: {...(data.data || {}), id: data.id}});
  }

  return json({ok: false, error: 'unknown_action'}, 400);
});

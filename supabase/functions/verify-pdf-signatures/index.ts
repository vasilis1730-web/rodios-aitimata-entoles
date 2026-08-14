import {createClient} from 'npm:@supabase/supabase-js@2';
import * as asn1js from 'npm:asn1js@3.0.6';
import {ContentInfo, SignedData} from 'npm:pkijs@3.2.5';
import {getSupabasePublicKey, getSupabaseSecretKey, handleOptions, json} from '../_shared/http.ts';

type PdfSignature = {
  byteRange: string;
  contents: Uint8Array;
  names: string[];
};

function normalizeName(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-ZΑ-Ω0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

function decodeBase64(value: string): Uint8Array {
  const raw = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value;
  const binary = atob(raw.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for(let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function derLength(bytes: Uint8Array): number {
  if(bytes.length < 2) return bytes.length;
  const first = bytes[1];
  if((first & 0x80) === 0) return Math.min(bytes.length, 2 + first);
  const count = first & 0x7f;
  if(count < 1 || count > 4 || bytes.length < 2 + count) return bytes.length;
  let length = 0;
  for(let i = 0; i < count; i++) length = (length << 8) | bytes[2 + i];
  return Math.min(bytes.length, 2 + count + length);
}

function hexBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  if(!clean || clean.length % 2) throw new Error('invalid_signature_contents');
  const bytes = new Uint8Array(clean.length / 2);
  for(let i = 0; i < clean.length; i += 2) bytes[i / 2] = Number.parseInt(clean.slice(i, i + 2), 16);
  return bytes.slice(0, derLength(bytes));
}

function certificateNames(contents: Uint8Array): string[] {
  try {
    const buffer = contents.buffer.slice(contents.byteOffset, contents.byteOffset + contents.byteLength);
    const parsed = asn1js.fromBER(buffer);
    if(parsed.offset === -1) return [];
    const contentInfo = new ContentInfo({schema: parsed.result});
    const signedData = new SignedData({schema: contentInfo.content});
    const names = new Set<string>();
    for(const certificate of signedData.certificates || []) {
      const subject = (certificate as {subject?: {typesAndValues?: Array<{type?: string; value?: {valueBlock?: {value?: string}}}>}}).subject;
      for(const attribute of subject?.typesAndValues || []) {
        if(attribute.type !== '2.5.4.3') continue;
        const name = String(attribute.value?.valueBlock?.value || '').trim();
        if(name) names.add(name);
      }
    }
    return [...names];
  } catch {
    return [];
  }
}

function fallbackPdfNames(windowText: string): string[] {
  const names = new Set<string>();
  for(const match of windowText.matchAll(/\/Name\s*\(([^)]{2,160})\)/g)) {
    const name = String(match[1] || '').trim();
    if(name) names.add(name);
  }
  for(const match of windowText.matchAll(/CN=([^,/+\r\n\x00]{2,120})/g)) {
    const name = String(match[1] || '').trim();
    if(name) names.add(name);
  }
  return [...names];
}

function extractSignatures(bytes: Uint8Array): PdfSignature[] {
  const text = new TextDecoder('latin1').decode(bytes);
  const ranges = [...text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)];
  return ranges.map((match, index) => {
    const at = match.index || 0;
    let contentsAt = text.indexOf('/Contents', at);
    if(contentsAt < 0 || contentsAt - at > 12000) contentsAt = text.lastIndexOf('/Contents', at);
    if(contentsAt < 0 || Math.abs(contentsAt - at) > 12000) throw new Error(`signature_${index + 1}_contents_missing`);
    const start = text.indexOf('<', contentsAt);
    const end = start >= 0 ? text.indexOf('>', start + 1) : -1;
    if(start < 0 || end < 0) throw new Error(`signature_${index + 1}_contents_invalid`);
    const contents = hexBytes(text.slice(start + 1, end));
    const nearby = text.slice(Math.max(0, at - 2500), Math.min(text.length, end + 2500));
    const names = [...new Set([...certificateNames(contents), ...fallbackPdfNames(nearby)])];
    return {byteRange: match[0], contents, names};
  });
}

async function digest(bytes: Uint8Array): Promise<string> {
  const value = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(value)].map(x => x.toString(16).padStart(2, '0')).join('');
}

function matchCommittee(signatures: PdfSignature[], committee: string[]): string[] | null {
  const committeeNorm = committee.map(normalizeName);
  const candidates = signatures.map(signature => signature.names.map(name => ({name, norm: normalizeName(name)})));
  const used = new Set<number>();
  const selected: string[] = [];

  function visit(signatureIndex: number): boolean {
    if(signatureIndex === signatures.length) return true;
    for(let committeeIndex = 0; committeeIndex < committeeNorm.length; committeeIndex++) {
      if(used.has(committeeIndex)) continue;
      const candidate = candidates[signatureIndex].find(item => item.norm === committeeNorm[committeeIndex]);
      if(!candidate) continue;
      used.add(committeeIndex);
      selected[signatureIndex] = candidate.name;
      if(visit(signatureIndex + 1)) return true;
      used.delete(committeeIndex);
    }
    return false;
  }

  return visit(0) ? selected : null;
}

function safeFilename(value: string): string {
  const cleaned = String(value || 'protocol.pdf').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-100);
  return cleaned.toLowerCase().endsWith('.pdf') ? cleaned : `${cleaned}.pdf`;
}

Deno.serve(async (req: Request) => {
  const options = handleOptions(req);
  if(options) return options;
  if(req.method !== 'POST') return json({valid: false, error: 'method_not_allowed'}, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const anonKey = getSupabasePublicKey();
  const serviceKey = getSupabaseSecretKey();
  if(!supabaseUrl || !anonKey || !serviceKey) return json({valid: false, error: 'server_not_configured'}, 500);

  const authorization = req.headers.get('Authorization') || '';
  const token = authorization.replace(/^Bearer\s+/i, '').trim();
  if(!token) return json({valid: false, error: 'missing_session'}, 401);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: {headers: {Authorization: `Bearer ${token}`}},
    auth: {persistSession: false, autoRefreshToken: false}
  });
  const {data: userData, error: userError} = await userClient.auth.getUser(token);
  const user = userData?.user;
  if(userError || !user) return json({valid: false, error: 'invalid_session'}, 401);

  const service = createClient(supabaseUrl, serviceKey, {auth: {persistSession: false, autoRefreshToken: false}});
  const {data: profile} = await service.from('rodios_app_users').select('id').eq('auth_user_id', user.id).is('deleted_at', null).maybeSingle();
  if(!profile) return json({valid: false, error: 'inactive_application_user'}, 403);

  let body: {orderId?: string; pdfBase64?: string; fileName?: string};
  try { body = await req.json(); }
  catch { return json({valid: false, error: 'invalid_json'}, 400); }
  const orderId = String(body.orderId || '').trim();
  if(!orderId || !body.pdfBase64) return json({valid: false, error: 'missing_pdf_or_order'}, 400);
  if(body.pdfBase64.length > 28_500_000) return json({valid: false, error: 'pdf_too_large_20mb_max'}, 413);

  const [{data: settingsRow, error: settingsError}, {data: orderRow, error: orderError}] = await Promise.all([
    service.from('rodios_settings').select('value').eq('key', 'main').maybeSingle(),
    service.from('rodios_work_orders').select('id,data').eq('id', orderId).is('deleted_at', null).maybeSingle()
  ]);
  if(settingsError || !settingsRow) return json({valid: false, error: 'settings_not_found'}, 409);
  if(orderError || !orderRow) return json({valid: false, error: 'work_order_not_found'}, 404);
  if(String(orderRow.data?.orderType || 'contractor') === 'service') {
    return json({valid: false, error: 'service_work_order_cannot_receive_protocol'}, 409);
  }
  if(String(orderRow.data?.status || '') !== 'Ολοκληρώθηκε - Εκκρεμούν Υπογραφές') {
    return json({valid: false, error: 'work_order_not_awaiting_protocol'}, 409);
  }
  if(orderRow.data?._protocolReady === true || orderRow.data?.signedPdfPath) {
    return json({valid: false, error: 'protocol_already_accepted'}, 409);
  }

  const committee = Array.isArray(settingsRow.value?.eSignUsers)
    ? settingsRow.value.eSignUsers.map((member: {name?: string}) => String(member?.name || '').trim()).filter(Boolean)
    : [];
  const uniqueCommittee = new Set(committee.map(normalizeName));
  if(committee.length !== 3 || uniqueCommittee.size !== 3 || uniqueCommittee.has('')) {
    return json({valid: false, error: 'committee_must_have_exactly_three_distinct_names'}, 409);
  }

  let bytes: Uint8Array;
  let signatures: PdfSignature[];
  try {
    bytes = decodeBase64(body.pdfBase64);
    if(bytes.length < 5 || new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw new Error('not_a_pdf');
    signatures = extractSignatures(bytes);
  } catch(error) {
    return json({valid: false, error: error instanceof Error ? error.message : 'pdf_parse_failed'}, 422);
  }

  if(signatures.length !== 3) {
    return json({
      valid: false,
      signatureCount: signatures.length,
      required: 3,
      error: 'exactly_three_digital_signatures_required'
    }, 422);
  }
  const hashes = await Promise.all(signatures.map(signature => digest(signature.contents)));
  if(new Set(hashes).size !== 3) {
    return json({valid: false, signatureCount: 3, error: 'signatures_must_be_distinct'}, 422);
  }

  const signerNames = matchCommittee(signatures, committee);
  if(!signerNames) {
    return json({
      valid: false,
      signatureCount: 3,
      committee,
      detectedNames: signatures.map(signature => signature.names),
      error: 'committee_names_not_found_in_all_three_signatures'
    }, 422);
  }

  // Μόνο μετά τον επιτυχημένο έλεγχο γίνεται upload.
  const filename = safeFilename(body.fileName || 'protocol.pdf');
  const path = `${orderId}/${Date.now()}_${filename}`;
  const {error: uploadError} = await service.storage.from('protocols').upload(path, bytes, {
    contentType: 'application/pdf',
    upsert: false,
    cacheControl: '3600'
  });
  if(uploadError) return json({valid: false, error: `storage_upload_failed: ${uploadError.message}`}, 500);

  const {data: accepted, error: acceptError} = await service.rpc('rodios_accept_protocol', {
    p_order_id: orderId,
    p_actor_id: user.id,
    p_bucket: 'protocols',
    p_path: path,
    p_filename: String(body.fileName || filename).slice(0, 180),
    p_signers: signerNames,
    p_committee: committee
  });
  if(acceptError) {
    await service.storage.from('protocols').remove([path]);
    return json({valid: false, error: `acceptance_failed: ${acceptError.message}`}, 409);
  }

  return json({
    valid: true,
    verified: null,
    signatureCount: 3,
    signers: signerNames,
    committee,
    message: 'Βρέθηκαν ακριβώς 3 διαφορετικές ψηφιακές υπογραφές και τα 3 ονόματα της Επιτροπής.',
    accepted
  });
});

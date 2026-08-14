export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8'
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {status, headers: corsHeaders});
}

export function handleOptions(req: Request): Response | null {
  return req.method === 'OPTIONS' ? new Response('ok', {headers: corsHeaders}) : null;
}

function keyFromDictionary(name: string): string {
  try {
    const raw = Deno.env.get(name) || '';
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const preferred = parsed.default;
    if(typeof preferred === 'string' && preferred) return preferred;
    return Object.values(parsed).find(value => typeof value === 'string' && value) as string || '';
  } catch {
    return '';
  }
}

export function getSupabasePublicKey(): string {
  return keyFromDictionary('SUPABASE_PUBLISHABLE_KEYS') || Deno.env.get('SUPABASE_ANON_KEY') || '';
}

export function getSupabaseSecretKey(): string {
  return keyFromDictionary('SUPABASE_SECRET_KEYS') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
}

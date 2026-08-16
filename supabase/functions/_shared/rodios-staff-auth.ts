import { createClient, type SupabaseClient, type User } from "npm:@supabase/supabase-js@2.110.9";

const DEFAULT_ORIGIN = "https://vasilis1730-web.github.io";

export class HttpError extends Error {
  status: number;
  publicMessage: string;
  constructor(status: number, publicMessage: string, internalMessage?: string) {
    super(internalMessage || publicMessage);
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

function readSecretKey(): string {
  let key =
    Deno.env.get("SUPABASE_SECRET_KEY") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    Deno.env.get("RODIOS_SERVICE_ROLE_KEY") ||
    Deno.env.get("SERVICE_ROLE_KEY") ||
    "";
  if (!key) {
    try {
      const named = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
      key = String(named.default || Object.values(named)[0] || "");
    } catch (_) {}
  }
  return key.trim();
}

export function getAdminClient(): SupabaseClient {
  const url = (
    Deno.env.get("SUPABASE_URL") ||
    Deno.env.get("RODIOS_PROJECT_URL") ||
    Deno.env.get("PROJECT_URL") ||
    ""
  ).trim();
  const key = readSecretKey();
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url) || !key) {
    throw new Error("Supabase server credentials are not configured");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function allowedOrigins(): Set<string> {
  const extra = (Deno.env.get("RODIOS_ALLOWED_ORIGINS") || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return new Set([DEFAULT_ORIGIN, ...extra]);
}

export function assertAllowedOrigin(req: Request): void {
  const origin = req.headers.get("origin") || "";
  if (origin && !allowedOrigins().has(origin)) {
    throw new HttpError(403, "Origin not allowed");
  }
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (origin && allowedOrigins().has(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export type StaffContext = {
  admin: SupabaseClient;
  user: User;
  profile: any;
  role: "admin" | "manager" | "user";
  token: string;
};

function bearerToken(req: Request): string {
  const raw = req.headers.get("authorization") || "";
  const m = raw.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1].trim() : "";
  if (!token || token.length > 20000) throw new HttpError(401, "Unauthorized");
  return token;
}

function roleFromProfile(profile: any): "admin" | "manager" | "user" {
  const data = profile?.data || {};
  if (profile?.id === "admin" || String(data.tier || "").toLowerCase() === "admin") return "admin";
  if (String(data.tier || "").toLowerCase() === "manager") return "manager";
  return "user";
}

export async function requireActiveStaff(
  req: Request,
  options: { adminOnly?: boolean; requireOrders?: boolean } = {},
): Promise<StaffContext> {
  assertAllowedOrigin(req);
  const admin = getAdminClient();
  const token = bearerToken(req);

  // Validate against Supabase Auth; never authorize from an unverified decoded JWT payload.
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  const user = userData?.user;
  if (userError || !user) throw new HttpError(401, "Unauthorized");

  const { data: profile, error: profileError } = await admin
    .from("rodios_app_users")
    .select("id, auth_user_id, data, deleted_at")
    .eq("auth_user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();

  if (profileError) throw new Error(`Active profile lookup failed: ${profileError.message}`);
  if (!profile) throw new HttpError(403, "Active application profile required");

  const role = roleFromProfile(profile);
  if (options.adminOnly && role !== "admin") {
    throw new HttpError(403, "Administrator permission required");
  }
  if (options.requireOrders && profile?.data?.canOrders === false) {
    throw new HttpError(403, "Work-order permission required");
  }

  return { admin, user, profile, role, token };
}

export async function consumeHourlyQuota(
  admin: SupabaseClient,
  scope: string,
  actorKey: string,
  limit: number,
): Promise<void> {
  const { data, error } = await admin.rpc("rodios_consume_edge_quota", {
    p_scope: scope,
    p_actor_key: actorKey,
    p_limit: limit,
  });
  if (error) throw new Error(`Rate-limit RPC failed: ${error.message}`);
  if (data !== true) throw new HttpError(429, "Too many requests. Try again later.");
}

export function handleError(req: Request, scope: string, err: unknown): Response {
  const e = err instanceof Error ? err : new Error(String(err));
  if (e instanceof HttpError) {
    console.warn(`[${scope}] ${e.status}: ${e.message}`);
    return json(req, { ok: false, error: e.publicMessage }, e.status);
  }
  console.error(`[${scope}]`, e);
  return json(req, { ok: false, error: "Server request failed" }, 500);
}

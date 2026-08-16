// ΡΟΔΙΟΣ — Απάντηση υπηρεσίας προς τον πολίτη (email με συνημμένα)
//
// ΑΡΧΗ ΑΣΦΑΛΕΙΑΣ: ο browser ΔΕΝ δίνει ποτέ διεύθυνση παραλήπτη.
// Δίνει μόνο το id του αιτήματος· ο διακομιστής βρίσκει μόνος του το
// citizenEmail από τη βάση και ελέγχει ότι ο πολίτης έχει ζητήσει ρητά
// απάντηση μέσω email. Διαφορετικά η function θα ήταν ανοιχτό relay
// για αποστολή αλληλογραφίας στο όνομα του Δήμου.

import nodemailer from "npm:nodemailer@9.0.5";
import { Buffer } from "node:buffer";
import {
  assertAllowedOrigin,
  consumeHourlyQuota,
  corsHeaders,
  handleError,
  HttpError,
  json,
  requireActiveStaff
} from "../_shared/rodios-staff-auth.ts";

const MAX_TOTAL_ATTACHMENTS = 20 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 10;
const MAX_MESSAGE_CHARS = 20_000;
const MAX_SUBJECT_CHARS = 240;
const HOURLY_QUOTA = 60;

function getEnv(name: string, fallback = "") { return Deno.env.get(name) || fallback; }
function isValidEmail(email: string) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email); }
function cleanHeader(value: unknown, max: number) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
}
function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function safeFilename(value: unknown) { return cleanHeader(value || "attachment", 180) || "attachment"; }
function safeContentType(value: unknown) {
  const v = cleanHeader(value, 120).toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(v) ? v : "application/octet-stream";
}

function sameProjectStorageUrl(url: URL, projectUrl: string) {
  const project = new URL(projectUrl);
  if (url.protocol !== "https:" || url.host !== project.host) return false;
  let p = "";
  try { p = decodeURIComponent(url.pathname); } catch { return false; }
  return /^\/storage\/v1\/object\/(?:sign|authenticated|public)\/(?:attachments|protocols)\//.test(p);
}

async function readLimited(res: Response, maxBytes: number) {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new HttpError(413, "Τα συνημμένα ξεπερνούν το επιτρεπτό συνολικό μέγεθος.");
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch (_) { /* ignore */ }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
}

function makeHtmlBody(text: string, ref: string) {
  const safe = escapeHtml(text).replace(/\r?\n/g, "<br>");
  return `<!doctype html><html lang="el"><head><meta charset="utf-8"></head>` +
    `<body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1a1a1a;">` +
    `<div>${safe}</div>` +
    `<hr style="border:none;border-top:1px solid #d4d4d4;margin:22px 0 10px;">` +
    `<div style="font-size:12px;color:#666;">` +
    `<strong>Δήμος Ρόδου</strong>${ref ? ` — Αίτημα #${escapeHtml(ref)}` : ""}<br>` +
    `Λαμβάνετε αυτό το μήνυμα επειδή ζητήσατε απάντηση κατά την υποβολή του αιτήματός σας.` +
    `</div></body></html>`;
}

function makeTextBody(text: string, ref: string) {
  return `${text}\n\n—\nΔήμος Ρόδου${ref ? ` — Αίτημα #${ref}` : ""}\n` +
    `Λαμβάνετε αυτό το μήνυμα επειδή ζητήσατε απάντηση κατά την υποβολή του αιτήματός σας.`;
}

const SMTP_HOST = getEnv("SMTP_HOST");
const SMTP_PORT = Number.parseInt(getEnv("SMTP_PORT", "587"), 10);
const SMTP_USER = getEnv("SMTP_USER");
const SMTP_PASS = getEnv("SMTP_PASS");
const SMTP_FROM = getEnv("SMTP_FROM", SMTP_USER);
const SMTP_REPLY_TO = getEnv("SMTP_REPLY_TO");

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    try { assertAllowedOrigin(req); return new Response(null, { status: 204, headers: corsHeaders(req) }); }
    catch (e) { return handleError(req, "send-citizen-reply", e); }
  }
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

  try {
    const ctx = await requireActiveStaff(req);
    await consumeHourlyQuota(ctx.admin, "send-citizen-reply", ctx.user.id, HOURLY_QUOTA);

    if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !SMTP_FROM) {
      throw new Error("SMTP is not configured");
    }

    let body: any;
    try { body = await req.json(); } catch { throw new HttpError(400, "Invalid JSON"); }

    const issueId = String(body?.issueId || "").trim();
    const messageText = String(body?.body || "").trim();
    const inputAttachments = Array.isArray(body?.attachments)
      ? body.attachments.slice(0, MAX_ATTACHMENT_COUNT) : [];
    if (!issueId) throw new HttpError(400, "Λείπει το αίτημα.");
    if (!messageText || messageText.length > MAX_MESSAGE_CHARS) throw new HttpError(400, "Μη έγκυρο κείμενο μηνύματος.");

    // ── Ο παραλήπτης προκύπτει ΜΟΝΟ από τη βάση ────────────────────────────
    const { data: row, error: readError } = await ctx.admin
      .from("rodios_issues").select("id, data").eq("id", issueId).is("deleted_at", null).maybeSingle();
    if (readError) throw readError;
    if (!row) throw new HttpError(404, "Το αίτημα δεν βρέθηκε.");

    const issue = (row.data || {}) as Record<string, any>;
    const channels: string[] = Array.isArray(issue.replyChannels) ? issue.replyChannels : [];
    const to = String(issue.citizenEmail || "").trim().toLowerCase();

    if (issue.replyOptIn !== true || !channels.includes("email")) {
      throw new HttpError(403, "Ο πολίτης δεν έχει ζητήσει απάντηση μέσω email για αυτό το αίτημα.");
    }
    if (!isValidEmail(to)) throw new HttpError(409, "Το αίτημα δεν έχει έγκυρο email πολίτη.");

    const ref = String(issue.citizenRef || issue.issueNum || "").slice(0, 20);
    const subject = cleanHeader(
      body?.subject || `Απάντηση στο αίτημά σας${ref ? ` #${ref}` : ""}`,
      MAX_SUBJECT_CHARS
    );

    // ── Συνημμένα: μόνο από το Storage του ίδιου project ───────────────────
    const projectUrl = String(Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
    if (!projectUrl) throw new Error("SUPABASE_URL is missing");

    const attachments: Array<{ filename: string; content: Buffer; contentType?: string }> = [];
    let totalBytes = 0;
    for (const a of inputAttachments) {
      const rawUrl = String(a?.url || "").trim();
      if (!rawUrl) continue;
      let parsed: URL;
      try { parsed = new URL(rawUrl); } catch { throw new HttpError(400, "Μη έγκυρος σύνδεσμος συνημμένου."); }
      if (!sameProjectStorageUrl(parsed, projectUrl)) {
        throw new HttpError(400, "Επιτρέπονται μόνο συνημμένα από το Storage της εφαρμογής.");
      }
      const remaining = MAX_TOTAL_ATTACHMENTS - totalBytes;
      if (remaining <= 0) throw new HttpError(413, "Τα συνημμένα ξεπερνούν το επιτρεπτό συνολικό μέγεθος.");

      let res: Response;
      try {
        res = await fetch(parsed.toString(), { method: "GET", redirect: "error", signal: AbortSignal.timeout(20_000) });
      } catch (e) {
        console.warn("[send-citizen-reply] attachment fetch failed", e instanceof Error ? e.message : String(e));
        throw new HttpError(400, "Δεν ήταν δυνατή η ασφαλής ανάκτηση όλων των συνημμένων.");
      }
      if (!res.ok) {
        console.warn("[send-citizen-reply] attachment HTTP", res.status);
        throw new HttpError(400, "Δεν ήταν δυνατή η ασφαλής ανάκτηση όλων των συνημμένων.");
      }
      const declaredLength = Number(res.headers.get("content-length") || "0");
      if (declaredLength > remaining) {
        try { await res.body?.cancel(); } catch (_) { /* ignore */ }
        throw new HttpError(413, "Τα συνημμένα ξεπερνούν το επιτρεπτό συνολικό μέγεθος.");
      }
      const bytes = await readLimited(res, remaining);
      totalBytes += bytes.byteLength;
      attachments.push({
        filename: safeFilename(a?.name),
        content: Buffer.from(bytes),
        contentType: safeContentType(a?.type || res.headers.get("content-type"))
      });
    }

    // ── Αποστολή ───────────────────────────────────────────────────────────
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST, port: SMTP_PORT,
      secure: SMTP_PORT === 465, requireTLS: SMTP_PORT === 587,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      tls: { servername: SMTP_HOST },
      connectionTimeout: 20_000, greetingTimeout: 15_000, socketTimeout: 45_000
    });

    let info: any;
    try {
      info = await transporter.sendMail({
        from: SMTP_FROM,
        to,
        replyTo: SMTP_REPLY_TO || undefined,
        subject,
        text: makeTextBody(messageText, ref),
        html: makeHtmlBody(messageText, ref),
        attachments,
        disableFileAccess: true,
        disableUrlAccess: true,
        headers: { "X-Mailer": "RODIOS Supabase Edge Function" }
      });
    } catch (e) {
      console.error("[send-citizen-reply] SMTP failure", e);
      throw new HttpError(502, "Αποτυχία αποστολής email.");
    }

    // ── Καταγραφή στο ιστορικό του αιτήματος ───────────────────────────────
    // Best-effort: αν αποτύχει, το email ΕΧΕΙ ήδη φύγει και δεν το ακυρώνουμε.
    try {
      const entry = {
        at: new Date().toISOString(),
        channel: "email",
        to,
        by: String(ctx.profile?.data?.name || ctx.profile?.id || ""),
        byId: String(ctx.profile?.id || ""),
        subject,
        text: messageText.slice(0, 4000),
        attachments: attachments.map(a => a.filename),
        messageId: info?.messageId || null
      };
      const existing = Array.isArray(issue.replies) ? issue.replies : [];
      await ctx.admin.from("rodios_issues")
        .update({ data: { ...issue, replies: [...existing, entry].slice(-50) } })
        .eq("id", issueId);
    } catch (e) {
      console.warn("[send-citizen-reply] reply log failed", e instanceof Error ? e.message : String(e));
    }

    return json(req, {
      ok: true,
      to,
      messageId: info?.messageId || null,
      accepted: Array.isArray(info?.accepted) ? info.accepted : [],
      rejected: Array.isArray(info?.rejected) ? info.rejected : [],
      attached: attachments.length
    });
  } catch (e) {
    return handleError(req, "send-citizen-reply", e);
  }
});

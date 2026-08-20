import { marked } from "marked";
import type { Address } from "../../shared/types.ts";
import type { Env } from "../env.ts";
import { formatAddress } from "./addresses.ts";

/**
 * Outbound mail, via Resend.
 *
 * Cloudflare's own Email Sending needs the Workers Paid plan, so on a free
 * account Resend is the sending path. The Worker only ever holds a send-only
 * key that is pinned to your domain (minted in infra/resend.ts), so a leak of
 * the Worker's environment cannot be used to manage the Resend account.
 */

const RESEND_SEND = "https://api.resend.com/emails";

/** Resend's free tier. Surfaced in the UI so a failed send is never a surprise. */
export const DAILY_LIMIT = 100;
export const MONTHLY_LIMIT = 3000;

export interface OutboundAttachment {
  filename: string;
  content: ArrayBuffer;
  contentType?: string;
}

export interface SendRequest {
  from: Address;
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  replyTo?: string | null;
  subject: string;
  /** Markdown. Rendered to HTML for the recipient, kept as text for clients that want it. */
  body: string;
  inReplyTo?: string | null;
  references?: string | null;
  attachments?: OutboundAttachment[];
}

export interface SendOutcome {
  providerId: string;
  html: string;
  text: string;
}

export class SendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "SendError";
  }
}

// ── body rendering ──────────────────────────────────────────────────────────

marked.setOptions({ gfm: true, breaks: true });

/**
 * Wraps the rendered markdown in a conservative, inline-styled shell.
 *
 * Mail clients strip <style> blocks and understand roughly 1998-era CSS, so
 * every rule here is inline and safe. No web fonts, no flexbox, no dark-mode
 * media query — those are the things that break in Outlook.
 */
export function renderBody(markdown: string, signatureHtml?: string | null): {
  html: string;
  text: string;
} {
  const rendered = marked.parse(markdown, { async: false }) as string;
  const signature = signatureHtml
    ? `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e4e4e7;color:#71717a;font-size:13px">${signatureHtml}</div>`
    : "";

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#ffffff">
<div style="max-width:640px;margin:0 auto;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#18181b">
${rendered}${signature}
</div>
</body></html>`;

  // A plain-text alternative is not optional: some clients only show it, and
  // its absence measurably worsens spam scoring.
  const text = markdown.trim();

  return { html, text };
}

// ── quota ───────────────────────────────────────────────────────────────────

function dayKey(now = new Date()): string {
  return `quota:day:${now.toISOString().slice(0, 10)}`;
}

function monthKey(now = new Date()): string {
  return `quota:month:${now.toISOString().slice(0, 7)}`;
}

export async function readQuota(env: Env): Promise<{
  sentToday: number;
  sentThisMonth: number;
}> {
  const [day, month] = await Promise.all([
    env.CACHE.get(dayKey()),
    env.CACHE.get(monthKey()),
  ]);
  return {
    sentToday: Number(day ?? 0),
    sentThisMonth: Number(month ?? 0),
  };
}

async function incrementQuota(env: Env): Promise<void> {
  const { sentToday, sentThisMonth } = await readQuota(env);
  await Promise.all([
    // 48h / 40d TTLs let the keys expire on their own instead of accumulating.
    env.CACHE.put(dayKey(), String(sentToday + 1), { expirationTtl: 60 * 60 * 48 }),
    env.CACHE.put(monthKey(), String(sentThisMonth + 1), {
      expirationTtl: 60 * 60 * 24 * 40,
    }),
  ]);
}

// ── send ────────────────────────────────────────────────────────────────────

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000; // chunked, or a large attachment blows the call stack
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function send(env: Env, request: SendRequest): Promise<SendOutcome> {
  const quota = await readQuota(env);
  if (quota.sentToday >= DAILY_LIMIT) {
    throw new SendError(
      `Daily sending limit reached (${DAILY_LIMIT} on Resend's free tier). ` +
        "It resets at midnight UTC — the message has been kept as a draft.",
      429,
      true,
    );
  }
  if (quota.sentThisMonth >= MONTHLY_LIMIT) {
    throw new SendError(
      `Monthly sending limit reached (${MONTHLY_LIMIT} on Resend's free tier).`,
      429,
      true,
    );
  }

  const { html, text } = renderBody(request.body);

  const headers: Record<string, string> = {};
  if (request.inReplyTo) headers["In-Reply-To"] = request.inReplyTo;
  if (request.references) headers["References"] = request.references;

  const payload: Record<string, unknown> = {
    from: formatAddress(request.from),
    to: request.to.map(formatAddress),
    subject: request.subject,
    html,
    text,
  };
  if (request.cc?.length) payload.cc = request.cc.map(formatAddress);
  if (request.bcc?.length) payload.bcc = request.bcc.map(formatAddress);
  if (request.replyTo) payload.reply_to = request.replyTo;
  if (Object.keys(headers).length > 0) payload.headers = headers;
  if (request.attachments?.length) {
    payload.attachments = request.attachments.map((a) => ({
      filename: a.filename,
      content: toBase64(a.content),
      content_type: a.contentType,
    }));
  }

  const response = await fetch(RESEND_SEND, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const raw = await response.text();
  let parsed: { id?: string; message?: string; name?: string } = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = { message: raw };
  }

  if (!response.ok) {
    throw new SendError(
      explainResendError(response.status, parsed, request.from.address),
      response.status,
      response.status === 429 || response.status >= 500,
    );
  }

  await incrementQuota(env);
  return { providerId: parsed.id ?? "", html, text };
}

/**
 * Resend's errors are terse. These are the three that actually happen in this
 * app, translated into the fix.
 */
function explainResendError(
  status: number,
  body: { message?: string; name?: string },
  from: string,
): string {
  const detail = body.message ?? body.name ?? `HTTP ${status}`;

  if (status === 403 && /domain is not verified/i.test(detail)) {
    return `Resend has not verified the domain for ${from} yet. The DNS records are already in Cloudflare — run \`just verify\` to re-check.`;
  }
  if (status === 401 || status === 403) {
    return `Resend rejected the send-only API key (${detail}). Re-run \`just up\` to mint a fresh one.`;
  }
  if (status === 422) {
    return `Resend refused the message: ${detail}`;
  }
  if (status === 429) {
    return "Resend is rate-limiting this account. The message stays queued — try again shortly.";
  }
  return `Send failed (${status}): ${detail}`;
}

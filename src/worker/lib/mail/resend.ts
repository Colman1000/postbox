import type { Env } from "../../env.ts";
import { formatAddress } from "../addresses.ts";
import { SendError, type MailProvider, type SendRequest } from "./types.ts";

/**
 * Resend.
 *
 * The default, because it is the only way to send from a Cloudflare free
 * account. The Worker holds a send-only key pinned to your domain, so leaking
 * the Worker's environment cannot be used to manage the Resend account.
 */

const ENDPOINT = "https://api.resend.com/emails";

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000; // chunked, or a large attachment blows the call stack
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Resend's errors are terse. These are the ones that actually happen in this
 * app, translated into the fix.
 */
function explain(
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
  if (status === 422) return `Resend refused the message: ${detail}`;
  if (status === 429) {
    return "Resend is rate-limiting this account. The message stays queued — try again shortly.";
  }
  return `Send failed (${status}): ${detail}`;
}

export const resendProvider: MailProvider = {
  id: "resend",
  label: "Resend",
  limits: {
    daily: 100,
    monthly: 3000,
    monthlyIsHardCap: true,
    note: "Resend free tier: 100 per day, 3,000 per month.",
  },

  async send(env: Env, request: SendRequest) {
    const payload: Record<string, unknown> = {
      from: formatAddress(request.from),
      to: request.to.map(formatAddress),
      subject: request.subject,
      html: request.html,
      text: request.text,
    };
    if (request.cc?.length) payload.cc = request.cc.map(formatAddress);
    if (request.bcc?.length) payload.bcc = request.bcc.map(formatAddress);
    if (request.replyTo) payload.reply_to = request.replyTo;

    const headers: Record<string, string> = {};
    if (request.inReplyTo) headers["In-Reply-To"] = request.inReplyTo;
    if (request.references) headers["References"] = request.references;
    if (Object.keys(headers).length > 0) payload.headers = headers;

    if (request.attachments?.length) {
      payload.attachments = request.attachments.map((a) => ({
        filename: a.filename,
        content: toBase64(a.content),
        content_type: a.contentType,
      }));
    }

    const response = await fetch(ENDPOINT, {
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
        explain(response.status, parsed, request.from.address),
        response.status,
        response.status === 429 || response.status >= 500,
      );
    }

    return { providerId: parsed.id ?? "" };
  },
};

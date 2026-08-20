import type { Env } from "../../env.ts";
import { SendError, type MailProvider, type SendRequest } from "./types.ts";

/**
 * Cloudflare Email Sending.
 *
 * Requires the Workers Paid plan — that is the whole reason Resend is the
 * default. On a paid account this is the better path: no third party, no
 * second API key, and the binding is already authenticated, so there is no
 * credential in the Worker's environment at all.
 */

function recipients(list: { address: string; name?: string }[]) {
  return list.map((a) => (a.name ? { email: a.address, name: a.name } : a.address));
}

function explain(error: unknown, from: string): string {
  const detail = error instanceof Error ? error.message : String(error);

  if (/not.*(onboard|verif)/i.test(detail)) {
    return `Cloudflare has not onboarded ${from.split("@")[1]} for Email Sending yet. Run \`npx wrangler email sending enable ${from.split("@")[1]}\`, then try again.`;
  }
  if (/quota|limit|rate/i.test(detail)) {
    return `Cloudflare is rate-limiting this account: ${detail}. New accounts start with a conservative daily quota that rises with reputation.`;
  }
  if (/paid|plan|billing/i.test(detail)) {
    return "Cloudflare Email Sending needs the Workers Paid plan. Set MAIL_PROVIDER=resend to send on the free tier instead.";
  }
  return `Send failed: ${detail}`;
}

export const cloudflareProvider: MailProvider = {
  id: "cloudflare",
  label: "Cloudflare Email Sending",
  limits: {
    // Cloudflare's daily quota starts conservative and rises with account
    // reputation, so there is no fixed number to show. The monthly figure is
    // the included allowance, not a wall: past it, sends are billed.
    daily: null,
    monthly: 3000,
    monthlyIsHardCap: false,
    note: "3,000 included per month on Workers Paid, then $0.35 per 1,000. Daily quota scales with account reputation.",
  },

  async send(env: Env, request: SendRequest) {
    if (!env.EMAIL) {
      throw new SendError(
        "MAIL_PROVIDER is `cloudflare` but the send_email binding is missing. Re-run `just up`.",
        500,
        false,
      );
    }

    const headers: Record<string, string> = {};
    if (request.inReplyTo) headers["In-Reply-To"] = request.inReplyTo;
    if (request.references) headers["References"] = request.references;

    try {
      const result = await env.EMAIL.send({
        from: request.from.name
          ? { email: request.from.address, name: request.from.name }
          : request.from.address,
        to: recipients(request.to),
        ...(request.cc?.length ? { cc: recipients(request.cc) } : {}),
        ...(request.bcc?.length ? { bcc: recipients(request.bcc) } : {}),
        ...(request.replyTo ? { replyTo: request.replyTo } : {}),
        subject: request.subject,
        html: request.html,
        text: request.text,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(request.attachments?.length
          ? {
              attachments: request.attachments.map((a) => ({
                disposition: "attachment" as const,
                filename: a.filename,
                type: a.contentType ?? "application/octet-stream",
                content: a.content,
              })),
            }
          : {}),
      } as Parameters<SendEmail["send"]>[0]);

      return { providerId: result.messageId };
    } catch (error) {
      throw new SendError(explain(error, request.from.address), 502, true);
    }
  },
};

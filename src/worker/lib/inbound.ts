import PostalMime, { type Email } from "postal-mime";
import type { Address } from "../../shared/types.ts";
import type { Env } from "../env.ts";
import { dedupe } from "./addresses.ts";
import {
  indexMessage,
  logEvent,
  makeSnippet,
  recomputeThread,
  resolveThreadId,
  upsertContacts,
} from "./db.ts";
import { ulid } from "./ids.ts";

/**
 * Inbound mail.
 *
 * Cloudflare Email Routing hands every message for the domain to this handler
 * (see the catch-all rule in alchemy.run.ts). Receiving is free and unmetered,
 * which is why the whole mailbox — not just one address — can live here.
 */

/** Per-attachment ceiling. Anything larger is recorded but its bytes dropped. */
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
/** Per-message ceiling across all attachments. */
const MAX_TOTAL_ATTACHMENT_BYTES = 12 * 1024 * 1024;
/**
 * Above this raw size we keep headers and body but skip attachment bytes.
 * The Workers Free plan has a tight CPU budget per invocation and a 25 MB
 * message full of base64 will blow it — losing the attachment is strictly
 * better than losing the email.
 */
const ATTACHMENT_BUDGET_RAW_BYTES = 6 * 1024 * 1024;

function toAddresses(list: Email["to"] | Email["cc"]): Address[] {
  if (!list) return [];
  return dedupe(
    list
      .filter((entry) => entry.address)
      .map((entry) => ({
        address: entry.address!.toLowerCase(),
        name: entry.name || undefined,
      })),
  );
}

/**
 * Cloudflare puts SPF/DKIM/DMARC verdicts in `Authentication-Results`.
 * The UI turns these into a trust badge rather than hiding them, because
 * "is this really from my bank" is the one question a mail client should
 * always answer.
 */
function parseAuthResults(header: string | null): {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
} {
  if (!header) return { spf: null, dkim: null, dmarc: null };
  const pick = (method: string) => {
    const match = header.match(new RegExp(`\\b${method}=(\\w+)`, "i"));
    return match ? match[1].toLowerCase() : null;
  };
  return { spf: pick("spf"), dkim: pick("dkim"), dmarc: pick("dmarc") };
}

/** Conservative: only mail that actively fails authentication is quarantined. */
function looksLikeSpam(auth: {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
}): boolean {
  const failed = [auth.spf, auth.dkim, auth.dmarc].filter(
    (v) => v === "fail" || v === "softfail" || v === "permerror",
  ).length;
  const passed = [auth.spf, auth.dkim, auth.dmarc].filter((v) => v === "pass").length;
  return failed >= 2 && passed === 0;
}

export async function handleInboundEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  // Forward first. If anything below throws, the safety-net copy has already
  // left, which is the whole point of having one.
  if (env.FORWARD_TO) {
    ctx.waitUntil(
      message
        .forward(env.FORWARD_TO)
        .catch((error) =>
          console.error("forward failed", {
            to: env.FORWARD_TO,
            error: String(error),
          }),
        ),
    );
  }

  const rawBuffer = await new Response(message.raw).arrayBuffer();
  const parsed = await PostalMime.parse(rawBuffer);

  const now = Date.now();
  const auth = parseAuthResults(message.headers.get("authentication-results"));

  const from: Address = {
    // Envelope sender is authoritative; the From header can be forged. We show
    // the header name but always keep the envelope address.
    address: (parsed.from?.address ?? message.from).toLowerCase(),
    name: parsed.from?.name || undefined,
  };
  const to = toAddresses(parsed.to);
  const cc = toAddresses(parsed.cc);
  if (to.length === 0) to.push({ address: message.to.toLowerCase() });

  const rfcMessageId = parsed.messageId ?? message.headers.get("message-id") ?? null;
  const inReplyTo = parsed.inReplyTo ?? message.headers.get("in-reply-to") ?? null;
  const references = parsed.references ?? message.headers.get("references") ?? null;
  const subject = (parsed.subject ?? "").trim();

  const threadId = await resolveThreadId(env.DB, {
    inReplyTo,
    references,
    subject,
    participants: [from.address, ...to.map((t) => t.address)],
  });

  const messageId = ulid(now);
  const bodyText = parsed.text ?? null;
  const bodyHtml = parsed.html ?? null;
  const snippet = makeSnippet(bodyText, bodyHtml);
  const folder = looksLikeSpam(auth) ? "spam" : "inbox";

  // ── attachments ───────────────────────────────────────────────────────────
  const statements: D1PreparedStatement[] = [];
  let storedAttachments = 0;
  let totalBytes = 0;
  const withinBudget = rawBuffer.byteLength <= ATTACHMENT_BUDGET_RAW_BYTES;

  for (const attachment of parsed.attachments ?? []) {
    const content =
      attachment.content instanceof ArrayBuffer
        ? attachment.content
        : new TextEncoder().encode(String(attachment.content)).buffer;
    const size = content.byteLength;

    const keepBytes =
      withinBudget &&
      size <= MAX_ATTACHMENT_BYTES &&
      totalBytes + size <= MAX_TOTAL_ATTACHMENT_BYTES;

    if (keepBytes) totalBytes += size;

    statements.push(
      env.DB.prepare(
        `INSERT INTO attachments
           (id, message_id, filename, mime_type, size, content_id, is_inline, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        ulid(),
        messageId,
        attachment.filename ?? "attachment",
        attachment.mimeType ?? "application/octet-stream",
        size,
        attachment.contentId ?? null,
        attachment.disposition === "inline" ? 1 : 0,
        keepBytes ? content : null,
        now,
      ),
    );
    storedAttachments++;
  }

  // ── the message itself ────────────────────────────────────────────────────
  statements.unshift(
    env.DB.prepare(
      `INSERT INTO messages (
         id, thread_id, direction, status, folder,
         rfc_message_id, in_reply_to, refs,
         from_address, from_name, to_addresses, cc_addresses, bcc_addresses, reply_to,
         subject, snippet, body_text, body_html,
         spf, dkim, dmarc, raw_size,
         is_read, is_starred, has_attachments,
         received_at, created_at, updated_at
       ) VALUES (?, ?, 'inbound', 'received', ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
    ).bind(
      messageId,
      threadId,
      folder,
      rfcMessageId,
      inReplyTo,
      references,
      from.address,
      from.name ?? null,
      JSON.stringify(to),
      JSON.stringify(cc),
      parsed.replyTo?.[0]?.address ?? null,
      subject,
      snippet,
      bodyText,
      bodyHtml,
      auth.spf,
      auth.dkim,
      auth.dmarc,
      rawBuffer.byteLength,
      storedAttachments > 0 ? 1 : 0,
      now,
      now,
      now,
    ),
  );

  statements.push(
    ...indexMessage(env.DB, {
      id: messageId,
      threadId,
      subject,
      body: bodyText ?? snippet,
      participants: [from, ...to, ...cc].map((a) => a.address).join(" "),
    }),
    ...upsertContacts(env.DB, [from], now),
    logEvent(
      env.DB,
      "received",
      `${from.address} → ${to.map((t) => t.address).join(", ")}`,
      { messageId, threadId },
    ),
  );

  await env.DB.batch(statements);

  // The summary must be computed after the message row exists.
  const summary = await recomputeThread(env.DB, threadId);
  if (summary) await summary.run();

  // Ring every open tab. Deliberately last and deliberately swallowed: the
  // message is already stored, and a doorbell that fails must not turn a
  // delivered email into a bounced one. The tab's poll is the backstop.
  try {
    await env.MAILBOX.getByName("mailbox").ring("mail");
  } catch (error) {
    console.error("doorbell failed", { threadId, error: String(error) });
  }
}

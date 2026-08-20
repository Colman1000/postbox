import { Hono } from "hono";
import type { Address, DraftInput, SendResult } from "../../shared/types.ts";
import { dedupe, isValidAddress, parseAddressList } from "../lib/addresses.ts";
import { toArrayBuffer } from "../lib/blob.ts";
import {
  indexMessage,
  logEvent,
  makeSnippet,
  parseReferences,
  recomputeThread,
  resolveThreadId,
  rowToMessage,
  upsertContacts,
  type MessageRow,
} from "../lib/db.ts";
import { rfcMessageId, ulid } from "../lib/ids.ts";
import { SendError, renderBody, send } from "../lib/outbound.ts";
import type { App } from "./context.ts";

export const compose = new Hono<App>();

/** Total attachment bytes a single outgoing message may carry. */
const MAX_OUTBOUND_ATTACHMENT_BYTES = 8 * 1024 * 1024;

function normalizeRecipients(input: Address[] | string | undefined): Address[] {
  if (!input) return [];
  if (typeof input === "string") return parseAddressList(input);
  return dedupe(
    input
      .filter((a) => a?.address && isValidAddress(a.address))
      .map((a) => ({ address: a.address.toLowerCase(), name: a.name })),
  );
}

// ── drafts ──────────────────────────────────────────────────────────────────

/**
 * Upsert a draft.
 *
 * Compose autosaves against this, so it must be cheap and idempotent: same id
 * in, same id out, no thread churn. A draft is a real message row from the
 * start, which is what lets attachments, scheduling and sending all operate on
 * one object instead of three.
 */
export interface SavedDraft {
  id: string;
  threadId: string;
  updatedAt: number;
}

/**
 * The single place a draft row is written.
 *
 * Both the autosave endpoint and `/send` go through here, so "what got saved"
 * and "what got sent" can never drift apart.
 */
export async function saveDraft(
  env: App["Bindings"],
  body: DraftInput,
): Promise<SavedDraft> {
  const now = Date.now();
  const from = (body.from ?? env.DEFAULT_FROM).toLowerCase();
  const to = normalizeRecipients(body.to);
  const cc = normalizeRecipients(body.cc);
  const bcc = normalizeRecipients(body.bcc);
  const subject = (body.subject ?? "").slice(0, 500);
  const text = body.body ?? "";

  const existing = body.id
    ? await env.DB.prepare(
        "SELECT * FROM messages WHERE id = ? AND status IN ('draft', 'failed')",
      )
        .bind(body.id)
        .first<MessageRow>()
    : null;

  const id = existing?.id ?? ulid(now);
  const threadId =
    existing?.thread_id ??
    body.threadId ??
    (body.inReplyTo
      ? await resolveThreadId(env.DB, {
          inReplyTo: body.inReplyTo,
          subject,
          participants: to.map((t) => t.address),
        })
      : ulid(now));

  await env.DB.prepare(
    `INSERT INTO messages (
       id, thread_id, direction, status, folder, in_reply_to,
       from_address, to_addresses, cc_addresses, bcc_addresses,
       subject, snippet, body_text, is_read, is_starred, created_at, updated_at
     ) VALUES (?, ?, 'outbound', 'draft', 'drafts', ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       status = 'draft',
       folder = 'drafts',
       to_addresses = excluded.to_addresses,
       cc_addresses = excluded.cc_addresses,
       bcc_addresses = excluded.bcc_addresses,
       from_address = excluded.from_address,
       subject = excluded.subject,
       snippet = excluded.snippet,
       body_text = excluded.body_text,
       in_reply_to = excluded.in_reply_to,
       updated_at = excluded.updated_at`,
  )
    .bind(
      id,
      threadId,
      body.inReplyTo ?? null,
      from,
      JSON.stringify(to),
      JSON.stringify(cc),
      JSON.stringify(bcc),
      subject,
      makeSnippet(text),
      text,
      existing?.created_at ?? now,
      now,
    )
    .run();

  // Index drafts as well as sent mail — "where was that half-written reply"
  // is exactly the kind of thing search should answer.
  await env.DB.batch(
    indexMessage(env.DB, {
      id,
      threadId,
      subject,
      body: text,
      participants: [from, ...to, ...cc, ...bcc]
        .map((a) => (typeof a === "string" ? a : a.address))
        .join(" "),
    }),
  );

  const summary = await recomputeThread(env.DB, threadId);
  if (summary) await summary.run();

  return { id, threadId, updatedAt: now };
}

compose.post("/drafts", async (c) => {
  const body = await c.req.json<DraftInput>();
  const from = (body.from ?? c.env.DEFAULT_FROM).toLowerCase();
  if (!from.endsWith(`@${c.env.MAIL_DOMAIN}`)) {
    return c.json(
      {
        error: `You can only send from @${c.env.MAIL_DOMAIN}.`,
        hint: `"${from}" is on a domain Resend has not verified for this account.`,
      },
      400,
    );
  }
  return c.json(await saveDraft(c.env, body));
});

compose.get("/drafts/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM messages WHERE id = ?")
    .bind(c.req.param("id"))
    .first<MessageRow>();
  if (!row) return c.json({ error: "Draft not found" }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT id, filename, mime_type, size, content_id, is_inline
       FROM attachments WHERE message_id = ?`,
  )
    .bind(row.id)
    .all<{
      id: string;
      filename: string;
      mime_type: string;
      size: number;
      content_id: string | null;
      is_inline: number;
    }>();

  return c.json(
    rowToMessage(
      row,
      (results ?? []).map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mime_type,
        size: a.size,
        isInline: a.is_inline === 1,
        contentId: a.content_id,
      })),
    ),
  );
});

compose.delete("/drafts/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    "SELECT thread_id FROM messages WHERE id = ? AND status IN ('draft', 'scheduled')",
  )
    .bind(id)
    .first<{ thread_id: string }>();
  if (!row) return c.json({ error: "Draft not found" }, 404);

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM attachments WHERE message_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM messages_fts WHERE message_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(id),
  ]);

  const summary = await recomputeThread(c.env.DB, row.thread_id);
  if (summary) await summary.run();

  return c.json({ ok: true });
});

// ── attachments on a draft ──────────────────────────────────────────────────

compose.post("/drafts/:id/attachments", async (c) => {
  const messageId = c.req.param("id");
  const draft = await c.env.DB.prepare(
    "SELECT id FROM messages WHERE id = ? AND status = 'draft'",
  )
    .bind(messageId)
    .first<{ id: string }>();
  if (!draft) return c.json({ error: "Draft not found" }, 404);

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "No file provided" }, 400);

  const current = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(size), 0) AS total FROM attachments WHERE message_id = ?",
  )
    .bind(messageId)
    .first<{ total: number }>();

  if ((current?.total ?? 0) + file.size > MAX_OUTBOUND_ATTACHMENT_BYTES) {
    return c.json(
      {
        error: "Attachments exceed the 8 MB limit for one message.",
        hint: "Most mail servers reject anything larger — link to a file instead.",
      },
      413,
    );
  }

  const id = ulid();
  const content = await file.arrayBuffer();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO attachments (id, message_id, filename, mime_type, size, is_inline, content, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    ).bind(
      id,
      messageId,
      file.name || "attachment",
      file.type || "application/octet-stream",
      file.size,
      content,
      Date.now(),
    ),
    c.env.DB.prepare("UPDATE messages SET has_attachments = 1 WHERE id = ?").bind(messageId),
  ]);

  return c.json({
    id,
    filename: file.name,
    mimeType: file.type,
    size: file.size,
    isInline: false,
  });
});

compose.delete("/attachments/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM attachments WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

// ── sending ─────────────────────────────────────────────────────────────────

interface SendBody extends DraftInput {
  /** When set, the message is queued for later instead of sent now. */
  scheduledAt?: number;
}

/**
 * Send, or schedule.
 *
 * The draft row is saved *before* the network call, so a send that fails
 * leaves a recoverable draft with the reason attached rather than losing what
 * you wrote. That is the single most important property of this endpoint.
 */
compose.post("/send", async (c) => {
  const body = await c.req.json<SendBody>();
  const now = Date.now();

  const from = (body.from ?? c.env.DEFAULT_FROM).toLowerCase();
  const to = normalizeRecipients(body.to);
  const cc = normalizeRecipients(body.cc);
  const bcc = normalizeRecipients(body.bcc);

  if (to.length === 0 && cc.length === 0 && bcc.length === 0) {
    return c.json({ error: "Add at least one recipient." }, 400);
  }
  if (!from.endsWith(`@${c.env.MAIL_DOMAIN}`)) {
    return c.json({ error: `You can only send from @${c.env.MAIL_DOMAIN}.` }, 400);
  }

  // Persist what the user wrote before touching the network, so a failed send
  // is always recoverable from Drafts.
  const saved = await saveDraft(c.env, { ...body, from, to, cc, bcc });
  const { id: messageId, threadId } = saved;

  // Scheduled: park it and let the cron pick it up.
  if (body.scheduledAt && body.scheduledAt > now + 30_000) {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE messages SET status = 'scheduled', folder = 'scheduled',
                             scheduled_at = ?, error = NULL, updated_at = ?
          WHERE id = ?`,
      ).bind(body.scheduledAt, now, messageId),
      logEvent(c.env.DB, "scheduled", new Date(body.scheduledAt).toISOString(), {
        messageId,
        threadId,
      }),
    ]);
    const summary = await recomputeThread(c.env.DB, threadId);
    if (summary) await summary.run();

    const result: SendResult = { messageId, threadId, scheduledAt: body.scheduledAt };
    return c.json(result);
  }

  const outcome = await deliver(c.env, messageId);
  if (!outcome.ok) {
    return c.json({ error: outcome.error, messageId, threadId }, outcome.status);
  }

  const result: SendResult = {
    messageId,
    threadId,
    providerId: outcome.providerId,
  };
  return c.json(result);
});

/** Pull a scheduled message back to drafts. */
compose.post("/scheduled/:id/cancel", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    "SELECT thread_id FROM messages WHERE id = ? AND status = 'scheduled'",
  )
    .bind(id)
    .first<{ thread_id: string }>();
  if (!row) return c.json({ error: "No scheduled message with that id" }, 404);

  await c.env.DB.prepare(
    `UPDATE messages SET status = 'draft', folder = 'drafts', scheduled_at = NULL, updated_at = ?
      WHERE id = ?`,
  )
    .bind(Date.now(), id)
    .run();

  const summary = await recomputeThread(c.env.DB, row.thread_id);
  if (summary) await summary.run();
  return c.json({ ok: true });
});

// ── delivery ────────────────────────────────────────────────────────────────

export type DeliverResult =
  | { ok: true; providerId: string }
  | { ok: false; error: string; status: 400 | 429 | 502 };

/**
 * Takes a stored draft to delivered.
 *
 * Shared by the send endpoint and the cron, so a scheduled message and an
 * immediate one travel exactly the same path — including the failure handling.
 */
export async function deliver(
  env: App["Bindings"],
  messageId: string,
): Promise<DeliverResult> {
  const row = await env.DB.prepare("SELECT * FROM messages WHERE id = ?")
    .bind(messageId)
    .first<MessageRow>();
  if (!row) return { ok: false, error: "Message not found", status: 400 };

  const to = JSON.parse(row.to_addresses || "[]") as Address[];
  const cc = JSON.parse(row.cc_addresses || "[]") as Address[];
  const bcc = JSON.parse(row.bcc_addresses || "[]") as Address[];

  // Threading headers, so the recipient's client files the reply correctly.
  let references: string | null = null;
  let inReplyTo: string | null = row.in_reply_to;
  if (inReplyTo) {
    const parent = await env.DB.prepare(
      "SELECT refs FROM messages WHERE rfc_message_id = ? LIMIT 1",
    )
      .bind(inReplyTo)
      .first<{ refs: string | null }>();
    references = [...parseReferences(parent?.refs), inReplyTo].join(" ");
  }

  const { results: attachmentRows } = await env.DB.prepare(
    "SELECT filename, mime_type, content FROM attachments WHERE message_id = ? AND content IS NOT NULL",
  )
    .bind(messageId)
    .all<{ filename: string; mime_type: string; content: unknown }>();

  const identity = await env.DB.prepare(
    "SELECT name, signature_html FROM identities WHERE address = ?",
  )
    .bind(row.from_address)
    .first<{ name: string | null; signature_html: string | null }>();

  const generatedId = rfcMessageId(env.MAIL_DOMAIN);
  const now = Date.now();

  try {
    const outcome = await send(env, {
      from: { address: row.from_address, name: identity?.name ?? undefined },
      to,
      cc,
      bcc,
      subject: row.subject,
      body: row.body_text ?? "",
      inReplyTo,
      references,
      attachments: (attachmentRows ?? []).map((a) => ({
        filename: a.filename,
        content: toArrayBuffer(a.content),
        contentType: a.mime_type,
      })),
    });

    const { html, text } = renderBody(row.body_text ?? "", identity?.signature_html);

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE messages
            SET status = 'sent', folder = 'sent', sent_at = ?, updated_at = ?,
                provider_id = ?, rfc_message_id = ?, refs = ?, body_html = ?,
                snippet = ?, error = NULL, scheduled_at = NULL
          WHERE id = ?`,
      ).bind(
        now,
        now,
        outcome.providerId,
        generatedId,
        references,
        html,
        makeSnippet(text),
        messageId,
      ),
      ...indexMessage(env.DB, {
        id: messageId,
        threadId: row.thread_id,
        subject: row.subject,
        body: row.body_text ?? "",
        participants: [row.from_address, ...to.map((a) => a.address), ...cc.map((a) => a.address)].join(
          " ",
        ),
      }),
      ...upsertContacts(env.DB, [...to, ...cc, ...bcc], now),
      logEvent(env.DB, "sent", `to ${to.map((t) => t.address).join(", ")}`, {
        messageId,
        threadId: row.thread_id,
      }),
    ]);

    const summary = await recomputeThread(env.DB, row.thread_id);
    if (summary) await summary.run();

    // A send that actually landed is the only proof of domain verification the
    // Worker can get — its send-only key cannot query Resend's domain API.
    await env.CACHE.put("sending:ready", "1", { expirationTtl: 60 * 60 * 24 * 30 });

    return { ok: true, providerId: outcome.providerId };
  } catch (error) {
    const sendError =
      error instanceof SendError
        ? error
        : new SendError(`Unexpected send failure: ${String(error)}`, 502, true);

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE messages SET status = 'failed', folder = 'drafts', error = ?, updated_at = ?
          WHERE id = ?`,
      ).bind(sendError.message, now, messageId),
      logEvent(env.DB, "send-failed", sendError.message, {
        messageId,
        threadId: row.thread_id,
      }),
    ]);

    const summary = await recomputeThread(env.DB, row.thread_id);
    if (summary) await summary.run();

    return {
      ok: false,
      error: sendError.message,
      status: sendError.status === 429 ? 429 : sendError.status === 400 ? 400 : 502,
    };
  }
}

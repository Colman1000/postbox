import { Hono } from "hono";
import type {
  AttachmentMeta,
  Folder,
  MailUpdate,
  Paginated,
  Thread,
  ThreadDetail,
} from "../../shared/types.ts";
import { toBytes } from "../lib/blob.ts";
import {
  labelsForThreads,
  logEvent,
  recomputeThread,
  rowToMessage,
  rowToThread,
  type MessageRow,
  type ThreadRow,
} from "../lib/db.ts";
import type { App } from "./context.ts";

export const mail = new Hono<App>();

const PAGE_SIZE = 50;

const VALID_FOLDERS: Folder[] = [
  "inbox",
  "sent",
  "drafts",
  "scheduled",
  "archive",
  "trash",
  "spam",
];

// ── listing ─────────────────────────────────────────────────────────────────

/**
 * Conversations in a folder.
 *
 * The window function picks each thread's newest message *within the requested
 * folder*, so Sent shows the date of your reply rather than the date of the
 * incoming message that started the thread. Ordering by that date is what makes
 * the list feel correct.
 */
mail.get("/threads", async (c) => {
  const folder = (c.req.query("folder") ?? "inbox") as Folder;
  const starredOnly = c.req.query("starred") === "1";
  const labelId = c.req.query("label");
  const cursor = c.req.query("cursor");
  const limit = Math.min(Number(c.req.query("limit") ?? PAGE_SIZE), 100);

  if (!starredOnly && !labelId && !VALID_FOLDERS.includes(folder)) {
    return c.json({ error: `Unknown folder "${folder}"` }, 400);
  }

  const where: string[] = [];
  const binds: unknown[] = [];

  let from = `
    FROM threads t
    JOIN (
      SELECT thread_id,
             snippet,
             created_at,
             ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY created_at DESC) AS rn
        FROM messages
       WHERE folder = ?
    ) m ON m.thread_id = t.id AND m.rn = 1`;
  binds.push(folder);

  if (starredOnly) {
    // "Starred" spans folders, so it drops the folder join entirely.
    from = `
      FROM threads t
      JOIN (
        SELECT thread_id, snippet, created_at,
               ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY created_at DESC) AS rn
          FROM messages
         WHERE folder != 'trash'
      ) m ON m.thread_id = t.id AND m.rn = 1`;
    binds.length = 0;
    where.push("t.is_starred = 1");
  }

  if (labelId) {
    from += "\n    JOIN thread_labels tl ON tl.thread_id = t.id AND tl.label_id = ?";
    binds.push(labelId);
  }

  // Snoozed conversations hide until their wake time.
  where.push("(t.snoozed_until IS NULL OR t.snoozed_until <= ?)");
  binds.push(Date.now());

  if (cursor) {
    where.push("m.created_at < ?");
    binds.push(Number(cursor));
  }

  const sql = `
    SELECT t.id, t.subject, m.snippet AS snippet, t.participants, t.folder,
           t.message_count, t.unread_count, t.has_attachments, t.is_starred,
           m.created_at AS last_message_at, t.snoozed_until, t.created_at, t.updated_at
    ${from}
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY m.created_at DESC
    LIMIT ?`;

  const { results } = await c.env.DB.prepare(sql)
    .bind(...binds, limit + 1)
    .all<ThreadRow>();

  const rows = results ?? [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const labels = await labelsForThreads(
    c.env.DB,
    page.map((r) => r.id),
  );

  const payload: Paginated<Thread> = {
    items: page.map((row) => rowToThread(row, labels.get(row.id) ?? [])),
    cursor: hasMore ? String(page[page.length - 1].last_message_at) : null,
    hasMore,
  };
  return c.json(payload);
});

// ── new mail ────────────────────────────────────────────────────────────────

/**
 * "Has anything arrived?" — the endpoint the open tab polls.
 *
 * Deliberately the cheapest query in the app: two indexed reads and no joins,
 * because it runs every few seconds in every open tab and pays for itself only
 * by staying small. `since` is the client's high-water mark; the first poll of
 * a session sends none, gets the count but no arrivals, and so cannot announce
 * mail that was already sitting there before you opened the page.
 */
mail.get("/updates", async (c) => {
  const now = Date.now();
  const since = Number(c.req.query("since") ?? 0);

  const unreadRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n
       FROM messages
      WHERE folder = 'inbox'
        AND direction = 'inbound'
        AND is_read = 0
        AND (snoozed_until IS NULL OR snoozed_until <= ?)`,
  )
    .bind(now)
    .first<{ n: number }>();

  const update: MailUpdate = {
    now,
    unread: unreadRow?.n ?? 0,
    arrivals: [],
  };

  if (!Number.isFinite(since) || since <= 0) return c.json(update);

  const { results } = await c.env.DB.prepare(
    `SELECT id, thread_id, subject, snippet, from_address, from_name, created_at
       FROM messages
      WHERE folder = 'inbox'
        AND direction = 'inbound'
        AND created_at > ?
      ORDER BY created_at DESC
      LIMIT 10`,
  )
    .bind(since)
    .all<{
      id: string;
      thread_id: string;
      subject: string;
      snippet: string;
      from_address: string;
      from_name: string | null;
      created_at: number;
    }>();

  update.arrivals = (results ?? []).map((row) => ({
    id: row.id,
    threadId: row.thread_id,
    subject: row.subject,
    snippet: row.snippet,
    from: { address: row.from_address, name: row.from_name ?? undefined },
    receivedAt: row.created_at,
  }));

  return c.json(update);
});

// ── search ──────────────────────────────────────────────────────────────────

/**
 * Full-text search across subjects, bodies and participants.
 *
 * Bare terms get a trailing `*` so search feels incremental as you type;
 * anything with FTS5 operators in it is passed through untouched so power
 * users keep `subject:invoice OR receipt`.
 */
mail.get("/search", async (c) => {
  const raw = (c.req.query("q") ?? "").trim();
  if (raw.length < 2) return c.json({ items: [], cursor: null, hasMore: false });

  const hasOperators = /[*":()]|\bAND\b|\bOR\b|\bNOT\b/.test(raw);
  const query = hasOperators
    ? raw
    : raw
        .split(/\s+/)
        .map((term) => `${term.replace(/["*]/g, "")}*`)
        .join(" ");

  let results: { thread_id: string }[] = [];
  try {
    const found = await c.env.DB.prepare(
      `SELECT DISTINCT thread_id
         FROM messages_fts
        WHERE messages_fts MATCH ?
        ORDER BY rank
        LIMIT 60`,
    )
      .bind(query)
      .all<{ thread_id: string }>();
    results = found.results ?? [];
  } catch {
    // A malformed FTS expression is a user typo, not a server fault.
    return c.json({ items: [], cursor: null, hasMore: false, invalidQuery: true });
  }

  if (results.length === 0) return c.json({ items: [], cursor: null, hasMore: false });

  const ids = results.map((r) => r.thread_id);
  const placeholders = ids.map(() => "?").join(", ");
  const { results: threads } = await c.env.DB.prepare(
    `SELECT * FROM threads WHERE id IN (${placeholders}) ORDER BY last_message_at DESC`,
  )
    .bind(...ids)
    .all<ThreadRow>();

  const labels = await labelsForThreads(c.env.DB, ids);
  const payload: Paginated<Thread> = {
    items: (threads ?? []).map((row) => rowToThread(row, labels.get(row.id) ?? [])),
    cursor: null,
    hasMore: false,
  };
  return c.json(payload);
});

// ── one conversation ────────────────────────────────────────────────────────

mail.get("/threads/:id", async (c) => {
  const threadId = c.req.param("id");

  const thread = await c.env.DB.prepare("SELECT * FROM threads WHERE id = ?")
    .bind(threadId)
    .first<ThreadRow>();
  if (!thread) return c.json({ error: "Conversation not found" }, 404);

  const { results: messageRows } = await c.env.DB.prepare(
    "SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC",
  )
    .bind(threadId)
    .all<MessageRow>();

  const messages = messageRows ?? [];
  const attachmentsByMessage = new Map<string, AttachmentMeta[]>();

  if (messages.some((m) => m.has_attachments === 1)) {
    const ids = messages.map((m) => m.id);
    const { results: attachments } = await c.env.DB.prepare(
      `SELECT id, message_id, filename, mime_type, size, content_id, is_inline
         FROM attachments
        WHERE message_id IN (${ids.map(() => "?").join(", ")})`,
    )
      .bind(...ids)
      .all<{
        id: string;
        message_id: string;
        filename: string;
        mime_type: string;
        size: number;
        content_id: string | null;
        is_inline: number;
      }>();

    for (const row of attachments ?? []) {
      const list = attachmentsByMessage.get(row.message_id) ?? [];
      list.push({
        id: row.id,
        filename: row.filename,
        mimeType: row.mime_type,
        size: row.size,
        isInline: row.is_inline === 1,
        contentId: row.content_id,
      });
      attachmentsByMessage.set(row.message_id, list);
    }
  }

  const labels = await labelsForThreads(c.env.DB, [threadId]);
  const detail: ThreadDetail = {
    ...rowToThread(thread, labels.get(threadId) ?? []),
    messages: messages.map((row) => rowToMessage(row, attachmentsByMessage.get(row.id) ?? [])),
  };
  return c.json(detail);
});

// ── actions ─────────────────────────────────────────────────────────────────

type Action =
  | "read"
  | "unread"
  | "star"
  | "unstar"
  | "archive"
  | "inbox"
  | "trash"
  | "restore"
  | "spam"
  | "not-spam"
  | "snooze"
  | "unsnooze"
  | "delete";

/**
 * Bulk conversation actions.
 *
 * One endpoint rather than eleven, because the UI applies these optimistically
 * and needs a single predictable round-trip. Every branch ends by recomputing
 * the affected thread summaries in the same batch as the mutation.
 */
mail.post("/threads/actions", async (c) => {
  const body = await c.req.json<{
    ids?: string[];
    action?: Action;
    until?: number;
  }>();

  const ids = (body.ids ?? []).filter(Boolean);
  const action = body.action;
  if (ids.length === 0 || !action) {
    return c.json({ error: "ids and action are required" }, 400);
  }
  if (ids.length > 200) {
    return c.json({ error: "Too many conversations in one request (max 200)." }, 400);
  }

  const placeholders = ids.map(() => "?").join(", ");
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  const set = (fragment: string, ...binds: unknown[]) =>
    statements.push(
      c.env.DB.prepare(
        `UPDATE messages SET ${fragment}, updated_at = ? WHERE thread_id IN (${placeholders})`,
      ).bind(...binds, now, ...ids),
    );

  switch (action) {
    case "read":
      set("is_read = 1");
      break;
    case "unread":
      set("is_read = 0");
      break;
    case "star":
      set("is_starred = 1");
      break;
    case "unstar":
      set("is_starred = 0");
      break;

    // Archiving only moves received mail. Your own replies stay in Sent, which
    // is what every other client does.
    case "archive":
      statements.push(
        c.env.DB.prepare(
          `UPDATE messages SET folder = 'archive', updated_at = ?
            WHERE thread_id IN (${placeholders}) AND folder IN ('inbox', 'spam')`,
        ).bind(now, ...ids),
      );
      break;

    case "inbox":
    case "not-spam":
      statements.push(
        c.env.DB.prepare(
          `UPDATE messages SET folder = 'inbox', updated_at = ?
            WHERE thread_id IN (${placeholders}) AND direction = 'inbound'
              AND folder IN ('archive', 'spam', 'trash')`,
        ).bind(now, ...ids),
      );
      break;

    case "spam":
      statements.push(
        c.env.DB.prepare(
          `UPDATE messages SET folder = 'spam', updated_at = ?
            WHERE thread_id IN (${placeholders}) AND direction = 'inbound'`,
        ).bind(now, ...ids),
      );
      break;

    // Trash takes the whole conversation, replies included.
    case "trash":
      set("folder = 'trash'");
      break;

    case "restore":
      statements.push(
        c.env.DB.prepare(
          `UPDATE messages SET folder = CASE direction WHEN 'inbound' THEN 'inbox' ELSE 'sent' END,
                               updated_at = ?
            WHERE thread_id IN (${placeholders}) AND folder = 'trash'`,
        ).bind(now, ...ids),
      );
      break;

    case "snooze":
      if (!body.until || body.until <= now) {
        return c.json({ error: "snooze requires a future `until` timestamp" }, 400);
      }
      set("snoozed_until = ?", body.until);
      break;

    case "unsnooze":
      set("snoozed_until = NULL");
      break;

    // The only irreversible one, and it is reachable from Trash alone.
    case "delete":
      statements.push(
        c.env.DB.prepare(
          `DELETE FROM attachments WHERE message_id IN
             (SELECT id FROM messages WHERE thread_id IN (${placeholders}))`,
        ).bind(...ids),
        c.env.DB.prepare(
          `DELETE FROM messages_fts WHERE thread_id IN (${placeholders})`,
        ).bind(...ids),
        c.env.DB.prepare(`DELETE FROM messages WHERE thread_id IN (${placeholders})`).bind(
          ...ids,
        ),
        c.env.DB.prepare(`DELETE FROM thread_labels WHERE thread_id IN (${placeholders})`).bind(
          ...ids,
        ),
        c.env.DB.prepare(`DELETE FROM threads WHERE id IN (${placeholders})`).bind(...ids),
      );
      break;

    default:
      return c.json({ error: `Unknown action "${action}"` }, 400);
  }

  statements.push(logEvent(c.env.DB, action, `${ids.length} conversation(s)`));
  await c.env.DB.batch(statements);

  if (action !== "delete") {
    const summaries = await Promise.all(ids.map((id) => recomputeThread(c.env.DB, id)));
    const valid = summaries.filter((s): s is D1PreparedStatement => s !== null);
    if (valid.length > 0) await c.env.DB.batch(valid);
  }

  return c.json({ ok: true, affected: ids.length });
});

// ── labels on a conversation ────────────────────────────────────────────────

mail.post("/threads/:id/labels", async (c) => {
  const threadId = c.req.param("id");
  const { add = [], remove = [] } = await c.req.json<{
    add?: string[];
    remove?: string[];
  }>();

  const statements: D1PreparedStatement[] = [];
  for (const labelId of add) {
    statements.push(
      c.env.DB.prepare(
        "INSERT OR IGNORE INTO thread_labels (thread_id, label_id) VALUES (?, ?)",
      ).bind(threadId, labelId),
    );
  }
  for (const labelId of remove) {
    statements.push(
      c.env.DB.prepare(
        "DELETE FROM thread_labels WHERE thread_id = ? AND label_id = ?",
      ).bind(threadId, labelId),
    );
  }
  if (statements.length > 0) await c.env.DB.batch(statements);

  const labels = await labelsForThreads(c.env.DB, [threadId]);
  return c.json({ labels: labels.get(threadId) ?? [] });
});

// ── attachments ─────────────────────────────────────────────────────────────

mail.get("/attachments/:id", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT filename, mime_type, size, content FROM attachments WHERE id = ?",
  )
    .bind(c.req.param("id"))
    .first<{
      filename: string;
      mime_type: string;
      size: number;
      content: unknown;
    }>();

  if (!row) return c.json({ error: "Attachment not found" }, 404);
  if (!row.content) {
    return c.json(
      {
        error: "This attachment was too large to store.",
        hint: `${row.filename} (${row.size} bytes) exceeded the storage cap. The message itself was kept.`,
      },
      410,
    );
  }

  const disposition = `attachment; filename="${row.filename.replace(/["\\]/g, "")}"`;
  return new Response(toBytes(row.content), {
    headers: {
      "Content-Type": row.mime_type,
      "Content-Disposition": disposition,
      "Cache-Control": "private, max-age=3600",
      // Never let a stored attachment execute in our own origin.
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

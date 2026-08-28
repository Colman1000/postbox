import type {
  Address,
  AttachmentMeta,
  Folder,
  Label,
  Message,
  Thread,
} from "../../shared/types.ts";
import { dedupe } from "./addresses.ts";
import { ulid } from "./ids.ts";

/**
 * Data access.
 *
 * Folder model, stated once so the rest of the code can be short:
 *
 *   A *message* lives in exactly one folder. Inbound messages move
 *   inbox → archive → trash. Outbound messages are drafts → scheduled → sent.
 *
 *   A *thread* has no folder of its own — it appears in a folder when it
 *   contains at least one message there. That is why archiving a conversation
 *   takes it out of Inbox but leaves your reply in Sent, which is what every
 *   mail client does and what everyone expects.
 */

// ── row shapes ──────────────────────────────────────────────────────────────

export interface MessageRow {
  id: string;
  thread_id: string;
  direction: "inbound" | "outbound";
  status: string;
  folder: string;
  rfc_message_id: string | null;
  in_reply_to: string | null;
  refs: string | null;
  from_address: string;
  from_name: string | null;
  to_addresses: string;
  cc_addresses: string;
  bcc_addresses: string;
  reply_to: string | null;
  subject: string;
  snippet: string;
  body_text: string | null;
  body_html: string | null;
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
  raw_size: number | null;
  is_read: number;
  is_starred: number;
  has_attachments: number;
  scheduled_at: number | null;
  snoozed_until: number | null;
  sent_at: number | null;
  received_at: number | null;
  created_at: number;
  updated_at: number;
  provider_id: string | null;
  error: string | null;
}

export interface ThreadRow {
  id: string;
  subject: string;
  snippet: string;
  participants: string;
  folder: string;
  message_count: number;
  unread_count: number;
  has_attachments: number;
  is_starred: number;
  last_message_at: number;
  snoozed_until: number | null;
  created_at: number;
  updated_at: number;
}

function json<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function rowToMessage(
  row: MessageRow,
  attachments: AttachmentMeta[] = [],
): Message {
  return {
    id: row.id,
    threadId: row.thread_id,
    direction: row.direction,
    status: row.status as Message["status"],
    folder: row.folder as Folder,
    rfcMessageId: row.rfc_message_id,
    inReplyTo: row.in_reply_to,
    from: { address: row.from_address, name: row.from_name ?? undefined },
    to: json<Address[]>(row.to_addresses, []),
    cc: json<Address[]>(row.cc_addresses, []),
    bcc: json<Address[]>(row.bcc_addresses, []),
    replyTo: row.reply_to,
    subject: row.subject,
    snippet: row.snippet,
    bodyText: row.body_text,
    bodyHtml: row.body_html,
    auth: { spf: row.spf, dkim: row.dkim, dmarc: row.dmarc },
    rawSize: row.raw_size,
    isRead: row.is_read === 1,
    isStarred: row.is_starred === 1,
    hasAttachments: row.has_attachments === 1,
    attachments,
    scheduledAt: row.scheduled_at,
    sentAt: row.sent_at,
    receivedAt: row.received_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    providerId: row.provider_id,
    error: row.error,
  };
}

export function rowToThread(row: ThreadRow, labels: Label[] = []): Thread {
  return {
    id: row.id,
    subject: row.subject,
    snippet: row.snippet,
    participants: json<Address[]>(row.participants, []),
    folder: row.folder as Folder,
    messageCount: row.message_count,
    unreadCount: row.unread_count,
    hasAttachments: row.has_attachments === 1,
    isStarred: row.is_starred === 1,
    lastMessageAt: row.last_message_at,
    snoozedUntil: row.snoozed_until,
    labels,
  };
}

// ── threading ───────────────────────────────────────────────────────────────

/** `Re: Fwd: RE: Launch` → `launch`. Used only as a last-resort match. */
export function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(\s*(re|fw|fwd|aw|sv|vs|antwort)\s*(\[\d+\])?\s*:\s*)+/i, "")
    .trim()
    .toLowerCase();
}

export function parseReferences(refs: string | null | undefined): string[] {
  if (!refs) return [];
  return refs.match(/<[^>]+>/g) ?? [];
}

/**
 * Finds the conversation a message belongs to.
 *
 * Header-based matching first (In-Reply-To, then References), because that is
 * authoritative. Subject matching is the fallback for clients that drop those
 * headers, and is deliberately narrowed to the last 30 days so an annual
 * "Invoice" thread does not swallow every future invoice.
 */
export async function resolveThreadId(
  db: D1Database,
  input: {
    inReplyTo?: string | null;
    references?: string | null;
    subject: string;
    participants: string[];
  },
): Promise<string> {
  const candidates = [
    ...(input.inReplyTo ? [input.inReplyTo] : []),
    ...parseReferences(input.references).reverse(),
  ];

  for (const candidate of candidates) {
    const hit = await db
      .prepare("SELECT thread_id FROM messages WHERE rfc_message_id = ? LIMIT 1")
      .bind(candidate)
      .first<{ thread_id: string }>();
    if (hit) return hit.thread_id;
  }

  const normalized = normalizeSubject(input.subject);
  if (normalized.length > 2 && input.participants.length > 0) {
    const cutoff = Date.now() - 1000 * 60 * 60 * 24 * 30;
    const placeholders = input.participants.map(() => "?").join(", ");
    const hit = await db
      .prepare(
        `SELECT m.thread_id
           FROM messages m
          WHERE m.created_at > ?
            AND lower(m.from_address) IN (${placeholders})
            AND m.subject IS NOT NULL
          ORDER BY m.created_at DESC
          LIMIT 40`,
      )
      .bind(cutoff, ...input.participants.map((p) => p.toLowerCase()))
      .all<{ thread_id: string }>();

    for (const row of hit.results ?? []) {
      const thread = await db
        .prepare("SELECT subject FROM threads WHERE id = ?")
        .bind(row.thread_id)
        .first<{ subject: string }>();
      if (thread && normalizeSubject(thread.subject) === normalized) {
        return row.thread_id;
      }
    }
  }

  return ulid();
}

// ── thread summary ──────────────────────────────────────────────────────────

const FOLDER_PRIORITY: Folder[] = [
  "inbox",
  "drafts",
  "scheduled",
  "sent",
  "archive",
  "spam",
  "trash",
];

/**
 * Recomputes a thread's cached summary from its messages.
 *
 * Called after every write that touches a thread. Returning a statement rather
 * than executing it lets callers fold this into the same `db.batch()`, so the
 * summary can never disagree with the messages it summarises.
 */
export async function recomputeThread(
  db: D1Database,
  threadId: string,
): Promise<D1PreparedStatement | null> {
  const { results } = await db
    .prepare(
      `SELECT folder, subject, snippet, from_address, from_name, to_addresses,
              cc_addresses, is_read, is_starred, has_attachments, created_at,
              snoozed_until, direction
         FROM messages
        WHERE thread_id = ?
        ORDER BY created_at ASC`,
    )
    .bind(threadId)
    .all<MessageRow>();

  const messages = results ?? [];
  if (messages.length === 0) {
    return db.prepare("DELETE FROM threads WHERE id = ?").bind(threadId);
  }

  const newest = messages[messages.length - 1];
  const folders = new Set(messages.map((m) => m.folder));
  const folder = FOLDER_PRIORITY.find((f) => folders.has(f)) ?? "inbox";

  const participants = dedupe(
    messages.flatMap((m) => [
      { address: m.from_address, name: m.from_name ?? undefined },
      ...json<Address[]>(m.to_addresses, []),
      ...json<Address[]>(m.cc_addresses, []),
    ]),
  );

  // The subject of the first message is the conversation's subject; later
  // "Re:" prefixes should not rename it.
  const subject = messages[0].subject || newest.subject || "(no subject)";
  const unread = messages.filter((m) => m.is_read === 0 && m.direction === "inbound").length;
  const snoozed = messages
    .map((m) => m.snoozed_until)
    .filter((v): v is number => typeof v === "number" && v > Date.now())
    .sort((a, b) => a - b)[0];

  const now = Date.now();

  return db
    .prepare(
      `INSERT INTO threads (
         id, subject, snippet, participants, folder, message_count, unread_count,
         has_attachments, is_starred, last_message_at, snoozed_until, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         subject = excluded.subject,
         snippet = excluded.snippet,
         participants = excluded.participants,
         folder = excluded.folder,
         message_count = excluded.message_count,
         unread_count = excluded.unread_count,
         has_attachments = excluded.has_attachments,
         is_starred = excluded.is_starred,
         last_message_at = excluded.last_message_at,
         snoozed_until = excluded.snoozed_until,
         updated_at = excluded.updated_at`,
    )
    .bind(
      threadId,
      subject,
      newest.snippet,
      JSON.stringify(participants),
      folder,
      messages.length,
      unread,
      messages.some((m) => m.has_attachments === 1) ? 1 : 0,
      messages.some((m) => m.is_starred === 1) ? 1 : 0,
      newest.created_at,
      snoozed ?? null,
      messages[0].created_at,
      now,
    );
}

/** Labels for a batch of threads, in one query instead of N. */
/**
 * Unread inbound mail sitting in the inbox, right now.
 *
 * One definition, three callers: the tab title, the home-screen badge and the
 * count a push notification carries. They were always meant to agree, and the
 * only way to guarantee that is for them to ask the same question — a badge
 * that says two over an inbox showing three is worse than no badge.
 *
 * Snoozed conversations are excluded, exactly as every list and count in the
 * app excludes them: mail you have deliberately put off is not mail you are
 * waiting on.
 */
export async function unreadCount(db: D1Database, now = Date.now()): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM messages
        WHERE folder = 'inbox'
          AND direction = 'inbound'
          AND is_read = 0
          AND (snoozed_until IS NULL OR snoozed_until <= ?)`,
    )
    .bind(now)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function labelsForThreads(
  db: D1Database,
  threadIds: string[],
): Promise<Map<string, Label[]>> {
  const map = new Map<string, Label[]>();
  if (threadIds.length === 0) return map;

  const placeholders = threadIds.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT tl.thread_id, l.id, l.name, l.tone
         FROM thread_labels tl
         JOIN labels l ON l.id = tl.label_id
        WHERE tl.thread_id IN (${placeholders})`,
    )
    .bind(...threadIds)
    .all<{ thread_id: string; id: string; name: string; tone: string }>();

  for (const row of results ?? []) {
    const list = map.get(row.thread_id) ?? [];
    list.push({ id: row.id, name: row.name, tone: row.tone as Label["tone"] });
    map.set(row.thread_id, list);
  }
  return map;
}

/** Keeps the address book current without the user ever curating it. */
export function upsertContacts(
  db: D1Database,
  addresses: Address[],
  now: number,
): D1PreparedStatement[] {
  return dedupe(addresses).map((contact) =>
    db
      .prepare(
        `INSERT INTO contacts (address, name, message_count, is_favorite, last_seen_at, created_at)
         VALUES (?, ?, 1, 0, ?, ?)
         ON CONFLICT (address) DO UPDATE SET
           name = COALESCE(excluded.name, contacts.name),
           message_count = contacts.message_count + 1,
           last_seen_at = excluded.last_seen_at`,
      )
      .bind(contact.address.toLowerCase(), contact.name ?? null, now, now),
  );
}

/** Writes the search index entry for a message. */
export function indexMessage(
  db: D1Database,
  message: {
    id: string;
    threadId: string;
    subject: string;
    body: string;
    participants: string;
  },
): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM messages_fts WHERE message_id = ?").bind(message.id),
    db
      .prepare(
        `INSERT INTO messages_fts (message_id, thread_id, subject, body, participants)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        message.id,
        message.threadId,
        message.subject,
        message.body.slice(0, 100_000),
        message.participants,
      ),
  ];
}

/**
 * Records which of our own addresses a message touched.
 *
 * Mailboxes are derived from this table rather than stored against it, which
 * is the whole reason it exists: naming `billing@` in Settings shows every
 * message it has ever received, immediately, because the membership was
 * written when each message arrived rather than when the mailbox was defined.
 *
 * Written the same way as the search index — delete then insert, folded into
 * the caller's batch — so re-saving a draft that changed its From address
 * leaves one row rather than two.
 */
export function indexAddresses(
  db: D1Database,
  message: { id: string; threadId: string; addresses: (string | null | undefined)[] },
): D1PreparedStatement[] {
  const unique = [
    ...new Set(
      message.addresses
        .map((address) => address?.trim().toLowerCase())
        .filter((address): address is string => Boolean(address)),
    ),
  ];

  return [
    db.prepare("DELETE FROM message_addresses WHERE message_id = ?").bind(message.id),
    ...unique.map((address) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO message_addresses (message_id, thread_id, address)
           VALUES (?, ?, ?)`,
        )
        .bind(message.id, message.threadId, address),
    ),
  ];
}

export function logEvent(
  db: D1Database,
  type: string,
  detail: string,
  ids: { messageId?: string; threadId?: string } = {},
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO events (id, type, message_id, thread_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(ulid(), type, ids.messageId ?? null, ids.threadId ?? null, detail, Date.now());
}

/** Plain-text preview for list rows. */
export function makeSnippet(text: string | null | undefined, html?: string | null): string {
  const source =
    text?.trim() ||
    (html ? html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ") : "");
  return source
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

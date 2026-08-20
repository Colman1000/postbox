import { Hono } from "hono";
import type {
  ActivityEvent,
  AuditEntry,
  Contact,
  Folder,
  Identity,
  Label,
  Stats,
  Template,
} from "../../shared/types.ts";
import { isValidAddress } from "../lib/addresses.ts";
import { shortId } from "../lib/ids.ts";
import { getProvider, readQuota } from "../lib/mail/index.ts";
import type { App } from "./context.ts";

export const workspace = new Hono<App>();

// ── labels ──────────────────────────────────────────────────────────────────

workspace.get("/labels", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT l.id, l.name, l.tone, COUNT(tl.thread_id) AS count
       FROM labels l
       LEFT JOIN thread_labels tl ON tl.label_id = l.id
      GROUP BY l.id
      ORDER BY l.name COLLATE NOCASE`,
  ).all<{ id: string; name: string; tone: string; count: number }>();

  return c.json(
    (results ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      tone: row.tone as Label["tone"],
      count: row.count,
    })),
  );
});

workspace.post("/labels", async (c) => {
  const { name, tone = "neutral" } = await c.req.json<{ name?: string; tone?: string }>();
  const trimmed = (name ?? "").trim();
  if (!trimmed) return c.json({ error: "Label name is required" }, 400);
  if (trimmed.length > 40) return c.json({ error: "Label names are capped at 40 characters" }, 400);

  const id = shortId();
  try {
    await c.env.DB.prepare(
      "INSERT INTO labels (id, name, tone, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(id, trimmed, tone, Date.now())
      .run();
  } catch {
    // UNIQUE(name) — return the existing label rather than an error, so
    // creating a label twice is harmless.
    const existing = await c.env.DB.prepare("SELECT id, name, tone FROM labels WHERE name = ?")
      .bind(trimmed)
      .first<Label>();
    return c.json(existing);
  }
  return c.json({ id, name: trimmed, tone: tone as Label["tone"] } satisfies Label);
});

workspace.delete("/labels/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM labels WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

// ── identities (send-as addresses) ──────────────────────────────────────────

workspace.get("/identities", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, address, name, signature_html, is_default FROM identities ORDER BY is_default DESC, address",
  ).all<{
    id: string;
    address: string;
    name: string | null;
    signature_html: string | null;
    is_default: number;
  }>();

  const identities: Identity[] = (results ?? []).map((row) => ({
    id: row.id,
    address: row.address,
    name: row.name,
    signatureHtml: row.signature_html,
    isDefault: row.is_default === 1,
  }));

  // First run: seed from DEFAULT_FROM so Compose is usable immediately.
  if (identities.length === 0) {
    const id = shortId();
    await c.env.DB.prepare(
      "INSERT INTO identities (id, address, name, is_default, created_at) VALUES (?, ?, ?, 1, ?)",
    )
      .bind(id, c.env.DEFAULT_FROM, null, Date.now())
      .run();
    identities.push({
      id,
      address: c.env.DEFAULT_FROM,
      name: null,
      signatureHtml: null,
      isDefault: true,
    });
  }

  return c.json(identities);
});

workspace.post("/identities", async (c) => {
  const body = await c.req.json<{
    id?: string;
    address?: string;
    name?: string;
    signatureHtml?: string;
    isDefault?: boolean;
  }>();

  const address = (body.address ?? "").trim().toLowerCase();
  if (!isValidAddress(address)) return c.json({ error: "Not a valid email address" }, 400);
  if (!address.endsWith(`@${c.env.MAIL_DOMAIN}`)) {
    return c.json(
      {
        error: `Identities must be on @${c.env.MAIL_DOMAIN}.`,
        hint: "Because the catch-all rule routes the whole domain here, any local part works — no setup needed.",
      },
      400,
    );
  }

  const id = body.id ?? shortId();
  const statements = [
    c.env.DB.prepare(
      `INSERT INTO identities (id, address, name, signature_html, is_default, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (address) DO UPDATE SET
         name = excluded.name,
         signature_html = excluded.signature_html,
         is_default = excluded.is_default`,
    ).bind(
      id,
      address,
      body.name ?? null,
      body.signatureHtml ?? null,
      body.isDefault ? 1 : 0,
      Date.now(),
    ),
  ];
  if (body.isDefault) {
    statements.unshift(
      c.env.DB.prepare("UPDATE identities SET is_default = 0 WHERE address != ?").bind(address),
    );
  }
  await c.env.DB.batch(statements);

  return c.json({ ok: true, id, address });
});

workspace.delete("/identities/:id", async (c) => {
  const id = c.req.param("id");
  const remaining = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM identities").first<{
    n: number;
  }>();
  if ((remaining?.n ?? 0) <= 1) {
    return c.json({ error: "Keep at least one address to send from." }, 400);
  }
  await c.env.DB.prepare("DELETE FROM identities WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// ── templates ───────────────────────────────────────────────────────────────

workspace.get("/templates", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, subject, body, shortcut, updated_at FROM templates ORDER BY name COLLATE NOCASE",
  ).all<{
    id: string;
    name: string;
    subject: string;
    body: string;
    shortcut: string | null;
    updated_at: number;
  }>();

  return c.json(
    (results ?? []).map(
      (row): Template => ({
        id: row.id,
        name: row.name,
        subject: row.subject,
        body: row.body,
        shortcut: row.shortcut,
        updatedAt: row.updated_at,
      }),
    ),
  );
});

workspace.post("/templates", async (c) => {
  const body = await c.req.json<Partial<Template>>();
  const name = (body.name ?? "").trim();
  if (!name) return c.json({ error: "Template name is required" }, 400);

  const id = body.id ?? shortId();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO templates (id, name, subject, body, shortcut, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       name = excluded.name, subject = excluded.subject,
       body = excluded.body, shortcut = excluded.shortcut,
       updated_at = excluded.updated_at`,
  )
    .bind(id, name, body.subject ?? "", body.body ?? "", body.shortcut ?? null, now, now)
    .run();

  return c.json({ id, name, subject: body.subject ?? "", body: body.body ?? "", updatedAt: now });
});

workspace.delete("/templates/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM templates WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

// ── contacts ────────────────────────────────────────────────────────────────

/** Autocomplete source for Compose. Ranked by how much you actually write to them. */
workspace.get("/contacts", async (c) => {
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const limit = Math.min(Number(c.req.query("limit") ?? 8), 50);

  const { results } = q
    ? await c.env.DB.prepare(
        `SELECT address, name, message_count, is_favorite, last_seen_at
           FROM contacts
          WHERE address LIKE ?1 OR lower(COALESCE(name, '')) LIKE ?1
          ORDER BY is_favorite DESC, message_count DESC, last_seen_at DESC
          LIMIT ?2`,
      )
        .bind(`%${q}%`, limit)
        .all<{
          address: string;
          name: string | null;
          message_count: number;
          is_favorite: number;
          last_seen_at: number;
        }>()
    : await c.env.DB.prepare(
        `SELECT address, name, message_count, is_favorite, last_seen_at
           FROM contacts
          ORDER BY is_favorite DESC, message_count DESC, last_seen_at DESC
          LIMIT ?`,
      )
        .bind(limit)
        .all<{
          address: string;
          name: string | null;
          message_count: number;
          is_favorite: number;
          last_seen_at: number;
        }>();

  return c.json(
    (results ?? []).map(
      (row): Contact => ({
        address: row.address,
        name: row.name,
        messageCount: row.message_count,
        isFavorite: row.is_favorite === 1,
        lastSeenAt: row.last_seen_at,
      }),
    ),
  );
});

workspace.post("/contacts/:address/favorite", async (c) => {
  const address = decodeURIComponent(c.req.param("address")).toLowerCase();
  const { favorite } = await c.req.json<{ favorite?: boolean }>();
  await c.env.DB.prepare("UPDATE contacts SET is_favorite = ? WHERE address = ?")
    .bind(favorite ? 1 : 0, address)
    .run();
  return c.json({ ok: true });
});

// ── settings ────────────────────────────────────────────────────────────────

workspace.get("/settings", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT key, value FROM settings").all<{
    key: string;
    value: string;
  }>();
  const settings: Record<string, unknown> = {};
  for (const row of results ?? []) {
    try {
      settings[row.key] = JSON.parse(row.value);
    } catch {
      settings[row.key] = row.value;
    }
  }
  return c.json(settings);
});

workspace.patch("/settings", async (c) => {
  const patch = await c.req.json<Record<string, unknown>>();
  const now = Date.now();
  const statements = Object.entries(patch).map(([key, value]) =>
    c.env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(key, JSON.stringify(value), now),
  );
  if (statements.length > 0) await c.env.DB.batch(statements);
  return c.json({ ok: true });
});

// ── stats ───────────────────────────────────────────────────────────────────

/**
 * Sidebar counts and free-tier headroom.
 *
 * The quota block is here because "why did my email not send" should be
 * answerable before you hit send, not after.
 */
workspace.get("/stats", async (c) => {
  const now = Date.now();

  const { results: folderRows } = await c.env.DB.prepare(
    `SELECT folder,
            COUNT(DISTINCT thread_id) AS threads,
            SUM(CASE WHEN is_read = 0 AND direction = 'inbound' THEN 1 ELSE 0 END) AS unread
       FROM messages
      WHERE (snoozed_until IS NULL OR snoozed_until <= ?)
      GROUP BY folder`,
  )
    .bind(now)
    .all<{ folder: string; threads: number; unread: number }>();

  const counts = {} as Record<Folder, number>;
  const unread = {} as Record<Folder, number>;
  for (const row of folderRows ?? []) {
    counts[row.folder as Folder] = row.threads;
    unread[row.folder as Folder] = row.unread ?? 0;
  }

  const starred = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM threads WHERE is_starred = 1",
  ).first<{ n: number }>();

  const storage = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM messages) AS messages,
            (SELECT COALESCE(SUM(size), 0) FROM attachments WHERE content IS NOT NULL) AS bytes`,
  ).first<{ messages: number; bytes: number }>();

  const quota = await readQuota(c.env);
  const provider = getProvider(c.env);

  const stats: Stats = {
    counts,
    unread,
    starred: starred?.n ?? 0,
    quota: {
      provider: provider.id,
      providerLabel: provider.label,
      sentToday: quota.sentToday,
      sentThisMonth: quota.sentThisMonth,
      dailyLimit: provider.limits.daily,
      monthlyLimit: provider.limits.monthly,
      monthlyIsHardCap: provider.limits.monthlyIsHardCap,
      note: provider.limits.note,
    },
    storage: {
      messages: storage?.messages ?? 0,
      attachmentBytes: storage?.bytes ?? 0,
    },
  };
  return c.json(stats);
});

// ── access log ──────────────────────────────────────────────────────────────

/**
 * Who was here, and what they changed.
 *
 * Newest first and capped, because this is a thing you scan rather than page
 * through — if the answer is not near the top, the question is usually "when
 * did this start", which the date on the last row answers just as well.
 */
workspace.get("/audit", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 250);

  const { results } = await c.env.DB.prepare(
    `SELECT id, session_id, action, detail, ip, country, user_agent, created_at
       FROM audit
      ORDER BY created_at DESC
      LIMIT ?`,
  )
    .bind(limit)
    .all<{
      id: string;
      session_id: string | null;
      action: string;
      detail: string | null;
      ip: string | null;
      country: string | null;
      user_agent: string | null;
      created_at: number;
    }>();

  return c.json(
    (results ?? []).map(
      (row): AuditEntry => ({
        id: row.id,
        sessionId: row.session_id,
        action: row.action,
        detail: row.detail,
        ip: row.ip,
        country: row.country,
        userAgent: row.user_agent,
        createdAt: row.created_at,
      }),
    ),
  );
});

// ── activity ────────────────────────────────────────────────────────────────

workspace.get("/events", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, type, message_id, thread_id, detail, created_at FROM events ORDER BY created_at DESC LIMIT 60",
  ).all<{
    id: string;
    type: string;
    message_id: string | null;
    thread_id: string | null;
    detail: string | null;
    created_at: number;
  }>();

  return c.json(
    (results ?? []).map(
      (row): ActivityEvent => ({
        id: row.id,
        type: row.type,
        messageId: row.message_id,
        threadId: row.thread_id,
        detail: row.detail,
        createdAt: row.created_at,
      }),
    ),
  );
});

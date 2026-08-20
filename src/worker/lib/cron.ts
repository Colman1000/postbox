import type { Env } from "../env.ts";
import { logEvent, recomputeThread } from "./db.ts";
import { deliver } from "../routes/compose.ts";

/**
 * The once-a-minute tick.
 *
 * Two jobs, both of which have to be idempotent because a cron can overlap
 * with itself: flush anything scheduled for the past, and wake snoozed
 * conversations. A minute is the finest granularity Cloudflare cron offers,
 * which is why "send later" rounds to the minute in the UI.
 */
export async function runScheduledWork(env: Env): Promise<void> {
  const now = Date.now();

  // ── send-later ────────────────────────────────────────────────────────────
  const { results: due } = await env.DB.prepare(
    `SELECT id FROM messages
      WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?
      ORDER BY scheduled_at ASC
      LIMIT 20`,
  )
    .bind(now)
    .all<{ id: string }>();

  for (const row of due ?? []) {
    // Claim the row first. If a second invocation is already running, its
    // UPDATE matches nothing and it skips the message instead of double-sending.
    const claim = await env.DB.prepare(
      `UPDATE messages SET status = 'queued', updated_at = ?
        WHERE id = ? AND status = 'scheduled'`,
    )
      .bind(now, row.id)
      .run();

    if ((claim.meta?.changes ?? 0) === 0) continue;

    await deliver(env, row.id);
  }

  // ── snooze ────────────────────────────────────────────────────────────────
  const { results: waking } = await env.DB.prepare(
    `SELECT DISTINCT thread_id FROM messages
      WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?
      LIMIT 50`,
  )
    .bind(now)
    .all<{ thread_id: string }>();

  if ((waking ?? []).length > 0) {
    const ids = waking!.map((r) => r.thread_id);
    const placeholders = ids.map(() => "?").join(", ");

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE messages
            SET snoozed_until = NULL,
                folder = CASE WHEN direction = 'inbound' AND folder = 'archive' THEN 'inbox' ELSE folder END,
                is_read = CASE WHEN direction = 'inbound' THEN 0 ELSE is_read END,
                updated_at = ?
          WHERE thread_id IN (${placeholders}) AND snoozed_until IS NOT NULL`,
      ).bind(now, ...ids),
      logEvent(env.DB, "unsnoozed", `${ids.length} conversation(s)`),
    ]);

    const summaries = await Promise.all(ids.map((id) => recomputeThread(env.DB, id)));
    const valid = summaries.filter((s): s is D1PreparedStatement => s !== null);
    if (valid.length > 0) await env.DB.batch(valid);
  }
}

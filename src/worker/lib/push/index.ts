import type { Arrival, PushDevice } from "../../../shared/types.ts";
import type { Env } from "../../env.ts";
import { fromBase64url } from "../base64.ts";
import { ulid } from "../ids.ts";
import { encryptPayload, MAX_PAYLOAD_BYTES } from "./encrypt.ts";
import { vapidHeader, type VapidKeys } from "./vapid.ts";

/**
 * Mail that arrives while nothing is open.
 *
 * The Durable Object in mailbox.ts rings tabs; this rings devices. They are
 * deliberately separate mechanisms with separate failure modes — a socket
 * reaches a tab in milliseconds and reaches nothing at all once the tab is
 * closed, and a push reaches a locked phone but goes through two companies'
 * infrastructure to get there.
 *
 * Where the doorbell carries nothing and lets the tab come back and ask, a
 * push carries the subject and the sender. That is the opposite choice, made
 * for a reason: iOS holds a subscription against a service worker that
 * receives a push and shows no notification, and a service worker that has to
 * fetch before it can show one is a service worker that shows nothing when the
 * network is slow. The payload is encrypted to the device's own keys, so
 * carrying the subject costs no more privacy than the doorbell's silence
 * bought.
 */

/**
 * How long a push service should hold a message for a device that is offline.
 *
 * Six hours: long enough that a phone which was in a bag all afternoon still
 * says what arrived, short enough that yesterday's mail does not turn up as
 * this morning's notification.
 */
const TTL_SECONDS = 6 * 60 * 60;

/**
 * Consecutive failures before an endpoint is retired.
 *
 * A push service that means "this subscription is dead" says 404 or 410 and
 * the row goes immediately. This is for the ones that never say anything
 * conclusive — a browser profile that was deleted can leave an endpoint
 * timing out indefinitely.
 */
const MAX_FAILURES = 10;

export interface StoredSubscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** What the UI shows in Settings, and what a push is addressed to. */
interface SubscriptionRow extends StoredSubscription {
  session_id: string | null;
  user_agent: string | null;
  created_at: number;
  last_success_at: number | null;
  failure_count: number;
}

/**
 * Whether this deployment can push at all.
 *
 * Deployments made before push existed have no keypair bound, and the UI needs
 * to say so plainly rather than offering a switch that silently does nothing.
 */
export function pushConfigured(env: Env): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

function keysFrom(env: Env): VapidKeys {
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
}

// ── the store ────────────────────────────────────────────────────────────────

/**
 * Register an install, or update the one already registered.
 *
 * A browser can hand back a subscription whose endpoint we already hold — the
 * same install re-subscribing after its keys rotated — so the endpoint is the
 * identity and the rest is overwritten. Re-subscribing also clears the failure
 * count: whatever was wrong with the old registration, this is a new one.
 */
export async function saveSubscription(
  db: D1Database,
  input: {
    endpoint: string;
    p256dh: string;
    auth: string;
    sessionId: string | null;
    userAgent: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO push_subscriptions
         (id, endpoint, p256dh, auth, session_id, user_agent, created_at, failure_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT (endpoint) DO UPDATE SET
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         session_id = excluded.session_id,
         user_agent = excluded.user_agent,
         failure_count = 0`,
    )
    .bind(
      ulid(),
      input.endpoint,
      input.p256dh,
      input.auth,
      input.sessionId,
      input.userAgent,
      Date.now(),
    )
    .run();
}

export async function deleteSubscription(db: D1Database, endpoint: string): Promise<void> {
  await db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run();
}

/**
 * Revoke everything one sign-in registered.
 *
 * Signing out of a phone should stop that phone announcing mail it can no
 * longer open. The device does the polite thing and unsubscribes itself first;
 * this is what covers the sign-out that happened from somewhere else.
 */
export async function deleteSessionSubscriptions(
  db: D1Database,
  sessionId: string,
): Promise<void> {
  await db.prepare("DELETE FROM push_subscriptions WHERE session_id = ?").bind(sessionId).run();
}

export async function listSubscriptions(db: D1Database): Promise<PushDevice[]> {
  const { results } = await db
    .prepare(
      `SELECT endpoint, user_agent, created_at, last_success_at
         FROM push_subscriptions
        ORDER BY created_at DESC`,
    )
    .all<{
      endpoint: string;
      user_agent: string | null;
      created_at: number;
      last_success_at: number | null;
    }>();

  return (results ?? []).map((row) => ({
    endpoint: row.endpoint,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    lastSuccessAt: row.last_success_at,
  }));
}

async function allSubscriptions(db: D1Database): Promise<SubscriptionRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, endpoint, p256dh, auth, session_id, user_agent,
              created_at, last_success_at, failure_count
         FROM push_subscriptions`,
    )
    .all<SubscriptionRow>();
  return results ?? [];
}

// ── delivery ─────────────────────────────────────────────────────────────────

export type DeliveryOutcome = "sent" | "gone" | "failed";

/**
 * One push, to one device.
 *
 * `Topic` is what makes a burst survivable. A push service holds at most one
 * undelivered message per topic per subscription, so three replies to the same
 * conversation while the phone is off become one notification when it comes
 * back rather than three — and two different conversations still arrive as
 * two, because the topic is the conversation.
 */
async function deliver(
  env: Env,
  subscription: StoredSubscription,
  payload: string,
  topic?: string,
): Promise<DeliveryOutcome> {
  const body = await encryptPayload(payload, {
    p256dh: fromBase64url(subscription.p256dh),
    auth: fromBase64url(subscription.auth),
  });

  const headers: Record<string, string> = {
    Authorization: await vapidHeader(keysFrom(env), subscription.endpoint, env.DEFAULT_FROM),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(TTL_SECONDS),
    // Mail is the thing the phone was asked to wake up for.
    Urgency: "high",
  };
  if (topic) headers.Topic = topic;

  let response: Response;
  try {
    response = await fetch(subscription.endpoint, { method: "POST", headers, body });
  } catch (error) {
    console.error("push failed", { endpoint: subscription.endpoint, error: String(error) });
    return "failed";
  }

  // The two verdicts that mean "stop trying": the endpoint was never valid, or
  // it has been retired by the push service because the app was uninstalled.
  if (response.status === 404 || response.status === 410) return "gone";
  if (response.ok) return "sent";

  // Worth the log line: a 401 or 403 here means the VAPID keypair and the
  // registered subscriptions have got out of step, which is invisible from the
  // UI and would otherwise present as notifications that simply stopped.
  console.error("push rejected", {
    endpoint: new URL(subscription.endpoint).origin,
    status: response.status,
    detail: (await response.text().catch(() => "")).slice(0, 200),
  });
  return "failed";
}

/**
 * Record what happened, and retire endpoints that are past helping.
 *
 * Written as one batch after the whole fan-out rather than per device: this
 * runs inside `waitUntil` on the inbound path, where every extra round trip to
 * D1 is time the Worker stays alive for a message that is already delivered.
 */
async function reconcile(
  db: D1Database,
  outcomes: { subscription: SubscriptionRow; outcome: DeliveryOutcome }[],
): Promise<void> {
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];

  const gone = outcomes
    .filter(
      ({ subscription, outcome }) =>
        outcome === "gone" ||
        (outcome === "failed" && subscription.failure_count + 1 >= MAX_FAILURES),
    )
    .map(({ subscription }) => subscription.id);

  if (gone.length > 0) {
    statements.push(
      db.prepare(
        `DELETE FROM push_subscriptions WHERE id IN (${gone.map(() => "?").join(", ")})`,
      ).bind(...gone),
    );
  }

  const sent = outcomes.filter((o) => o.outcome === "sent").map((o) => o.subscription.id);
  if (sent.length > 0) {
    statements.push(
      db
        .prepare(
          `UPDATE push_subscriptions SET last_success_at = ?, failure_count = 0
            WHERE id IN (${sent.map(() => "?").join(", ")})`,
        )
        .bind(now, ...sent),
    );
  }

  const failed = outcomes
    .filter((o) => o.outcome === "failed" && !gone.includes(o.subscription.id))
    .map((o) => o.subscription.id);
  if (failed.length > 0) {
    statements.push(
      db
        .prepare(
          `UPDATE push_subscriptions SET failure_count = failure_count + 1
            WHERE id IN (${failed.map(() => "?").join(", ")})`,
        )
        .bind(...failed),
    );
  }

  if (statements.length > 0) await db.batch(statements);
}

/** Send one payload to every registered device, then tidy up after it. */
async function fanOut(env: Env, payload: string, topic?: string): Promise<number> {
  const subscriptions = await allSubscriptions(env.DB);
  if (subscriptions.length === 0) return 0;

  const outcomes = await Promise.all(
    subscriptions.map(async (subscription) => ({
      subscription,
      outcome: await deliver(env, subscription, payload, topic).catch((error): DeliveryOutcome => {
        console.error("push threw", { error: String(error) });
        return "failed";
      }),
    })),
  );

  await reconcile(env.DB, outcomes);
  return outcomes.filter((o) => o.outcome === "sent").length;
}

// ── what a notification says ─────────────────────────────────────────────────

/**
 * Kept short on purpose. A lock screen shows about this much and a push
 * service will refuse an oversized body outright, so the trimming happens here
 * rather than being discovered as a delivery failure.
 */
const MAX_TITLE = 120;
const MAX_BODY = 180;

function trim(value: string, limit: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function nameOf(from: Arrival["from"]): string {
  return from.name?.trim() || from.address;
}

/**
 * The payload, which `public/sw.js` renders.
 *
 * Both sides of this shape are in this repository and neither is versioned, so
 * a field added here has to be tolerated by a service worker that a phone
 * installed weeks ago and has not updated. The worker reads defensively for
 * that reason.
 */
export interface PushPayload {
  title: string;
  body: string;
  /** Replaces rather than stacks: a conversation gets one notification. */
  tag: string;
  /** Where clicking it should land. */
  threadId: string | null;
  /** Inbox unread count, for the home-screen badge. */
  unread: number;
}

/**
 * Announce what just arrived.
 *
 * A single message names its sender and subject. A burst is summarised,
 * because four separate notifications for four newsletters is the behaviour
 * that gets notifications switched off.
 */
export async function announceArrivals(
  env: Env,
  arrivals: Arrival[],
  unread: number,
): Promise<number> {
  if (!pushConfigured(env) || arrivals.length === 0) return 0;

  const single = arrivals.length === 1 ? arrivals[0] : null;

  const payload: PushPayload = single
    ? {
        title: trim(single.subject || single.snippet || "(no subject)", MAX_TITLE),
        body: trim(nameOf(single.from), MAX_BODY),
        tag: single.threadId,
        threadId: single.threadId,
        unread,
      }
    : {
        title: `${arrivals.length} new messages`,
        body: trim(arrivals.map((a) => nameOf(a.from)).join(", "), MAX_BODY),
        tag: "postbox-batch",
        threadId: null,
        unread,
      };

  return send(env, payload, single ? single.threadId : undefined);
}

/** The switch in Settings, proving the whole path works end to end. */
export async function announceTest(env: Env, unread: number): Promise<number> {
  return send(
    env,
    {
      title: "Postbox notifications are working",
      body: "This is what new mail will look like.",
      tag: "postbox-test",
      threadId: null,
      unread,
    },
    "postbox-test",
  );
}

async function send(env: Env, payload: PushPayload, topic?: string): Promise<number> {
  const encoded = JSON.stringify(payload);
  if (encoded.length > MAX_PAYLOAD_BYTES) {
    // Only reachable if the trimming above ever stops matching the limits, and
    // a dropped notification is better than a throw on the inbound path.
    console.error("push payload too large", { bytes: encoded.length });
    return 0;
  }
  return fanOut(env, encoded, topic);
}

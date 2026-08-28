import { Hono } from "hono";
import type { PushDevice } from "../../shared/types.ts";
import {
  announceTest,
  deleteSubscription,
  listSubscriptions,
  pushConfigured,
  saveSubscription,
} from "../lib/push/index.ts";
import { unreadCount } from "../lib/db.ts";
import type { App } from "./context.ts";

/**
 * Registering a device for push, and unregistering it again.
 *
 * All of this sits behind the same session gate as the rest of the API, which
 * matters more here than elsewhere: an unauthenticated subscribe endpoint
 * would let anyone point their own phone at your mailbox and receive your
 * subject lines.
 */
export const push = new Hono<App>();

/** Loose sanity checks. The push service does the real validation. */
const KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

function looksLikeEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

push.post("/subscribe", async (c) => {
  if (!pushConfigured(c.env)) {
    return c.json(
      {
        error: "This deployment has no push keys.",
        hint: "Run `just up` to generate them, then try again.",
      },
      503,
    );
  }

  const body = await c.req
    .json<{ endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }>()
    .catch(() => ({}) as Record<string, never>);

  const endpoint = body.endpoint;
  const p256dh = body.keys?.p256dh;
  const auth = body.keys?.auth;

  if (!looksLikeEndpoint(endpoint)) {
    return c.json({ error: "That is not a push endpoint." }, 400);
  }
  if (
    typeof p256dh !== "string" ||
    typeof auth !== "string" ||
    !KEY_PATTERN.test(p256dh) ||
    !KEY_PATTERN.test(auth)
  ) {
    return c.json({ error: "The subscription is missing its keys." }, 400);
  }

  await saveSubscription(c.env.DB, {
    endpoint,
    p256dh,
    auth,
    // Tied to the sign-in, so signing out takes the registration with it.
    sessionId: c.get("sessionId"),
    userAgent: c.req.header("user-agent") ?? null,
  });

  c.set("auditDetail", "enabled push notifications on a device");
  return c.json({ ok: true });
});

/**
 * Deliberately a POST rather than a DELETE with a body.
 *
 * A DELETE carrying a body is the kind of request intermediaries feel entitled
 * to strip, and the endpoint is the only thing identifying which registration
 * to remove. It is also called on the way out of a session — before the cookie
 * is cleared, so it still authenticates — and a sign-out that leaves the
 * registration behind is a phone that keeps announcing mail nobody on it can
 * open.
 */
push.post("/unsubscribe", async (c) => {
  const { endpoint } = await c.req
    .json<{ endpoint?: unknown }>()
    .catch(() => ({}) as { endpoint?: unknown });

  if (!looksLikeEndpoint(endpoint)) return c.json({ error: "That is not a push endpoint." }, 400);

  await deleteSubscription(c.env.DB, endpoint);
  c.set("auditDetail", "disabled push notifications on a device");
  return c.json({ ok: true });
});

/** What Settings lists, so a device registered months ago can be recognised. */
push.get("/devices", async (c) => {
  const devices: PushDevice[] = pushConfigured(c.env)
    ? await listSubscriptions(c.env.DB)
    : [];
  return c.json(devices);
});

/**
 * Prove the whole path works.
 *
 * Worth its own endpoint because every part of push is invisible until it
 * fails: the permission prompt, the subscription, the keypair, the push
 * service and the service worker are five things between a switch and a
 * notification, and "nothing happened" is the same symptom for all of them.
 */
push.post("/test", async (c) => {
  if (!pushConfigured(c.env)) {
    return c.json({ error: "This deployment has no push keys." }, 503);
  }

  const delivered = await announceTest(c.env, await unreadCount(c.env.DB));
  if (delivered === 0) {
    return c.json(
      {
        error: "No device took the notification.",
        hint: "Switch push on from the installed app, then try again from there.",
      },
      409,
    );
  }
  return c.json({ ok: true, delivered });
});

import { Hono } from "hono";
import type { SessionInfo } from "../../shared/types.ts";
import {
  clearCookie,
  constantTimeEqual,
  createSession,
  newSessionId,
  sessionCookie,
} from "../lib/auth.ts";
import { actorFrom, recordAudit } from "../lib/audit.ts";
import { deleteSessionSubscriptions, pushConfigured } from "../lib/push/index.ts";
import type { App } from "./context.ts";

/**
 * Sign-in.
 *
 * Failed attempts are rate-limited per IP in KV. Without that, a public
 * mailbox behind a single password is a weekend of brute force away from being
 * a spam relay.
 */
const MAX_ATTEMPTS = 8;
const LOCKOUT_SECONDS = 15 * 60;

export const auth = new Hono<App>();

auth.get("/session", async (c) => {
  const sendingReady =
    c.env.SENDING_READY === "1" || (await c.env.CACHE.get("sending:ready")) === "1";
  const info: SessionInfo = {
    authenticated: c.get("authenticated") ?? false,
    domain: c.env.MAIL_DOMAIN,
    defaultFrom: c.env.DEFAULT_FROM,
    appHostname: c.env.APP_HOSTNAME,
    stage: c.env.STAGE,
    sendingReady,
    // Public by design, and sent unauthenticated for the same reason the rest
    // of this response is: the login screen is served by the same app shell,
    // and asking for it separately after sign-in would be a second round trip
    // for a value that never changes.
    vapidKey: pushConfigured(c.env) ? c.env.VAPID_PUBLIC_KEY : null,
  };
  return c.json(info);
});

auth.post("/login", async (c) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const attemptKey = `login:attempts:${ip}`;
  const attempts = Number((await c.env.CACHE.get(attemptKey)) ?? 0);

  if (attempts >= MAX_ATTEMPTS) {
    // Worth a row of its own: repeated blocks from one address are the shape
    // an attack makes in the log.
    c.executionCtx.waitUntil(
      recordAudit(c.env.DB, actorFrom(c), "sign-in-blocked", `${attempts} failed attempts`),
    );
    return c.json(
      {
        error: "Too many attempts. Try again in 15 minutes.",
      },
      429,
    );
  }

  const body = await c.req.json<{ password?: string }>().catch(() => ({}) as { password?: string });
  const password = body.password ?? "";

  if (!(await constantTimeEqual(password, c.env.APP_PASSWORD))) {
    await c.env.CACHE.put(attemptKey, String(attempts + 1), {
      expirationTtl: LOCKOUT_SECONDS,
    });
    c.executionCtx.waitUntil(
      recordAudit(c.env.DB, actorFrom(c), "sign-in-failed", `attempt ${attempts + 1}`),
    );
    // Deliberately vague, and deliberately slow enough to be uninteresting.
    await new Promise((r) => setTimeout(r, 400));
    return c.json({ error: "Incorrect password." }, 401);
  }

  await c.env.CACHE.delete(attemptKey);
  const sessionId = newSessionId();
  const token = await createSession(c.env.AUTH_SECRET, sessionId);
  const secure = new URL(c.req.url).protocol === "https:";

  // The one row that answers "who came in": stamped with the session id every
  // later action in this sign-in will carry.
  c.executionCtx.waitUntil(
    recordAudit(c.env.DB, { ...actorFrom(c), sessionId }, "sign-in", "password accepted"),
  );

  c.header("Set-Cookie", sessionCookie(token, secure));
  return c.json({ ok: true });
});

auth.post("/logout", (c) => {
  const secure = new URL(c.req.url).protocol === "https:";
  const sessionId = c.get("sessionId");

  if (c.get("authenticated")) {
    c.executionCtx.waitUntil(recordAudit(c.env.DB, actorFrom(c), "sign-out", null));

    // Whatever this sign-in registered for push goes with it. The device
    // unsubscribes itself on the way out too, but that is a request it might
    // not get to make — a phone signed out from another machine, a browser
    // closed mid-flight — and a device that keeps announcing mail nobody on it
    // can open is worse than one that goes quiet a moment early.
    if (sessionId) {
      c.executionCtx.waitUntil(
        deleteSessionSubscriptions(c.env.DB, sessionId).catch((error) =>
          console.error("revoking push on sign-out failed", { error: String(error) }),
        ),
      );
    }
  }

  c.header("Set-Cookie", clearCookie(secure));
  return c.json({ ok: true });
});

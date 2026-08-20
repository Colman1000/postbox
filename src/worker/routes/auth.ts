import { Hono } from "hono";
import type { SessionInfo } from "../../shared/types.ts";
import {
  clearCookie,
  constantTimeEqual,
  createSession,
  sessionCookie,
} from "../lib/auth.ts";
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
  };
  return c.json(info);
});

auth.post("/login", async (c) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const attemptKey = `login:attempts:${ip}`;
  const attempts = Number((await c.env.CACHE.get(attemptKey)) ?? 0);

  if (attempts >= MAX_ATTEMPTS) {
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
    // Deliberately vague, and deliberately slow enough to be uninteresting.
    await new Promise((r) => setTimeout(r, 400));
    return c.json({ error: "Incorrect password." }, 401);
  }

  await c.env.CACHE.delete(attemptKey);
  const token = await createSession(c.env.AUTH_SECRET);
  const secure = new URL(c.req.url).protocol === "https:";

  c.header("Set-Cookie", sessionCookie(token, secure));
  return c.json({ ok: true });
});

auth.post("/logout", (c) => {
  const secure = new URL(c.req.url).protocol === "https:";
  c.header("Set-Cookie", clearCookie(secure));
  return c.json({ ok: true });
});

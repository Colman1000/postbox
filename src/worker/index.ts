import { Hono } from "hono";
import type { Env, Vars } from "./env.ts";
import { readCookie, verifySession } from "./lib/auth.ts";
import { handleInboundEmail } from "./lib/inbound.ts";
import { runScheduledWork } from "./lib/cron.ts";
import { auth } from "./routes/auth.ts";
import { compose } from "./routes/compose.ts";
import { mail } from "./routes/mail.ts";
import { workspace } from "./routes/workspace.ts";

/**
 * Postbox — one Worker, three entry points.
 *
 *   fetch()      the React UI (served from static assets) and the JSON API
 *   email()      every message sent to the domain, via Email Routing
 *   scheduled()  a once-a-minute tick for send-later and snooze
 *
 * Keeping them in one script is what makes the deploy a single artifact: the
 * inbound handler and the API share the same database binding and the same
 * code for threading, so a message looks identical however it arrived.
 */

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

/** Endpoints reachable without a session. Everything else is gated. */
const PUBLIC_PATHS = new Set(["/api/auth/login", "/api/auth/session", "/api/health"]);

app.use("/api/*", async (c, next) => {
  const token = readCookie(c.req.header("cookie") ?? null);
  const authenticated = token ? await verifySession(c.env.AUTH_SECRET, token) : false;
  c.set("authenticated", authenticated);

  if (!authenticated && !PUBLIC_PATHS.has(new URL(c.req.url).pathname)) {
    return c.json({ error: "Not signed in" }, 401);
  }

  // The API is same-origin only and never cacheable — mail is not public data.
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  return next();
});

app.get("/api/health", (c) => c.json({ ok: true, stage: c.env.STAGE }));

app.route("/api/auth", auth);
app.route("/api", mail);
app.route("/api", compose);
app.route("/api", workspace);

app.notFound((c) =>
  c.req.path.startsWith("/api/")
    ? c.json({ error: `No API route for ${c.req.method} ${c.req.path}` }, 404)
    : // Anything else is a client route; hand it back to the SPA shell.
      c.env.ASSETS.fetch(c.req.raw),
);

app.onError((error, c) => {
  console.error("unhandled", { path: c.req.path, error: String(error) });
  return c.json(
    {
      error: "Something went wrong handling that request.",
      detail: error instanceof Error ? error.message : String(error),
    },
    500,
  );
});

export default {
  fetch: app.fetch,

  async email(message, env, ctx) {
    try {
      await handleInboundEmail(message, env, ctx);
    } catch (error) {
      // Never let a parse failure bounce the sender's message. Log it, keep
      // the forwarded copy (already sent), and move on.
      console.error("inbound failed", {
        from: message.from,
        to: message.to,
        error: String(error),
      });
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runScheduledWork(env));
  },
} satisfies ExportedHandler<Env>;

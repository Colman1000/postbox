import { Hono } from "hono";
import type { Env, Vars } from "./env.ts";
import { readCookie, readSession } from "./lib/auth.ts";
import { actorFrom, describeRequest, recordAudit } from "./lib/audit.ts";
import { handleInboundEmail } from "./lib/inbound.ts";
import { runScheduledWork } from "./lib/cron.ts";
import { Mailbox } from "./mailbox.ts";
import { auth } from "./routes/auth.ts";
import { compose } from "./routes/compose.ts";
import { icon, iconAdmin } from "./routes/icon.ts";
import { mail } from "./routes/mail.ts";
import { push } from "./routes/push.ts";
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

/**
 * Requests that change something, and are therefore worth remembering.
 *
 * GETs are left out on purpose: logging every poll would bury the three rows
 * that matter under thousands that do not, and reading your own mail is not
 * the thing an access log exists to catch.
 */
const AUDITED_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** Mutations that are noise rather than history. */
const AUDIT_IGNORED = new Set(["/api/drafts", "/api/auth/login", "/api/auth/logout"]);

app.use("/api/*", async (c, next) => {
  const token = readCookie(c.req.header("cookie") ?? null);
  const claims = token ? await readSession(c.env.AUTH_SECRET, token) : null;
  const authenticated = claims !== null;
  c.set("authenticated", authenticated);
  c.set("sessionId", claims?.sid ?? null);

  if (!authenticated && !PUBLIC_PATHS.has(new URL(c.req.url).pathname)) {
    return c.json({ error: "Not signed in" }, 401);
  }

  // The API is same-origin only and never cacheable — mail is not public data.
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");

  await next();

  // Recorded after the fact, so the log holds what actually happened rather
  // than what was attempted — and outside the response path, so an access log
  // never costs the user latency. Sign-in and sign-out record themselves,
  // since they are the two events that happen without a session in hand.
  const path = new URL(c.req.url).pathname;
  if (
    authenticated &&
    AUDITED_METHODS.has(c.req.method) &&
    !AUDIT_IGNORED.has(path) &&
    c.res.status < 400
  ) {
    const detail = c.get("auditDetail") ?? describeRequest(c.req.method, path);
    c.executionCtx.waitUntil(recordAudit(c.env.DB, actorFrom(c), "change", detail));
  }
});

app.get("/api/health", (c) => c.json({ ok: true, stage: c.env.STAGE }));

app.route("/api/auth", auth);
app.route("/api/push", push);
app.route("/api", mail);
app.route("/api", compose);
app.route("/api", workspace);
app.route("/api", iconAdmin);

/**
 * The home-screen identity, outside the API and outside its session gate.
 *
 * A manifest is fetched without credentials and an icon is fetched by the
 * operating system, so neither can live behind the cookie. They are mounted at
 * the root rather than under `/api` because iOS goes looking for
 * `/apple-touch-icon.png` by name — see routes/icon.ts, and the
 * `run_worker_first` list in alchemy.run.ts that lets these paths reach the
 * Worker at all.
 */
app.route("/", icon);

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

/**
 * The live channel, handled before Hono sees it.
 *
 * A 101 response has immutable headers, and the API middleware sets several on
 * everything it touches — so the upgrade is answered here rather than routed
 * through it. The session check is the same one the middleware performs; an
 * open socket into your mailbox is not something to leave ungated.
 */
async function handleUpgrade(request: Request, env: Env): Promise<Response> {
  const token = readCookie(request.headers.get("cookie"));
  const claims = token ? await readSession(env.AUTH_SECRET, token) : null;
  if (!claims) return new Response("Not signed in", { status: 401 });

  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }

  // One object for the whole mailbox: there is one inbox, and every tab
  // watching it wants the same doorbell.
  return env.MAILBOX.getByName("mailbox").fetch(request);
}

export { Mailbox };

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/api/live") {
      return handleUpgrade(request, env);
    }
    return app.fetch(request, env, ctx);
  },

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

import type { Context } from "hono";
import type { App } from "../routes/context.ts";
import { ulid } from "./ids.ts";

/**
 * The access log.
 *
 * One mailbox behind one password means there is no "who" in the usual sense,
 * so the honest answer is the sign-in: which session, from which address, on
 * which device. That is enough to answer the question this exists for — was
 * anyone here who should not have been, and what did they touch.
 *
 * Nothing here records message content. A subject line in an access log is a
 * copy of your mail in a second place, with none of the reasons you kept the
 * first one.
 */
export interface Actor {
  sessionId: string | null;
  ip: string | null;
  country: string | null;
  userAgent: string | null;
}

/** Long user-agent strings are stored trimmed; the UI summarises them further. */
const UA_MAX = 180;

export function actorFrom(c: Context<App>): Actor {
  const cf = (c.req.raw as { cf?: IncomingRequestCfProperties }).cf;
  return {
    sessionId: c.get("sessionId") ?? null,
    ip: c.req.header("cf-connecting-ip") ?? null,
    country: (cf?.country as string | undefined) ?? null,
    userAgent: c.req.header("user-agent")?.slice(0, UA_MAX) ?? null,
  };
}

export function auditStatement(
  db: D1Database,
  actor: Actor,
  action: string,
  detail?: string | null,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit (id, session_id, action, detail, ip, country, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      ulid(),
      actor.sessionId,
      action,
      detail ?? null,
      actor.ip,
      actor.country,
      actor.userAgent,
      Date.now(),
    );
}

/**
 * Write one row without making the caller wait.
 *
 * An access log that slows down every request is an access log people turn
 * off, and a failed insert must never turn a successful action into an error —
 * so this swallows its own failures deliberately.
 */
export function recordAudit(
  db: D1Database,
  actor: Actor,
  action: string,
  detail?: string | null,
): Promise<void> {
  return auditStatement(db, actor, action, detail)
    .run()
    .then(
      () => undefined,
      (error: unknown) => {
        console.error("audit write failed", { action, error: String(error) });
      },
    );
}

/**
 * What a mutating request did, in words, from its method and path alone.
 *
 * Routes that can say something more useful set `auditDetail` on the context
 * instead; this is the fallback that guarantees a new endpoint is still
 * covered on the day it is added, without anyone remembering to log it.
 */
export function describeRequest(method: string, path: string): string {
  const route = path.replace(/^\/api\//, "");
  const [head, ...rest] = route.split("/");
  const id = rest.filter((part) => part && !["actions", "labels", "cancel"].includes(part));

  const verb =
    method === "DELETE" ? "deleted" : method === "PATCH" ? "updated" : "changed";
  const noun = head.replace(/s$/, "");

  if (method === "DELETE") return `${verb} ${noun}${id.length ? ` ${id[0]}` : ""}`;
  return `${verb} ${route}`;
}

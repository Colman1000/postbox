import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";

/**
 * The doorbell.
 *
 * Cloudflare cannot push to a browser from a Worker — the `email()` handler
 * that receives your mail runs in a different invocation from the tab that
 * wants to know about it, with nothing shared between them. A Durable Object
 * is the one thing both can address, so this is where an open tab waits.
 *
 * It carries no mail. A message here says only "something changed"; the tab
 * then asks `/api/updates`, exactly as it does when polling. That keeps one
 * source of truth for what counts as new, keeps subjects and senders out of a
 * second system, and means the socket failing costs nothing but latency —
 * the poll is still there underneath.
 *
 * Cost, which is the reason for every choice here:
 *   - Hibernation. `acceptWebSocket` lets the object be evicted while its
 *     sockets stay connected, so an idle mailbox is billed no duration at all.
 *     `accept()` would have billed wall-clock time for the whole connection —
 *     roughly 11,000 of the free plan's 13,000 GB-s per day, for one open tab.
 *   - Auto-response. Keepalive pings are answered by the runtime without
 *     waking the object, so they cost no duration either.
 *   - Outgoing messages are free, and incoming ones are billed 20:1. A tab
 *     open all day costs a few hundred billed requests against 100,000/day —
 *     roughly a twentieth of what polling every 15 seconds costs.
 */
export class Mailbox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered by the runtime itself, so a keepalive never wakes this object.
    // Set in the constructor because hibernation re-runs it, and this has to
    // survive that.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /**
   * One tab, one socket.
   *
   * Authentication happened before this was called — the Worker will not route
   * an unauthenticated upgrade here.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Ring every open tab.
   *
   * Called over RPC by the inbound email handler and the cron tick. Sockets
   * that have gone away without a close frame are dropped here rather than
   * left to fail on the next send.
   */
  ring(reason: "mail" | "changed"): number {
    const sockets = this.ctx.getWebSockets();
    const payload = JSON.stringify({ type: reason, at: Date.now() });

    let delivered = 0;
    for (const socket of sockets) {
      try {
        socket.send(payload);
        delivered++;
      } catch {
        // Already gone; the close handler will not run for it.
        try {
          socket.close(1011, "send failed");
        } catch {
          /* nothing left to close */
        }
      }
    }
    return delivered;
  }

  /**
   * Nothing a client says is acted on.
   *
   * Keepalives are handled by the auto-response pair above and never reach
   * here. Anything else is a client talking to a channel that is one-way by
   * design, so it is ignored rather than parsed — there is no command surface
   * to get wrong.
   */
  override webSocketMessage(): void {}

  override webSocketError(ws: WebSocket): void {
    try {
      ws.close(1011, "socket error");
    } catch {
      /* already closed */
    }
  }
}

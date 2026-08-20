import { useEffect, useRef, useState } from "react";

/**
 * The socket that replaces most of the polling.
 *
 * It carries no mail — the server sends "something changed" and this calls
 * back, at which point the caller refetches the same endpoint it would have
 * polled. That is what keeps the socket optional: if it never connects, or
 * drops and stays down, the app is exactly the polling app it was before,
 * just with a slower heartbeat while the socket is up.
 *
 * Reconnection backs off to a minute, because the thing being reconnected to
 * is a doorbell — a minute late to reconnect costs one poll cycle, and a tight
 * retry loop against an outage costs the free plan's request budget.
 */
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 60_000;
const PING_MS = 30_000;

export type LiveStatus = "connecting" | "open" | "offline";

export function useLiveMail(onRing: (reason: string) => void): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const ringRef = useRef(onRing);
  ringRef.current = onRing;

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry = RETRY_MIN_MS;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let closed = false;

    function connect() {
      if (closed) return;
      setStatus((current) => (current === "open" ? "connecting" : current));

      const url = new URL("/api/live", location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

      let next: WebSocket;
      try {
        next = new WebSocket(url);
      } catch {
        schedule();
        return;
      }
      socket = next;

      next.onopen = () => {
        retry = RETRY_MIN_MS;
        setStatus("open");
        // Answered by the runtime without waking the object on the other end,
        // so this costs nothing but keeps intermediaries from culling an idle
        // connection.
        pingTimer = setInterval(() => {
          if (next.readyState === WebSocket.OPEN) next.send("ping");
        }, PING_MS);
      };

      next.onmessage = (event) => {
        if (event.data === "pong") return;
        try {
          const message = JSON.parse(String(event.data)) as { type?: string };
          if (message.type) ringRef.current(message.type);
        } catch {
          // A doorbell that rings in an unrecognised shape is still a doorbell.
          ringRef.current("changed");
        }
      };

      next.onerror = () => next.close();

      next.onclose = () => {
        clearInterval(pingTimer);
        if (closed) return;
        setStatus("offline");
        schedule();
      };
    }

    function schedule() {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, retry);
      retry = Math.min(retry * 2, RETRY_MAX_MS);
    }

    /**
     * A tab that was asleep may have missed a close frame entirely, so coming
     * back to the foreground is the moment to find out whether this socket is
     * still real rather than waiting out the backoff.
     */
    function onVisible() {
      if (document.hidden || closed) return;
      if (!socket || socket.readyState > WebSocket.OPEN) {
        retry = RETRY_MIN_MS;
        clearTimeout(retryTimer);
        connect();
      }
    }

    connect();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      closed = true;
      document.removeEventListener("visibilitychange", onVisible);
      clearTimeout(retryTimer);
      clearInterval(pingTimer);
      socket?.close();
    };
  }, []);

  return status;
}

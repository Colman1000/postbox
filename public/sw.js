/**
 * Postbox's service worker.
 *
 * It exists mostly for one reason: a push message has nowhere to be delivered
 * unless a service worker is registered to receive it. The other reason is
 * that Android will not offer to install an app whose worker does not handle
 * `fetch` — so there is a fetch handler, and it does the least it can get away
 * with. There is deliberately no caching — an offline mail client that
 * shows you a stale inbox is worse than one that says it is offline, and a
 * cache is the single most common way a deployed web app gets stuck serving a
 * version of itself from last month.
 *
 * Scope matters: this has to be served from the root to control the whole
 * origin, which is why it is a static file in `public/` and not a route.
 *
 * Compatibility is a real constraint here. A phone installs this once and may
 * not fetch it again for weeks, so a push sent by a newer Worker has to be
 * survivable by an older copy of this file. Everything below reads
 * defensively and falls back rather than throwing — a handler that throws on
 * iOS shows nothing, and iOS holds that against the subscription.
 */

/** Claim open pages as soon as a new copy installs, rather than next launch. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/**
 * The page that says the phone is offline, built here rather than cached.
 *
 * Nothing of the app is precached — see above — so the fallback cannot be a
 * real asset without reintroducing exactly the staleness this worker avoids.
 * A string is always current and costs no storage.
 */
const OFFLINE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Offline</title>
<style>
  html { color-scheme: light dark }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 15px/1.5 system-ui, sans-serif; text-align: center; padding: 2rem }
  p { opacity: .7; max-width: 22rem }
</style></head>
<body><div>
  <h1>Postbox is offline</h1>
  <p>Mail lives on the server, so there is nothing to show until this device is
     back on the network. Reload once it is.</p>
</div></body></html>`;

/**
 * Navigations, and only navigations.
 *
 * This handler is load-bearing twice over. It gives a phone with no signal a
 * page instead of the browser's error, and — the reason it cannot simply be
 * left out — Chrome refuses to treat a site as installable unless its service
 * worker handles `fetch`. Without this listener there is no "Install app" in
 * the menu on Android, however complete the manifest is.
 *
 * Everything that is not a navigation is left alone: no `respondWith`, so the
 * request goes to the network exactly as it would with no worker registered,
 * and the API keeps its own caching rules.
 */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || request.mode !== "navigate") return;

  event.respondWith(
    (async () => {
      try {
        return await fetch(request);
      } catch {
        return new Response(OFFLINE_PAGE, {
          status: 503,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
    })(),
  );
});

const FALLBACK_TITLE = "New mail";
const ICON = "/icons/app.png";
const BADGE = "/icons/badge.png";

/**
 * What the Worker sent, or something safe.
 *
 * A push with no payload at all is legal and does happen — some services send
 * one to check an endpoint is alive — and iOS penalises a subscription that
 * receives a push and shows nothing, so even an empty one gets a notification.
 */
function readPayload(event) {
  const empty = { title: FALLBACK_TITLE, body: "", tag: "postbox", threadId: null, unread: 0 };
  if (!event.data) return empty;

  try {
    const data = event.data.json();
    if (!data || typeof data !== "object") return empty;
    return {
      title: typeof data.title === "string" && data.title ? data.title : FALLBACK_TITLE,
      body: typeof data.body === "string" ? data.body : "",
      tag: typeof data.tag === "string" && data.tag ? data.tag : "postbox",
      threadId: typeof data.threadId === "string" ? data.threadId : null,
      unread: Number.isFinite(data.unread) ? data.unread : 0,
    };
  } catch {
    // Not JSON. Whatever it is, it is still an arrival.
    try {
      return { ...empty, title: event.data.text() || FALLBACK_TITLE };
    } catch {
      return empty;
    }
  }
}

self.addEventListener("push", (event) => {
  const payload = readPayload(event);

  event.waitUntil(
    (async () => {
      // The count on the home-screen icon, where supported. Failing here must
      // not cost us the notification, which is the part that matters.
      try {
        if (payload.unread > 0) await navigator.setAppBadge?.(payload.unread);
        else await navigator.clearAppBadge?.();
      } catch {
        /* not supported, or not permitted in this context */
      }

      await self.registration.showNotification(payload.title, {
        body: payload.body,
        // The conversation id, so three replies to one thread replace each
        // other instead of stacking three deep.
        tag: payload.tag,
        // Announce a replacement as well: the second reply to a conversation
        // is news even though it reuses the first one's slot.
        renotify: true,
        icon: ICON,
        badge: BADGE,
        data: { threadId: payload.threadId },
      });
    })(),
  );
});

/**
 * Open the conversation the notification was about.
 *
 * A window that is already open is focused and navigated rather than joined by
 * a second one — the common case is a phone that has the app in the background
 * with the inbox on screen.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const threadId = event.notification.data && event.notification.data.threadId;
  const target = threadId ? `/?thread=${encodeURIComponent(threadId)}` : "/";

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      for (const client of clients) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        try {
          await client.focus();
          // Not every browser implements navigate on a focused client; a
          // postMessage the app can act on covers the ones that do not.
          if (threadId) {
            client.postMessage({ type: "open-thread", threadId });
          }
          return;
        } catch {
          /* fall through to opening a window */
        }
      }

      await self.clients.openWindow(target);
    })(),
  );
});

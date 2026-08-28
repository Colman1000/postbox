/**
 * Subscribing this device to push.
 *
 * Five things stand between the switch in Settings and a notification on a
 * lock screen: a service worker, a permission, a subscription, a row in the
 * database and a push service. All five fail the same silent way — nothing
 * happens — so everything here reports what actually went wrong rather than
 * returning a boolean.
 *
 * The iOS shape of this is worth stating plainly, because it is the one people
 * lose an afternoon to: Safari exposes `PushManager` only to a web app that
 * has been added to the Home Screen. In an ordinary tab it is simply absent,
 * which is why `pushSupport()` distinguishes "this browser cannot" from "this
 * browser could, once you install it".
 */
import { api } from "./api.ts";

/** Registered at the root so it controls the whole origin. See public/sw.js. */
const WORKER_URL = "/sw.js";

export type PushSupport =
  /** Everything needed is here. */
  | "ready"
  /** iOS: works, but only once the app is on the Home Screen. */
  | "needs-install"
  /** No service workers or no Push API, and no install will change that. */
  | "unsupported";

/** True when running as an installed app rather than in a browser tab. */
export function isInstalled(): boolean {
  return (
    matchMedia("(display-mode: standalone)").matches ||
    // Safari's own, from before the media query existed, and still the only
    // one iOS sets reliably.
    (navigator as { standalone?: boolean }).standalone === true
  );
}

/**
 * iPads have reported themselves as macOS since iPadOS 13, so the platform
 * string alone is not enough — a Mac with a touchscreen is the thing that does
 * not exist, and that is what makes the touch-point count decisive.
 */
export function isApple(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

export function pushSupport(): PushSupport {
  if (!("serviceWorker" in navigator)) return "unsupported";
  if (!("PushManager" in window)) {
    // On iOS the Push API appears only inside an installed web app, so its
    // absence there is an instruction rather than a verdict.
    return isApple() && !isInstalled() ? "needs-install" : "unsupported";
  }
  if (!("Notification" in window)) return "unsupported";
  return "ready";
}

/** The application server key, in the form `subscribe` insists on. */
function decodeKey(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeKey(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Register the worker, and wait until it is actually in charge.
 *
 * `ready` rather than the registration `register()` returns: subscribing
 * against a worker that is still installing throws, and on a first visit those
 * two moments are milliseconds apart and reliably in the wrong order.
 */
export async function ensureWorker(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register(WORKER_URL, { scope: "/" });
  return navigator.serviceWorker.ready;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== "ready") return null;
  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    return (await registration?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

/**
 * True when this device holds a subscription made against a different key.
 *
 * The keypair is deliberately sticky, but it can still be re-provisioned — a
 * deploy after `--erase-secrets` mints a new one. When that happens every
 * device already registered goes quiet, and nothing on the phone can tell:
 * the subscription still exists, the permission is still granted, and the
 * notifications simply stop. Comparing the key is how that becomes noticeable
 * rather than mysterious.
 */
export async function keyHasChanged(vapidKey: string): Promise<boolean> {
  const subscription = await currentSubscription();
  if (!subscription) return false;
  const registered = subscription.options.applicationServerKey;
  return !registered || encodeKey(registered) !== vapidKey;
}

export class PushError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "PushError";
  }
}

/**
 * Turn push on for this device.
 *
 * Must be called from a user gesture: browsers refuse a permission prompt
 * requested any other way, and refuse it silently.
 */
export async function subscribe(vapidKey: string): Promise<void> {
  const support = pushSupport();
  if (support === "needs-install") {
    throw new PushError("Add Postbox to your Home Screen first.", "Share → Add to Home Screen.");
  }
  if (support === "unsupported") {
    throw new PushError("This browser cannot receive push notifications.");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new PushError(
      "Your browser is blocking notifications for this site.",
      "Allow them in the site settings, then switch this back on.",
    );
  }

  const registration = await ensureWorker();
  const applicationServerKey = decodeKey(vapidKey);

  // A subscription made against a different application server key cannot be
  // reused, and `subscribe` throws rather than replacing it. This is not
  // hypothetical: it is what happens to every device already registered if the
  // deployment's keypair is ever regenerated.
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    const registeredKey = existing.options.applicationServerKey;
    if (!registeredKey || encodeKey(registeredKey) !== vapidKey) {
      await existing.unsubscribe().catch(() => {
        /* about to be replaced regardless */
      });
    }
  }

  let subscription: PushSubscription;
  try {
    subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        // Required, and honestly meant: every push this app sends shows a
        // notification. A silent push is what gets a subscription revoked.
        userVisibleOnly: true,
        applicationServerKey,
      }));
  } catch (error) {
    throw new PushError(
      "The browser would not create a subscription.",
      error instanceof Error ? error.message : undefined,
    );
  }

  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new PushError("The subscription came back incomplete.");
  }

  await api.subscribePush({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  });
}

/**
 * Turn it off again, on both sides.
 *
 * The server is told first. If the browser then refuses to unsubscribe we have
 * still stopped sending to it, which is the half that matters; the reverse
 * order can leave a live row addressing an endpoint nothing will ever answer.
 */
export async function unsubscribe(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;

  await api.unsubscribePush(subscription.endpoint).catch(() => {
    /* the local unsubscribe below is still worth doing */
  });
  await subscription.unsubscribe().catch(() => {
    /* already gone */
  });

  try {
    await navigator.clearAppBadge?.();
  } catch {
    /* not supported here */
  }
}

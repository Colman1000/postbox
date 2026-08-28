/**
 * Installing Postbox to the home screen.
 *
 * Chrome fires `beforeinstallprompt` once, early, and only if the site meets
 * every installability criterion — which is why this listener is registered at
 * import time from `main.tsx` rather than inside a component. By the time
 * Settings is opened the event has long since fired and, unhandled, been used
 * to draw the browser's own banner instead of ours.
 *
 * Safari fires nothing and has no API for this: on iOS the only route is
 * Share → Add to Home Screen, which is what Settings says there. See
 * `isApple()` in push.ts.
 */

import { isApple } from "./push.ts";

/** Chrome's, and not in lib.dom. */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function announce() {
  for (const listener of listeners) listener();
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    // Held rather than shown: the same prompt, but at a moment the person
    // asked for it instead of one the browser chose.
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    announce();
  });

  // Either through our button or the browser's menu — the offer is spent
  // either way, and the prompt cannot be replayed.
  window.addEventListener("appinstalled", () => {
    deferred = null;
    announce();
  });
}

export function canInstall(): boolean {
  return deferred !== null;
}

export function subscribeInstall(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Show the browser's install dialog. True if it was accepted. */
export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;

  // Cleared first: a prompt is single-use, and a second call on the same event
  // throws rather than reopening the dialog.
  deferred = null;
  announce();

  await event.prompt();
  const { outcome } = await event.userChoice;
  return outcome === "accepted";
}

/**
 * What to say when the browser will not be asked.
 *
 * `beforeinstallprompt` is Chromium's alone, and even there it is spent after
 * one offer: a Chrome that has already shown the prompt — or already declined
 * to — fires nothing on the next visit, and the button above it vanishes with
 * it. The route is still open in every one of those cases; it is just a walk
 * the person has to take themselves. So the row stays and says how.
 */
export function installHint(): string {
  const ua = navigator.userAgent;
  const chromium = /Chrome|Chromium|Edg\//.test(ua);

  if (isApple()) {
    return "Tap Share, then Add to Home Screen, and open Postbox from there.";
  }
  if (/Firefox\//.test(ua)) {
    return "Firefox does not install web apps. Open this address in Chrome or Safari to add Postbox to your home screen.";
  }
  if (!chromium) {
    return "In Safari, choose File, then Add to Dock.";
  }
  if (/Android/.test(ua)) {
    return "Open Chrome's ⋮ menu and choose Add to Home screen. If it is not offered, Postbox is already installed.";
  }
  return "Use the install icon at the right of the address bar, or look for Install in the browser's menu.";
}

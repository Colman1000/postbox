import type { Arrival } from "@shared/types.ts";
import { displayName } from "./format.ts";

/**
 * Alerts for mail that arrives while you are elsewhere.
 *
 * Preferences live in localStorage rather than the database on purpose: both
 * of them are properties of *this browser*, not of the mailbox. Notification
 * permission is granted per-origin per-device, and a sound that suits a laptop
 * is the wrong choice on a shared machine — syncing either one across devices
 * would only ever be wrong somewhere.
 */

export interface NotifyPrefs {
  desktop: boolean;
  sound: boolean;
}

const KEY = "postbox:notify";
const DEFAULTS: NotifyPrefs = { desktop: false, sound: true };

export function readPrefs(): NotifyPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<NotifyPrefs>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function writePrefs(prefs: NotifyPrefs): NotifyPrefs {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* private mode: the preference simply does not persist */
  }
  return prefs;
}

export const notificationsSupported = (): boolean =>
  typeof window !== "undefined" && "Notification" in window;

export const permission = (): NotificationPermission =>
  notificationsSupported() ? Notification.permission : "denied";

/**
 * Asks the browser for permission, and reports what actually happened.
 *
 * Chrome only shows the prompt from a user gesture, which is why nothing here
 * is called on load — it is wired to the switch in Settings instead.
 */
export async function requestPermission(): Promise<NotificationPermission> {
  if (!notificationsSupported()) return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

/**
 * A short two-note chime, synthesised rather than shipped.
 *
 * An audio file would be another asset to serve, another thing to cache and a
 * licence to keep track of; sixteen lines of oscillator is none of those.
 */
let audio: AudioContext | null = null;

export function playChime(): void {
  try {
    const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audio ??= new Ctor();
    if (audio.state === "suspended") void audio.resume();

    const start = audio.currentTime;
    // E5 then B5 — a rising interval reads as "something arrived" rather than
    // "something went wrong".
    for (const [index, frequency] of [659.25, 987.77].entries()) {
      const at = start + index * 0.11;
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      // A quick fade in and out; a bare square edge clicks.
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.28);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.3);
    }
  } catch {
    /* autoplay policy, or no audio device: silence is an acceptable failure */
  }
}

/**
 * One desktop notification per arrival, or a single summary for a burst.
 *
 * `tag` is the thread id, so a conversation that gets three replies while you
 * are away replaces its own notification instead of stacking three.
 */
export function showNotification(
  arrivals: Arrival[],
  onOpen: (threadId: string) => void,
): void {
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  if (arrivals.length === 0) return;

  const open = (threadId: string) => {
    window.focus();
    onOpen(threadId);
  };

  try {
    if (arrivals.length === 1) {
      const [arrival] = arrivals;
      const notification = new Notification(displayName(arrival.from), {
        body: arrival.subject || arrival.snippet || "(no subject)",
        tag: arrival.threadId,
        icon: "/favicon.svg",
        silent: true, // The chime is ours to play, so the OS should not double it.
      });
      notification.onclick = () => {
        open(arrival.threadId);
        notification.close();
      };
      return;
    }

    const notification = new Notification(`${arrivals.length} new messages`, {
      body: arrivals
        .slice(0, 3)
        .map((a) => `${displayName(a.from)} — ${a.subject || "(no subject)"}`)
        .join("\n"),
      tag: "postbox-batch",
      icon: "/favicon.svg",
      silent: true,
    });
    notification.onclick = () => {
      open(arrivals[0].threadId);
      notification.close();
    };
  } catch {
    /* some browsers throw on the constructor from a non-secure context */
  }
}

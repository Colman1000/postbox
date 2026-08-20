import type { Address } from "@shared/types.ts";

/** Display helpers. Kept together so date and name formatting stay consistent. */

export function displayName(address: Address | undefined): string {
  if (!address) return "Unknown";
  if (address.name?.trim()) return address.name.trim();
  const local = address.address.split("@")[0] ?? address.address;
  return local
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim();
}

export function initials(address: Address | undefined): string {
  const name = displayName(address);
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2);
  return (parts[0][0] + parts[parts.length - 1][0]).slice(0, 2);
}

/**
 * List-view timestamps: time for today, weekday within the last week, then
 * a date. Same convention every mail client uses, because it makes the column
 * scannable at a glance rather than uniform-width and unreadable.
 */
export function shortDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();

  if (sameDay) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  const daysAgo = (now.getTime() - date.getTime()) / 86_400_000;
  if (daysAgo < 7) return date.toLocaleDateString(undefined, { weekday: "short" });
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "2-digit",
  });
}

export function fullDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function relativeTime(timestamp: number): string {
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 7],
    ["week", 4.35],
    ["month", 12],
    ["year", Number.POSITIVE_INFINITY],
  ];

  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  let value = seconds;
  for (const [unit, step] of units) {
    if (Math.abs(value) < step) return formatter.format(Math.round(value), unit);
    value /= step;
  }
  return formatter.format(Math.round(value), "year");
}

/**
 * "Chrome on macOS" from a user-agent string.
 *
 * Deliberately coarse. The access log is scanned for the row that looks wrong,
 * and "Safari on iPhone" answers that; a version number would only make every
 * row longer and harder to scan past.
 */
export function deviceSummary(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown device";
  const ua = userAgent;

  const browser =
    /\bEdg\//.test(ua) ? "Edge"
    : /\bOPR\/|\bOpera\b/.test(ua) ? "Opera"
    : /\bFirefox\//.test(ua) ? "Firefox"
    : /\bChrome\/|\bCriOS\//.test(ua) ? "Chrome"
    : /\bSafari\//.test(ua) ? "Safari"
    : "Browser";

  const platform =
    /\biPhone\b/.test(ua) ? "iPhone"
    : /\biPad\b/.test(ua) ? "iPad"
    : /\bAndroid\b/.test(ua) ? "Android"
    : /\bMac OS X\b|\bMacintosh\b/.test(ua) ? "macOS"
    : /\bWindows\b/.test(ua) ? "Windows"
    : /\bLinux\b/.test(ua) ? "Linux"
    : null;

  return platform ? `${browser} on ${platform}` : browser;
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The participant column in the list.
 *
 * One correspondent gets their full name — "Field Notes Press", not "Field".
 * Several get first names only, because that is the only way three names fit
 * in the column: "Joy, Paulo, Tomas +2".
 */
export function participantSummary(
  participants: Address[],
  self: string,
  max = 3,
): string {
  const others = participants.filter(
    (p) => p.address.toLowerCase() !== self.toLowerCase(),
  );
  const list = others.length > 0 ? others : participants;
  if (list.length === 0) return "";
  if (list.length === 1) return displayName(list[0]);

  const names = list.slice(0, max).map((p) => displayName(p).split(" ")[0]);
  const extra = list.length - names.length;
  return names.join(", ") + (extra > 0 ? ` +${extra}` : "");
}

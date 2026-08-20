import type { Address } from "../../shared/types.ts";

/**
 * Address handling.
 *
 * Deliberately permissive on parse (real mail is messy) and strict on send
 * (a malformed From is a bounce).
 */

const EMAIL_RE = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;

export function isValidAddress(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

/** `"Ada Lovelace" <ada@example.com>` and friends → structured. */
export function parseAddress(raw: string): Address | null {
  const value = raw.trim().replace(/,$/, "");
  if (!value) return null;

  const angled = value.match(/^(.*?)<([^>]+)>\s*$/);
  if (angled) {
    const name = angled[1].trim().replace(/^["']|["']$/g, "").trim();
    const address = angled[2].trim();
    if (!isValidAddress(address)) return null;
    return name ? { address: address.toLowerCase(), name } : { address: address.toLowerCase() };
  }

  if (!isValidAddress(value)) return null;
  return { address: value.toLowerCase() };
}

/** Splits on commas that are not inside quotes or angle brackets. */
export function parseAddressList(raw: string): Address[] {
  const out: Address[] = [];
  let current = "";
  let inQuotes = false;
  let inAngle = false;

  for (const char of raw) {
    if (char === '"') inQuotes = !inQuotes;
    else if (char === "<") inAngle = true;
    else if (char === ">") inAngle = false;

    if (char === "," && !inQuotes && !inAngle) {
      const parsed = parseAddress(current);
      if (parsed) out.push(parsed);
      current = "";
      continue;
    }
    current += char;
  }
  const last = parseAddress(current);
  if (last) out.push(last);

  return dedupe(out);
}

export function dedupe(addresses: Address[]): Address[] {
  const seen = new Map<string, Address>();
  for (const a of addresses) {
    const key = a.address.toLowerCase();
    // Keep the first entry that carries a display name.
    if (!seen.has(key) || (!seen.get(key)!.name && a.name)) seen.set(key, a);
  }
  return [...seen.values()];
}

export function formatAddress(address: Address): string {
  if (!address.name) return address.address;
  // Quote display names containing characters that would break the header.
  const needsQuotes = /[,;:<>@"\\]/.test(address.name);
  const name = needsQuotes
    ? `"${address.name.replace(/(["\\])/g, "\\$1")}"`
    : address.name;
  return `${name} <${address.address}>`;
}

export function formatAddressList(addresses: Address[]): string[] {
  return addresses.map(formatAddress);
}

/** Best-effort human label — display name, else the local part. */
export function displayName(address: Address): string {
  if (address.name) return address.name;
  const local = address.address.split("@")[0];
  return local.replace(/[._-]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

export function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function domainOf(address: string): string {
  return address.split("@")[1]?.toLowerCase() ?? "";
}

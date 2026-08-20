/**
 * Sortable identifiers.
 *
 * A ULID-shaped id (48-bit timestamp + 80 bits of randomness, Crockford
 * base32) means `ORDER BY id` matches chronological order, so pagination
 * cursors are just ids and need no extra column.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(now: number, length: number): string {
  let out = "";
  let value = now;
  for (let i = length - 1; i >= 0; i--) {
    out = CROCKFORD[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += CROCKFORD[byte % 32];
  return out;
}

export function ulid(now = Date.now()): string {
  return encodeTime(now, 10) + encodeRandom(16);
}

/** Short opaque id for things that are never sorted (labels, templates). */
export function shortId(): string {
  return encodeRandom(12);
}

/**
 * RFC 5322 Message-ID. Must be globally unique and rooted at a domain we own,
 * or receiving servers treat the thread as unrelated.
 */
export function rfcMessageId(domain: string): string {
  return `<${ulid().toLowerCase()}.${encodeRandom(8).toLowerCase()}@${domain}>`;
}

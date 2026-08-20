/**
 * Session auth.
 *
 * A public URL that can send mail from your domain is a spam relay, so the
 * whole app sits behind one password. Sessions are stateless HMAC tokens —
 * no session table, nothing to clean up, and revocation is a matter of
 * rotating AUTH_SECRET.
 *
 * If you would rather use SSO, put Cloudflare Access in front of the hostname;
 * this layer stays harmless underneath it.
 */
const COOKIE_NAME = "postbox_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Constant-time comparison, so a wrong password leaks no timing signal. */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

export async function createSession(secret: string): Promise<string> {
  const payload = base64url(
    encoder.encode(
      JSON.stringify({
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
      }),
    ),
  );
  const signature = await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(payload));
  return `${payload}.${base64url(signature)}`;
}

export async function verifySession(secret: string, token: string): Promise<boolean> {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;

  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      await key(secret),
      fromBase64url(signature),
      encoder.encode(payload),
    );
  } catch {
    return false;
  }
  if (!valid) return false;

  try {
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as {
      exp?: number;
    };
    return typeof claims.exp === "number" && claims.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

export function sessionCookie(token: string, secure = true): string {
  return [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearCookie(secure = true): string {
  return [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    "Max-Age=0",
  ]
    .filter(Boolean)
    .join("; ");
}

export function readCookie(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) return rest.join("=");
  }
  return null;
}

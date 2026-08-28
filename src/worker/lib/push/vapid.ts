/**
 * VAPID — proving to a push service that this Worker is the one allowed to
 * push to your phone.
 *
 * Apple, Google and Mozilla each run the push service for their own browsers,
 * and none of them know anything about Postbox. What stops a stranger who has
 * scraped your subscription endpoint from pushing to it is a signature: the
 * subscription was created naming our public key, and every push has to carry
 * a token signed by the matching private half.
 *
 * The keypair is generated once at deploy time and lives in `.secrets/`, so it
 * survives redeploys — a new keypair would silently invalidate every
 * subscription already registered, and the only symptom would be notifications
 * that quietly stopped.
 */
import { base64url, fromBase64url } from "../base64.ts";

const encoder = new TextEncoder();

/**
 * Twelve hours. The spec caps a token's life at twenty-four, and a push
 * service will refuse anything longer; half of that leaves room for a clock
 * that disagrees with ours without ever getting close to the limit.
 */
const TOKEN_TTL_SECONDS = 12 * 60 * 60;

export interface VapidKeys {
  /** Uncompressed P-256 point, base64url. Also handed to the browser. */
  publicKey: string;
  /** The private scalar, base64url. */
  privateKey: string;
}

/**
 * Rebuild a signing key from the two halves the vault stores.
 *
 * WebCrypto will not import a bare private scalar, so the JWK is assembled
 * here: `x` and `y` come straight out of the uncompressed public point, which
 * is `0x04` followed by the two 32-byte coordinates.
 */
async function signingKey(keys: VapidKeys): Promise<CryptoKey> {
  const point = fromBase64url(keys.publicKey);
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error("VAPID public key is not an uncompressed P-256 point");
  }

  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: base64url(point.subarray(1, 33)),
      y: base64url(point.subarray(33, 65)),
      d: keys.privateKey,
      ext: false,
      key_ops: ["sign"],
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/**
 * The `Authorization` header for one push.
 *
 * `aud` is the origin of the endpoint and nothing more — a token minted for
 * Apple's push service must not be replayable against Google's, so the path is
 * deliberately dropped. `sub` has to be a way to reach whoever operates this,
 * which for a personal mailbox is the mailbox itself.
 */
export async function vapidHeader(
  keys: VapidKeys,
  endpoint: string,
  contact: string,
): Promise<string> {
  const audience = new URL(endpoint).origin;

  const header = base64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64url(
    encoder.encode(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
        sub: contact.startsWith("mailto:") || contact.startsWith("https:")
          ? contact
          : `mailto:${contact}`,
      }),
    ),
  );

  const signingInput = `${header}.${claims}`;
  // ECDSA through WebCrypto is already the raw r||s pair JWS wants; the DER
  // wrapper OpenSSL would produce is the thing that has to be unpicked, and
  // this never sees one.
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    await signingKey(keys),
    encoder.encode(signingInput),
  );

  return `vapid t=${signingInput}.${base64url(signature)}, k=${keys.publicKey}`;
}

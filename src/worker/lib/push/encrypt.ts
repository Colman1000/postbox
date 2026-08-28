/**
 * Message encryption for Web Push — RFC 8291 over RFC 8188's `aes128gcm`.
 *
 * This is the reason a subject line can go in the payload at all. The
 * subscription hands us a public key and a shared secret that belong to that
 * browser install; everything below derives a one-shot content key from them,
 * so what Apple or Google relay is ciphertext they hold no key for. The push
 * service learns that a message exists and roughly how big it is, and nothing
 * else — which is a better privacy story than a contentless push that makes
 * the phone come back and ask us for the subject over the network.
 *
 * Every primitive here is in the Workers runtime already. HKDF is spelled out
 * as its two HMAC steps rather than going through `deriveBits`, because the
 * first extract uses the subscription's auth secret as the salt and the second
 * uses a fresh random one — two different HKDFs, and writing them out is
 * shorter than configuring them.
 */
import { concat } from "../base64.ts";

const encoder = new TextEncoder();

/**
 * Record size, in bytes, declared in the header.
 *
 * Push services generally refuse a body much over 4 KB, and everything Postbox
 * sends is a subject and a sender, so one record is always enough. A payload
 * that would not fit is truncated by the caller rather than split.
 */
const RECORD_SIZE = 4096;

/** How much plaintext one record can hold: the record minus the GCM tag. */
export const MAX_PAYLOAD_BYTES = RECORD_SIZE - 16 - 1;

export interface SubscriptionKeys {
  /** The install's public key: an uncompressed P-256 point, base64url. */
  p256dh: Uint8Array;
  /** 16 bytes of shared secret, base64url in the subscription JSON. */
  auth: Uint8Array;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, data));
}

/**
 * One HKDF expand step, capped at a single block.
 *
 * Everything derived here is 32 bytes or fewer, so the counter never leaves
 * `0x01` and the loop a general implementation needs is dead code.
 */
async function expand(prk: Uint8Array, info: Uint8Array, length: number) {
  const block = await hmac(prk, concat(info, new Uint8Array([0x01])));
  return block.subarray(0, length);
}

/**
 * Encrypt one payload for one subscription.
 *
 * Returns the complete body: the RFC 8188 header — salt, record size and our
 * ephemeral public key — followed by the single encrypted record.
 */
export async function encryptPayload(
  payload: string,
  keys: SubscriptionKeys,
): Promise<Uint8Array> {
  const plaintext = encoder.encode(payload);
  if (plaintext.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`Push payload is ${plaintext.length} bytes; the limit is ${MAX_PAYLOAD_BYTES}`);
  }

  // A fresh keypair per message. Reusing one would let anyone who ever
  // recovered it decrypt every push we had sent with it.
  const ephemeral = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
    // `generateKey` is typed as returning either a key or a pair, and only the
    // algorithm says which. For ECDH it is always a pair.
  )) as CryptoKeyPair;

  const ephemeralPublic = new Uint8Array(
    (await crypto.subtle.exportKey("raw", ephemeral.publicKey)) as ArrayBuffer,
  );

  const recipient = await crypto.subtle.importKey(
    "raw",
    keys.p256dh,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      // The Workers type definitions escape this field as `$public`, because
      // `public` is a reserved word in the language they are generated from.
      // The runtime wants the name the spec gives it, so the object is built
      // correctly and the cast is only there to get it past the checker.
      { name: "ECDH", public: recipient } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      ephemeral.privateKey,
      256,
    ),
  );

  // Step one: fold the shared secret together with the subscription's auth
  // secret. The info string binds the result to this exact pair of keys, so a
  // shared secret alone is not enough to derive the content key.
  const authPrk = await hmac(keys.auth, shared);
  const keyInfo = concat(
    encoder.encode("WebPush: info"),
    new Uint8Array([0x00]),
    keys.p256dh,
    ephemeralPublic,
  );
  const ikm = await expand(authPrk, keyInfo, 32);

  // Step two: the ordinary content-encoding derivation, salted freshly so two
  // identical notifications never produce the same bytes.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = await expand(
    prk,
    concat(encoder.encode("Content-Encoding: aes128gcm"), new Uint8Array([0x00])),
    16,
  );
  const nonce = await expand(
    prk,
    concat(encoder.encode("Content-Encoding: nonce"), new Uint8Array([0x00])),
    12,
  );

  const contentKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, [
    "encrypt",
  ]);
  // 0x02 marks the last record. A single-record message is still required to
  // say so, and a push that omits it is discarded by the browser rather than
  // shown.
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      contentKey,
      concat(plaintext, new Uint8Array([0x02])),
    ),
  );

  const header = new Uint8Array(5);
  new DataView(header.buffer).setUint32(0, RECORD_SIZE);
  header[4] = ephemeralPublic.length;

  return concat(salt, header, ephemeralPublic, ciphertext);
}

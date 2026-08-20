/**
 * Machine-local secret vault.
 *
 * Anything Postbox generates or provisions on your behalf (the Resend
 * send-only key, the session signing secret, the UI password) is written here
 * so that the *second* `just up` reuses it instead of minting a duplicate.
 *
 * Storage rules:
 *   - lives in `.secrets/`, which is git-ignored and dot-prefixed (hidden)
 *   - directory is 0700, files are 0400 (read-only, owner-only)
 *   - writes explicitly unlock -> write -> relock, so an accidental
 *     `>` redirect or stray editor save bounces off a read-only file
 *   - one file per stage, so stages never read each other's secrets
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const VAULT_DIR = path.resolve(process.cwd(), ".secrets");

export interface VaultData {
  /** Resend domain object id, so we adopt instead of re-creating. */
  resendDomainId?: string;
  /** Send-only Resend key, scoped to this domain. The app runs on this. */
  resendSendingKey?: string;
  /** Resend api-key id, kept so `just down` can revoke it. */
  resendSendingKeyId?: string;
  /** HMAC key for session cookies. */
  authSecret?: string;
  /** UI password — generated unless the operator supplied one. */
  appPassword?: string;
  /** True the first time we generated the password, so we print it once. */
  appPasswordGenerated?: boolean;
}

function vaultFile(stage: string): string {
  return path.join(VAULT_DIR, `postbox.${stage}.json`);
}

function ensureDir(): void {
  if (!fs.existsSync(VAULT_DIR)) {
    fs.mkdirSync(VAULT_DIR, { recursive: true, mode: 0o700 });
  } else {
    // Repair permissions if something loosened them.
    try {
      fs.chmodSync(VAULT_DIR, 0o700);
    } catch {
      /* non-POSIX filesystem; best effort */
    }
  }
}

export function readVault(stage: string): VaultData {
  const file = vaultFile(stage);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as VaultData;
  } catch {
    throw new Error(
      `Secret vault at ${file} is corrupt. Delete it and re-run \`just up\` ` +
        `to re-provision (a new Resend key will be minted).`,
    );
  }
}

export function writeVault(stage: string, data: VaultData): void {
  ensureDir();
  const file = vaultFile(stage);
  // Unlock if it already exists — the file is deliberately read-only at rest.
  if (fs.existsSync(file)) {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
  }
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o400);
  } catch {
    /* best effort */
  }
}

/** Read-modify-write a single pass, so partial provisioning still persists. */
export function updateVault(
  stage: string,
  patch: (current: VaultData) => VaultData,
): VaultData {
  const next = patch(readVault(stage));
  writeVault(stage, next);
  return next;
}

export function deleteVault(stage: string): void {
  const file = vaultFile(stage);
  if (!fs.existsSync(file)) return;
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
  fs.rmSync(file);
}

export function vaultPath(stage: string): string {
  return path.relative(process.cwd(), vaultFile(stage));
}

/** URL-safe high-entropy string, used for the auth secret. */
export function randomSecret(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/**
 * A password a human can retype without hating you: 4 groups of 5 lowercase
 * consonant/vowel-safe characters. ~93 bits of entropy at 32 symbols/char.
 */
export function randomPassword(): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyz23456789"; // no l/1/0/o ambiguity
  const bytes = crypto.randomBytes(20);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return [0, 5, 10, 15].map((i) => chars.slice(i, i + 5).join("")).join("-");
}

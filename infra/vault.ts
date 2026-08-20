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
  /** Passphrase Alchemy uses to encrypt secrets inside `.alchemy/`. */
  statePassword?: string;
  /**
   * What already existed in the account before the first deploy. Written once
   * and never rewritten — see provenance.ts. `just down` reads it to decide
   * what it is allowed to remove.
   */
  preexisting?: import("./provenance.ts").Provenance;
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

/**
 * True if Alchemy has already written encrypted secrets for this stage.
 *
 * Encrypted values are stored as `{"@secret": "..."}`, so a substring check
 * over the stage's state files is enough to tell "there is nothing to unlock
 * yet" apart from "there is, and we have lost the key".
 */
function stateHasEncryptedSecrets(app: string, stage: string): boolean {
  const dir = path.resolve(process.cwd(), ".alchemy", app, stage);
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((entry) => {
    if (!entry.endsWith(".json")) return false;
    try {
      return fs.readFileSync(path.join(dir, entry), "utf8").includes('"@secret"');
    } catch {
      return false;
    }
  });
}

/**
 * The passphrase Alchemy encrypts its own state with.
 *
 * Alchemy refuses to write a secret it cannot encrypt, so a deploy without one
 * fails at the first Worker binding. There is nothing for a human to decide
 * here, so we generate one on first run and keep it in the vault next to
 * everything else we provision. It has to stay put: state written under one
 * passphrase cannot be read under another.
 *
 * ALCHEMY_PASSWORD wins if it is set, so CI can keep the key in its own
 * secret store rather than in a file on a build machine.
 */
export function ensureStatePassword(app: string, stage: string): string {
  const supplied = process.env.ALCHEMY_PASSWORD?.trim();
  if (supplied) return supplied;

  const cached = readVault(stage).statePassword;
  if (cached) return cached;

  // Minting a fresh passphrase here would leave the existing state
  // undecryptable and the deploy would fail several resources in, on a crypto
  // error that says nothing about the cause. Say it plainly instead.
  if (stateHasEncryptedSecrets(app, stage)) {
    throw new Error(
      [
        "",
        `The deploy state in .alchemy/${app}/${stage} is encrypted, but the key that`,
        `opens it is missing — ${vaultPath(stage)} was deleted or moved.`,
        "",
        "  Restore that file from a backup, or set ALCHEMY_PASSWORD if you kept",
        "  the key elsewhere.",
        "",
        "  If it is gone for good, discard the encrypted values and re-provision",
        "  them (this mints a new Resend key and signs out open sessions):",
        "",
        `    npx alchemy deploy ./alchemy.run.ts --force --erase-secrets`,
        "",
      ].join("\n"),
    );
  }

  return updateVault(stage, (current) => ({
    ...current,
    statePassword: randomSecret(),
  })).statePassword!;
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

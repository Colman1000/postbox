/**
 * The gate every `just` recipe passes through before it can spend a credential.
 *
 * Its whole job is to make sure the Cloudflare token Postbox is about to use is
 * one somebody chose *for this project*. A token that merely happens to be
 * exported in the current shell does not qualify: it is usually right, and when
 * it is wrong nothing complains — the deploy simply lands in another account.
 * So when .env has no credential of its own, this asks for one and writes the
 * answer down, which turns a lucky default into a decision on disk.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { cloudflareCredentials, loadDotEnv } from "./config.ts";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const ENV_FILE = path.resolve(process.cwd(), ".env");

if (!fs.existsSync(ENV_FILE)) {
  console.error("\n  No .env found.\n\n    cp .env.example .env\n");
  process.exit(1);
}

loadDotEnv();
const credentials = cloudflareCredentials();

/** Who a token actually belongs to — the only detail worth confirming. */
async function identify(
  token: string,
): Promise<{ ok: boolean; accounts: string[]; reason?: string }> {
  const verify = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!verify) return { ok: false, accounts: [], reason: "could not reach the Cloudflare API" };
  const body = (await verify.json().catch(() => ({}))) as {
    success?: boolean;
    result?: { status?: string };
  };
  if (!verify.ok || !body.success) {
    return { ok: false, accounts: [], reason: "Cloudflare rejected it" };
  }
  if (body.result?.status !== "active") {
    const status = body.result?.status;
    return { ok: false, accounts: [], reason: `Cloudflare says its status is "${status}"` };
  }

  const res = await fetch("https://api.cloudflare.com/client/v4/accounts?per_page=50", {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => null);
  const accounts = res?.ok
    ? (((await res.json()) as { result?: Array<{ name: string; id: string }> }).result ?? []).map(
        (a) => `${a.name} ${dim(a.id)}`,
      )
    : [];
  return { ok: true, accounts };
}

/**
 * One question, one answer. `hidden` keeps a pasted token off the screen, where
 * it would otherwise outlive the prompt in the scrollback. A closed stdin —
 * someone hitting ctrl-D, or a pipe that was never going to answer — comes back
 * as null, which is not the same as an empty answer: Enter means "the default",
 * ctrl-D means "stop asking me things".
 */
function ask(question: string, hidden = false): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    let muted = false;
    let answered = false;
    const finish = (value: string | null) => {
      if (answered) return;
      answered = true;
      resolve(value === null ? null : value.trim());
    };
    if (hidden) {
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (!muted) process.stdout.write(s);
      };
    }
    rl.on("close", () => finish(null));
    rl.question(question, (value) => {
      finish(value);
      if (hidden) process.stdout.write("\n");
      rl.close();
    });
    // The prompt is written synchronously by `question`; everything typed after
    // this line is the answer, and the answer is nobody else's business.
    muted = true;
  });
}

/** Enter is yes, because the question is only asked after a token verified. */
async function confirm(question: string): Promise<boolean> {
  const answer = await ask(question);
  return answer !== null && !/^n/i.test(answer);
}

/** Puts the token in .env, replacing the placeholder rather than piling up. */
function writeToken(token: string): void {
  const lines = fs.readFileSync(ENV_FILE, "utf8").split("\n");
  const at = lines.findIndex((l) => /^\s*#?\s*CLOUDFLARE_API_TOKEN\s*=/.test(l));
  if (at === -1) {
    lines.push("", "# Chosen at the `just up` prompt.", `CLOUDFLARE_API_TOKEN=${token}`);
  } else {
    lines[at] = `CLOUDFLARE_API_TOKEN=${token}`;
  }
  fs.writeFileSync(ENV_FILE, lines.join("\n"));
  process.env.CLOUDFLARE_API_TOKEN = token;
}

// ── CI has said, once and deliberately, to trust its environment ────────────
// There is no terminal there to ask, and a pipeline that exports a token has
// made the same choice the prompt below asks for — just somewhere else.
if (credentials.source === "environment" && process.env.POSTBOX_ALLOW_ENV_TOKEN) {
  console.log(
    dim(
      `  Using ${credentials.key} …${credentials.fingerprint} from the environment ` +
        "(POSTBOX_ALLOW_ENV_TOKEN).",
    ),
  );
  process.exit(0);
}

// ── The credential is already explicit ──────────────────────────────────────
if (credentials.source === "env-file" || credentials.source === "profile") {
  if (credentials.ignored.length > 0) {
    // Said once, quietly. Someone whose shell disagrees with their .env should
    // know which one won, without being nagged about it on every command.
    console.log(
      dim(
        `  Using the Cloudflare credential from .env; ignoring ${credentials.ignored.join(", ")} ` +
          "from your environment.",
      ),
    );
  }
  process.exit(0);
}

// ── CI, or any other terminal that cannot answer a question ─────────────────
if (!process.stdin.isTTY) {
  const found =
    credentials.source === "environment"
      ? `  ${credentials.key} is set in this environment, but nothing pointed Postbox at it.\n`
      : "  No Cloudflare credential was found anywhere.\n";
  console.error(
    [
      "",
      "  Postbox does not know which Cloudflare account to deploy into.",
      "",
      found,
      "  Put the token in .env:",
      "",
      "    echo \"CLOUDFLARE_API_TOKEN=$YOUR_TOKEN\" >> .env",
      "",
      "  or, if the environment is deliberate, set POSTBOX_ALLOW_ENV_TOKEN=1 to say so.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

// ── Ask ─────────────────────────────────────────────────────────────────────
console.log("");
console.log(`  ${bold("Which Cloudflare token should Postbox use?")}`);
console.log("");
console.log("  .env does not name one, and a token that is merely present in your shell");
console.log("  is a guess — the wrong guess deploys this mailbox into another account");
console.log("  and says nothing. So: chosen once here, written to .env, never asked again.");
console.log("");

let offered: string | undefined;
if (credentials.source === "environment" && credentials.key === "CLOUDFLARE_API_TOKEN") {
  const token = process.env.CLOUDFLARE_API_TOKEN!;
  const who = await identify(token);
  if (who.ok) {
    offered = token;
    console.log(`  In your environment: ${bold(`…${credentials.fingerprint}`)}`);
    for (const account of who.accounts) console.log(`    ${account}`);
    console.log("");
    console.log(dim("  Press Enter to use it, or paste a different token."));
  } else {
    console.log(
      dim(`  The token in your environment is unusable (${who.reason}) — ignoring it.`),
    );
    console.log("");
  }
}

const typed = await ask("  Token: ", true);
if (typed === null) {
  console.error("\n  Aborted. Nothing was written to .env.\n");
  process.exit(1);
}
const chosen = typed || offered;
if (!chosen) {
  console.error("\n  No token given. Create one at https://dash.cloudflare.com/profile/api-tokens");
  console.error("  or run `just login` to sign in with Cloudflare instead.\n");
  process.exit(1);
}

const who = typed ? await identify(chosen) : { ok: true, accounts: [] as string[] };
if (!who.ok) {
  console.error(`\n  That token did not verify: ${who.reason}. Nothing was written to .env.\n`);
  process.exit(1);
}
if (typed && who.accounts.length > 0) {
  console.log("  This token can reach:");
  for (const account of who.accounts) console.log(`    ${account}`);
  console.log("");
}

if (!(await confirm("  Save it to .env and continue? [Y/n] "))) {
  console.error("\n  Nothing was written. Aborted.\n");
  process.exit(1);
}

writeToken(chosen);
console.log(dim("\n  Saved to .env.\n"));

/**
 * `just doctor` — tells you whether a deploy will work, before you try one.
 *
 * Every check reports a fix, not just a failure.
 */
import { resolveConfig, loadDotEnv, type PostboxConfig } from "./config.ts";
import { ensureStatePassword, readVault, vaultPath } from "./vault.ts";

const ok = (s: string) => `  \x1b[32m✓\x1b[0m ${s}`;
const bad = (s: string) => `  \x1b[31m✗\x1b[0m ${s}`;
const warn = (s: string) => `  \x1b[33m!\x1b[0m ${s}`;
const hint = (s: string) => `      \x1b[2m${s}\x1b[0m`;

const lines: string[] = [];
let fatal = false;

loadDotEnv();

let config: PostboxConfig;
try {
  config = resolveConfig();
  lines.push(ok(`Configuration valid — domain ${config.domain}, stage ${config.stage}`));
} catch (error) {
  console.log(`\n${(error as Error).message}`);
  process.exit(1);
  throw error; // unreachable; narrows `config` for the checks below
}

// ── Cloudflare ──────────────────────────────────────────────────────────────
const cfToken = process.env.CLOUDFLARE_API_TOKEN;
if (cfToken) {
  const res = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
    headers: { Authorization: `Bearer ${cfToken}` },
  });
  const body = (await res.json()) as { success?: boolean; result?: { status?: string } };
  if (res.ok && body.success && body.result?.status === "active") {
    lines.push(ok("Cloudflare API token is active"));

    const zones = await fetch(
      `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(config.domain)}`,
      { headers: { Authorization: `Bearer ${cfToken}` } },
    );
    const zoneBody = (await zones.json()) as { result?: Array<{ id: string; status: string }> };
    const zone = zoneBody.result?.[0];
    if (!zone) {
      fatal = true;
      lines.push(bad(`${config.domain} is not a zone on this Cloudflare account`));
      lines.push(hint("Add the domain in the Cloudflare dashboard and point its nameservers at Cloudflare."));
      lines.push(hint("If the zone exists but is invisible here, the token is missing Zone → Zone → Read."));
    } else if (zone.status !== "active") {
      lines.push(warn(`Zone ${config.domain} exists but is "${zone.status}", not active`));
      lines.push(hint("Nameserver propagation is still in progress. Mail will not flow until it is active."));
    } else {
      lines.push(ok(`Zone ${config.domain} is active`));
    }
  } else {
    fatal = true;
    lines.push(bad("Cloudflare API token was rejected"));
    lines.push(hint("Create a new one at https://dash.cloudflare.com/profile/api-tokens, or run `just token`."));
  }
} else {
  lines.push(warn("No CLOUDFLARE_API_TOKEN — falling back to a stored Alchemy profile"));
  lines.push(hint("Run `just login` if the deploy cannot authenticate."));
}

// ── Resend ──────────────────────────────────────────────────────────────────
const resendRes = await fetch("https://api.resend.com/domains", {
  headers: { Authorization: `Bearer ${config.resendApiKey}` },
});
if (resendRes.ok) {
  const body = (await resendRes.json()) as { data?: Array<{ name: string; status: string }> };
  lines.push(ok("Resend API key accepted with domain access"));
  const domain = body.data?.find((d) => d.name.toLowerCase() === config.domain);
  if (domain) {
    lines.push(
      domain.status === "verified"
        ? ok(`Resend domain ${config.domain} is verified — sending is live`)
        : warn(`Resend domain ${config.domain} is "${domain.status}"`),
    );
    if (domain.status !== "verified") {
      lines.push(hint("Run `just up` to write the DNS records, then `just verify`."));
    }
  } else {
    lines.push(ok(`Resend domain ${config.domain} will be registered on first deploy`));
  }
} else if (resendRes.status === 401 || resendRes.status === 403) {
  fatal = true;
  lines.push(bad("Resend rejected the API key, or it lacks domain permissions"));
  lines.push(hint("RESEND_API_KEY must be a Full access key: https://resend.com/api-keys"));
} else {
  lines.push(warn(`Resend returned ${resendRes.status} — could not confirm the key`));
}

// ── Deliverability ──────────────────────────────────────────────────────────
// The question this answers is "will what I send be read", which is worth as
// much as whether the deploy worked.
try {
  const dmarc = await fetch(
    `https://cloudflare-dns.com/dns-query?name=_dmarc.${config.domain}&type=TXT`,
    { headers: { accept: "application/dns-json" } },
  );
  const body = (await dmarc.json()) as { Answer?: { data?: string }[] };
  const policy = (body.Answer ?? [])
    .map((a) => (a.data ?? "").replace(/^"|"$/g, ""))
    .find((value) => value.toLowerCase().startsWith("v=dmarc1"));

  if (policy) {
    const mode = /p=(\w+)/i.exec(policy)?.[1] ?? "none";
    lines.push(ok(`DMARC published for ${config.domain} (p=${mode})`));
  } else {
    lines.push(warn(`No DMARC record for ${config.domain} — your mail is likelier to be filtered`));
    lines.push(hint("`just up` publishes one. Set DMARC_POLICY to choose the policy."));
  }
} catch {
  lines.push(warn("Could not check DMARC — DNS lookup failed"));
}

// ── Local state ─────────────────────────────────────────────────────────────
const vault = readVault(config.stage);
if (vault.resendSendingKey) {
  lines.push(ok(`Send-only Resend key cached in ${vaultPath(config.stage)}`));
} else {
  lines.push(ok("Send-only Resend key will be minted on first deploy"));
}

// The key that opens Alchemy's own state. Deploying without it is the one
// failure that cannot be repaired by simply re-running.
try {
  ensureStatePassword("postbox", config.stage);
  lines.push(
    process.env.ALCHEMY_PASSWORD
      ? ok("State key supplied by ALCHEMY_PASSWORD")
      : ok(`State key cached in ${vaultPath(config.stage)}`),
  );
} catch (error) {
  fatal = true;
  lines.push(bad("Deploy state is encrypted with a key this machine no longer has"));
  for (const line of String((error as Error).message).split("\n")) {
    if (line.trim()) lines.push(hint(line.trim()));
  }
}

console.log(`\n${lines.join("\n")}\n`);
console.log(
  fatal
    ? "  \x1b[31mNot ready.\x1b[0m Fix the items marked ✗ above, then re-run `just doctor`.\n"
    : "  \x1b[32mReady.\x1b[0m Run `just up`.\n",
);
process.exit(fatal ? 1 : 0);

/**
 * `just doctor` — tells you whether a deploy will work, before you try one.
 *
 * Every check reports a fix, not just a failure.
 */
import {
  cloudflareCredentials,
  loadDotEnv,
  resolveConfig,
  type PostboxConfig,
} from "./config.ts";
import { runChecks } from "./deliverability.ts";
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

/** The account the token acts on, when .env has not pinned one. */
async function accountIdFor(token: string): Promise<string | undefined> {
  const res = await fetch("https://api.cloudflare.com/client/v4/accounts?per_page=2", {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!res?.ok) return undefined;
  const body = (await res.json()) as { result?: Array<{ id: string }> };
  return body.result?.length === 1 ? body.result[0]!.id : body.result?.[0]?.id;
}

// ── Cloudflare ──────────────────────────────────────────────────────────────
// Which token, not just whether there is one: "active" is small comfort if it
// is a token from another project that happens to be exported in this shell.
const credentials = cloudflareCredentials();
if (credentials.ignored.length > 0) {
  lines.push(
    ok(`Credential taken from .env, not the shell — ignored ${credentials.ignored.join(", ")}`),
  );
}
const cfToken = process.env.CLOUDFLARE_API_TOKEN;
if (cfToken) {
  const res = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
    headers: { Authorization: `Bearer ${cfToken}` },
  });
  const body = (await res.json()) as { success?: boolean; result?: { status?: string } };
  if (res.ok && body.success && body.result?.status === "active") {
    // resolveConfig above has already refused an unclaimed environment token,
    // so reaching here on one means CI opted in on purpose. Say which, either
    // way: "active" answers a different question from "the one you meant".
    lines.push(
      ok(
        `Cloudflare API token is active — …${credentials.fingerprint} from ` +
          (credentials.source === "env-file"
            ? ".env"
            : "your environment (POSTBOX_ALLOW_ENV_TOKEN)"),
      ),
    );

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

    // A token that authenticates is not a token that can do the job, and the
    // difference used to surface six resources into a deploy — after the Resend
    // domain, its DNS records and a scoped key already existed. Each of these
    // is the cheapest read on a surface the deploy later writes to: a 403 here
    // is proof of a missing permission group, in the wording the dashboard uses.
    if (zone) {
      const account = config.accountId ?? (await accountIdFor(cfToken));
      const needed = [
        ["Zone → DNS → Edit", `/zones/${zone.id}/dns_records?per_page=1`],
        ["Zone → Workers Routes → Edit", `/zones/${zone.id}/workers/routes`],
        // Enabling Email Routing writes zone settings, so it is Zone Settings
        // that gates it — not the Email Routing group the name suggests, which
        // only covers the rules underneath. Two probes, because a token can
        // easily have one and not the other.
        ["Zone → Zone Settings → Edit", `/zones/${zone.id}/email/routing`],
        ["Zone → Email Routing Rules → Edit", `/zones/${zone.id}/email/routing/rules?per_page=1`],
        ["Account → Email Routing Addresses → Edit", `/accounts/${account}/email/routing/addresses?per_page=1`],
        ["Account → Workers Scripts → Edit", `/accounts/${account}/workers/scripts`],
        ["Account → D1 → Edit", `/accounts/${account}/d1/database?per_page=1`],
        ["Account → Workers KV Storage → Edit", `/accounts/${account}/storage/kv/namespaces?per_page=1`],
      ];

      const missing = account
        ? (
            await Promise.all(
              needed.map(async ([permission, url]) => {
                const probe = await fetch(`https://api.cloudflare.com/client/v4${url}`, {
                  headers: { Authorization: `Bearer ${cfToken}` },
                }).catch(() => null);
                return probe && probe.status === 403 ? permission : null;
              }),
            )
          ).filter((permission) => permission !== null)
        : [];

      // Cloudflare refuses every script upload on an account that has never
      // had a workers.dev subdomain — including this one, which does not
      // publish to it. Worth one GET here rather than a 403 after the build.
      if (account) {
        const sub = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${account}/workers/subdomain`,
          { headers: { Authorization: `Bearer ${cfToken}` } },
        ).catch(() => null);
        if (sub?.status === 404) {
          fatal = true;
          lines.push(bad("This account has no workers.dev subdomain — no Worker can be uploaded"));
          lines.push(hint("Open https://dash.cloudflare.com/?to=/:account/workers/workers-and-pages"));
          lines.push(hint("once; the landing page creates one. Postbox does not publish to it."));
        }
      }

      // Cloudflare will not forward to an address until a human has clicked
      // the link it emails them, and a rule that names an unverified address
      // is rejected outright — so a first deploy with FORWARD_TO set always
      // fails once, waits for the click, and succeeds on the next run.
      if (account && config.forwardTo) {
        const res = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${account}/email/routing/addresses?per_page=50`,
          { headers: { Authorization: `Bearer ${cfToken}` } },
        ).catch(() => null);
        const body = res?.ok
          ? ((await res.json()) as { result?: Array<{ email: string; verified?: string | null }> })
          : undefined;
        const address = body?.result?.find(
          (a) => a.email.toLowerCase() === config.forwardTo!.toLowerCase(),
        );
        if (!address) {
          lines.push(warn(`FORWARD_TO ${config.forwardTo} is not a destination address yet`));
          lines.push(hint("`just up` registers it, and Cloudflare emails it a link somebody has to"));
          lines.push(hint("click. The deploy fails until they do — then re-run it."));
        } else if (!address.verified) {
          // Not fatal: the deploy skips the forwarding rule while this is
          // pending rather than failing on it, and adds the rule on the run
          // after somebody clicks. Everything else still deploys.
          lines.push(warn(`FORWARD_TO ${config.forwardTo} has not been verified`));
          lines.push(hint("Open that mailbox and click the link Cloudflare sent it. Until then the"));
          lines.push(hint("forwarding copy is off and `just up` leaves the postmaster rule out."));
        } else {
          lines.push(ok(`Forwarding copies to ${config.forwardTo} — verified`));
        }
      }

      if (missing.length === 0) {
        lines.push(ok("Token can reach every service the deploy touches"));
      } else {
        fatal = true;
        lines.push(bad(`Token is missing ${missing.length === 1 ? "a permission" : "permissions"}`));
        for (const permission of missing) lines.push(hint(permission));
        // Not `just token`: the token it mints is built from Alchemy's OAuth
        // scopes, and those do not include Email Routing at all. Editing the
        // token you already have is both shorter and the only thing that works.
        lines.push(hint("Edit the token at https://dash.cloudflare.com/profile/api-tokens,"));
        lines.push(hint("adding each line above, with this zone under Zone Resources."));
      }
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
// much as whether the deploy worked. A failure here is never fatal to a
// deploy — DNS that has not propagated yet looks identical to DNS that is
// wrong, and refusing to deploy over it would be wrong on the first run of
// every new domain.
try {
  const checks = await runChecks(config);
  for (const check of checks) {
    if (check.status === "ok") lines.push(ok(check.text));
    else if (check.status === "bad") lines.push(bad(check.text));
    else if (check.status === "warn") lines.push(warn(check.text));
    else continue; // `info` is `just mailcheck` detail, not a deploy blocker
    for (const line of check.hints) lines.push(hint(line));
  }
  if (checks.some((c) => c.status !== "ok")) {
    lines.push(hint("Full report, including what is merely advisable: `just mailcheck`"));
  }
} catch {
  lines.push(warn("Could not check deliverability — DNS lookups failed"));
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

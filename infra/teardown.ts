/**
 * The part of `just down` that decides what it is *not* allowed to remove.
 *
 * Alchemy destroys what it has state for, and its Email Routing resource
 * destroys by switching Email Routing off for the whole zone — which, on a
 * domain that was already receiving mail before Postbox arrived, is somebody
 * else's outage. The same goes for a destination address other rules forward
 * to, and for a catch-all that pointed somewhere before we repointed it.
 *
 * There is no "forget this resource" command, but state is a directory of
 * files: removing one leaves the live object untouched and invisible to
 * `alchemy destroy`. That is what "keeping" means here.
 *
 * Three steps, in the order `just down` runs them:
 *
 *   plan     print what will go and what will stay, before anything happens
 *   forget   drop the state for everything that stays
 *   restore  put back the catch-all rule Postbox replaced, if there was one
 */
import fs from "node:fs";
import path from "node:path";
import { createCloudflareApi, findZoneForHostname } from "alchemy/cloudflare";
import { resolveConfig } from "./config.ts";
import { isOurs, readProvenance, type CatchAllRule } from "./provenance.ts";

const config = resolveConfig();
const mode = (process.argv[2] ?? "plan") as "plan" | "forget" | "restore";

const c = {
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  reset: "\x1b[0m",
};

const stateDir = path.resolve(process.cwd(), ".alchemy", "postbox", config.stage);

interface Keep {
  /**
   * Alchemy resource id, which is also its state file name. Absent where the
   * resource preserves itself and there is nothing to forget.
   */
  id?: string;
  what: string;
  why: string;
}

async function catchAllNow(): Promise<CatchAllRule | null> {
  try {
    const api = await createCloudflareApi({ accountId: config.accountId });
    const { zoneId } = await findZoneForHostname(api, config.domain);
    const response = await api.get(`/zones/${zoneId}/email/routing/rules/catch_all`);
    if (!response.ok) return null;
    const body = (await response.json()) as { result?: CatchAllRule };
    return body.result ?? null;
  } catch {
    return null;
  }
}

/**
 * Everything Postbox must leave behind, and the reason for each.
 *
 * "Cannot tell" resolves to keeping it. This deployment may predate the record
 * that would have settled it, and the two outcomes are not comparable: leaving
 * a switch on is untidy, turning off mail for a domain is an incident.
 */
async function plan(): Promise<Keep[]> {
  const prior = readProvenance(config.stage);
  const keep: Keep[] = [];

  if (prior.emailRouting !== false) {
    keep.push({
      id: "email-routing",
      what: "Email Routing",
      why:
        prior.emailRouting === true
          ? "it was already switched on before Postbox"
          : "cannot tell whether it predates Postbox, and switching it off stops all mail for the domain",
    });
  }

  if (config.forwardTo && prior.forwardAddress !== false) {
    keep.push({
      id: "forward-address",
      what: `Destination address ${config.forwardTo}`,
      why:
        prior.forwardAddress === true
          ? "it was already verified in this account"
          : "cannot tell whether it predates Postbox, and other rules may forward to it",
    });
  }

  if (config.mailProvider === "resend" && prior.resendDomain !== false) {
    keep.push({
      what: `The domain ${config.domain} in Resend`,
      why:
        prior.resendDomain === true
          ? "it was registered there before Postbox"
          : "cannot tell whether it predates Postbox, and other keys may send through it",
    });
  }

  const live = await catchAllNow();
  if (live && !isOurs(live)) {
    keep.push({
      id: "catch-all",
      what: "The zone's catch-all rule",
      why: "it is not the rule Postbox created — someone changed it since",
    });
  }

  return keep;
}

function forget(keep: Keep[]): void {
  for (const item of keep) {
    if (!item.id) continue;
    const file = path.join(stateDir, `${item.id}.json`);
    if (fs.existsSync(file)) fs.rmSync(file);
  }
}

/**
 * Put the catch-all back the way it was.
 *
 * Postbox does not create the catch-all so much as take it over, so the honest
 * reversal is the rule that was there before, not an empty one. Only runs when
 * the rule we are replacing is still ours — if someone changed it in the
 * meantime, their version stands.
 */
async function restore(): Promise<void> {
  const prior = readProvenance(config.stage);
  if (!prior.catchAll) return;

  try {
    const api = await createCloudflareApi({ accountId: config.accountId });
    const { zoneId } = await findZoneForHostname(api, config.domain);
    const response = await api.put(`/zones/${zoneId}/email/routing/rules/catch_all`, {
      enabled: prior.catchAll.enabled,
      name: prior.catchAll.name ?? "Catch All",
      matchers: prior.catchAll.matchers ?? [{ type: "all" }],
      actions: prior.catchAll.actions ?? [{ type: "drop" }],
    });
    if (response.ok) {
      console.log(
        `\n  ${c.green}✓${c.reset} Restored the catch-all rule that was there before Postbox.\n`,
      );
    } else {
      console.log(
        `\n  ${c.yellow}!${c.reset} Could not restore the previous catch-all rule (${response.status}).` +
          `\n    ${c.dim}It is recorded in ${path.relative(process.cwd(), path.join(".secrets", `postbox.${config.stage}.json`))} if you want to put it back by hand.${c.reset}\n`,
      );
    }
  } catch {
    /* the account is already torn down, or unreachable; nothing to restore into */
  }
}

const keep = mode === "restore" ? [] : await plan();

if (mode === "plan") {
  console.log(`
  ${c.bold}This removes${c.reset}
    · the Worker, its database and its KV namespace
    · every message stored in ${config.names.database}, permanently
    · the DNS records Postbox wrote${keep.some((k) => k.id === "catch-all") ? "" : "\n    · the catch-all rule pointing mail at the app"}
    · the send-only Resend key
`);

  if (keep.length > 0) {
    console.log(`  ${c.bold}This keeps${c.reset}`);
    for (const item of keep) {
      console.log(`    · ${item.what}\n      ${c.dim}${item.why}${c.reset}`);
    }
    console.log("");
  }

  console.log(
    `  ${c.dim}DNS records Postbox did not write are never touched, whatever else happens.${c.reset}\n`,
  );
} else if (mode === "forget") {
  forget(keep);
} else {
  await restore();
}

/**
 * Postbox — infrastructure.
 *
 * One file provisions the whole product:
 *
 *   Cloudflare        D1 (mail store) · KV (sessions) · Worker + static assets
 *                     (UI + API + inbound email handler + cron)
 *                     Email Routing (inbound, free & unlimited)
 *                     DNS records for Resend (written for you)
 *   Resend            sending domain · scoped send-only API key
 *   Locally           generated secrets, cached in .secrets/ so redeploys are
 *                     idempotent instead of minting duplicates
 *
 * Everything here is reversible — `just down` removes all of it.
 */
import alchemy from "alchemy";
import {
  D1Database,
  DnsRecords,
  EmailCatchAll,
  EmailRouting,
  EmailAddress,
  EmailRule,
  KVNamespace,
  Vite,
  createCloudflareApi,
  findZoneForHostname,
} from "alchemy/cloudflare";

import { resolveConfig } from "./infra/config.ts";
import {
  ResendDomain,
  ResendSendingKey,
  ResendVerification,
} from "./infra/resend.ts";
import { readVault, randomPassword, randomSecret, updateVault } from "./infra/vault.ts";
import { printSummary } from "./infra/report.ts";

const config = resolveConfig();

const app = await alchemy("postbox", { stage: config.stage });

// ── 0. Fail fast, and fail legibly ──────────────────────────────────────────
// Everything downstream assumes DOMAIN is a live zone on this account. Finding
// that out here produces one clear sentence instead of a stack trace from the
// fourth resource in.
const api = await createCloudflareApi({ accountId: config.accountId });
let zoneId: string;
try {
  ({ zoneId } = await findZoneForHostname(api, config.domain));
} catch {
  throw new Error(
    `"${config.domain}" is not a zone in Cloudflare account ${api.accountId}.\n` +
      "  Add the domain at https://dash.cloudflare.com and point its nameservers\n" +
      "  at Cloudflare, then run `just up` again.",
  );
}

// ── 1. Locally generated secrets ────────────────────────────────────────────
// Generated once, reused forever. Regenerating the auth secret would sign
// every existing session out, so it is deliberately sticky.
const vault = updateVault(config.stage, (current) => ({
  ...current,
  authSecret: current.authSecret ?? randomSecret(),
  appPassword: config.appPassword ?? current.appPassword ?? randomPassword(),
  appPasswordGenerated:
    current.appPasswordGenerated ?? (!config.appPassword && !current.appPassword),
}));

// ── 2. Storage ──────────────────────────────────────────────────────────────
const db = await D1Database("mail-db", {
  name: config.names.database,
  migrationsDir: "./migrations",
  adopt: true,
});

// Sessions, the undo-send buffer and per-address rate counters. All of it is
// disposable — losing KV logs you out, nothing more.
const cache = await KVNamespace("cache", {
  title: config.names.kv,
  adopt: true,
});

// ── 3. Resend: sending domain, DNS, verification, scoped key ────────────────
const sendingDomain = await ResendDomain("resend-domain", {
  name: config.domain,
  apiKey: config.resendApiKey,
  region: config.resendRegion,
  stage: config.stage,
});

// The step everyone normally does by hand in a dashboard.
// Resend publishes its records under `send.<domain>` and `<selector>._domainkey`,
// which is why they coexist with Email Routing's apex MX records instead of
// fighting them.
const sendingDns = await DnsRecords("resend-dns", {
  zoneId,
  records: sendingDomain.records.map((record) => ({
    type: record.type,
    name: record.name,
    content: record.content,
    priority: record.priority,
    ttl: 1, // 1 = automatic
    proxied: false,
    comment: `Postbox · Resend ${record.purpose}`,
  })),
});

const verification = await ResendVerification("resend-verify", {
  domainId: sendingDomain.domainId,
  apiKey: config.resendApiKey,
  dependsOn: sendingDns.records.map((r) => r.id).join(","),
});

// The credential production actually runs on: send-only, pinned to this one
// domain. The full-access key from .env never leaves your machine.
const sendingKey = await ResendSendingKey("resend-key", {
  apiKey: config.resendApiKey,
  domainId: sendingDomain.domainId,
  name: `postbox-${config.stage}-${config.domain}`,
  stage: config.stage,
});

// ── 4. Inbound mail ─────────────────────────────────────────────────────────
// Free and unlimited on the Workers Free plan. Enabling this writes the apex
// MX + SPF records for receiving.
const routing = await EmailRouting("email-routing", {
  zone: config.domain,
  enabled: true,
  skipWizard: true,
});

// Optional safety net: keep a copy flowing to a real mailbox. Cloudflare sends
// a one-click verification link the first time this address is used.
const forwardAddress = config.forwardTo
  ? await EmailAddress("forward-address", { email: config.forwardTo })
  : undefined;

// ── 5. The application ──────────────────────────────────────────────────────
// A single Worker serves the React UI from static assets, the JSON API, the
// inbound `email()` handler and the cron tick. Static asset requests on
// Workers are free and unmetered, so the UI costs nothing to serve.
export const site = await Vite("postbox", {
  name: config.names.worker,
  entrypoint: "./src/worker/index.ts",
  compatibilityFlags: ["nodejs_compat"],
  adopt: true,
  // Without this, a request to /api/* that does not match a built file is
  // answered with index.html by the asset layer and never reaches the Worker.
  assets: { run_worker_first: ["/api/*"] },
  url: true,
  domains: [{ domainName: config.appHostname, zoneId, adopt: true }],
  // Wake up once a minute to flush scheduled sends and un-snooze threads.
  crons: ["* * * * *"],
  observability: { enabled: true },
  bindings: {
    DB: db,
    CACHE: cache,

    RESEND_API_KEY: alchemy.secret(sendingKey.token),
    AUTH_SECRET: alchemy.secret(vault.authSecret!),
    APP_PASSWORD: alchemy.secret(vault.appPassword!),

    MAIL_DOMAIN: config.domain,
    DEFAULT_FROM: config.defaultFrom,
    APP_HOSTNAME: config.appHostname,
    FORWARD_TO: config.forwardTo ?? "",
    STAGE: config.stage,
    // Seeded from the verification we just ran; the Worker upgrades this to a
    // sticky "yes" in KV after its first successful send.
    SENDING_READY: verification.verified ? "1" : "0",
  },
});

// ── 6. Point the domain's mail at the Worker ────────────────────────────────
// Declared after the Worker so the rule has something to reference. A
// catch-all means every address on the domain — sales@, hi@, typos — lands in
// Postbox, which is what makes single-domain aliasing free.
await EmailCatchAll("catch-all", {
  zone: routing.zoneId,
  name: "Postbox — deliver everything to the app",
  enabled: true,
  actions: [{ type: "worker", value: [config.names.worker] }],
});

// A higher-priority literal rule cannot express "everything", so the optional
// Gmail copy is made by the Worker itself; this rule only exists to keep the
// destination address verified and visible in the dashboard.
if (forwardAddress) {
  await EmailRule("forward-postmaster", {
    zone: routing.zoneId,
    name: "Postbox — postmaster passthrough",
    enabled: true,
    priority: 1,
    matchers: [{ type: "literal", field: "to", value: `postmaster@${config.domain}` }],
    actions: [{ type: "forward", value: [forwardAddress.email] }],
  });
}

await app.finalize();

// `alchemy destroy` runs this same program with every resource in delete
// phase, so the deploy summary only makes sense on the way up.
if (app.phase === "up") {
  await printSummary({
    config,
    url: site.url ?? `https://${config.appHostname}`,
    appHostname: config.appHostname,
    password: vault.appPassword!,
    passwordWasGenerated: vault.appPasswordGenerated === true,
    sendingStatus: verification.status,
    forwardTo: forwardAddress?.email,
    forwardVerified: forwardAddress?.verified ?? false,
    dnsRecordCount: sendingDns.records.length,
    vaultRead: readVault(config.stage),
  });
}

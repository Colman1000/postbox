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
  DurableObjectNamespace,
  EmailCatchAll,
  EmailRouting,
  EmailAddress,
  EmailRule,
  EmailSender,
  KVNamespace,
  Vite,
  createCloudflareApi,
  findZoneForHostname,
} from "alchemy/cloudflare";

import { resolveConfig } from "./infra/config.ts";
import { captureProvenance, classifyRecords } from "./infra/provenance.ts";
import {
  ResendDomain,
  ResendSendingKey,
  ResendVerification,
} from "./infra/resend.ts";
import {
  ensureStatePassword,
  readVault,
  randomPassword,
  randomSecret,
  updateVault,
} from "./infra/vault.ts";
import { printSummary } from "./infra/report.ts";

const config = resolveConfig();

// Alchemy encrypts every secret it writes into `.alchemy/`, and refuses to
// write one without a passphrase. That passphrase is generated on first run
// and cached in `.secrets/`, so this is one more thing nobody has to invent.
const app = await alchemy("postbox", {
  stage: config.stage,
  password: ensureStatePassword("postbox", config.stage),
});

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

// ── 0b. What was here first ─────────────────────────────────────────────────
// Recorded before a single resource is created, because after that the answer
// is Postbox's own handiwork. `just down` reads this to decide what it is
// allowed to take with it.
const prior = await captureProvenance(api, {
  stage: config.stage,
  zoneId,
  databaseName: config.names.database,
  kvTitle: config.names.kv,
  forwardTo: config.forwardTo,
});

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
  // A database that was here first is not ours to drop, however it is named.
  delete: prior.database !== true,
});

// Sessions, the undo-send buffer and per-address rate counters. All of it is
// disposable — losing KV logs you out, nothing more.
const cache = await KVNamespace("cache", {
  title: config.names.kv,
  adopt: true,
  delete: prior.kv !== true,
});

// ── 3. Outbound: whichever provider this deployment is configured for ───────
//
// Resend is the default because it is the only way to send from a free
// Cloudflare account. Cloudflare's own Email Sending is better in every other
// respect — no third party, no second credential — but it requires the Workers
// Paid plan, so it is opt-in via MAIL_PROVIDER.
const usingResend = config.mailProvider === "resend";

const sendingDomain = usingResend
  ? await ResendDomain("resend-domain", {
      name: config.domain,
      apiKey: config.resendApiKey,
      region: config.resendRegion,
      stage: config.stage,
      // Deleting a domain we merely adopted would take the operator's other
      // sending down with it.
      preserve: prior.resendDomain !== false,
    })
  : undefined;

// The step everyone normally does by hand in a dashboard.
// Resend publishes its records under `send.<domain>` and
// `<selector>._domainkey`, which is why they coexist with Email Routing's apex
// MX records instead of fighting them.
// Records that already existed and were not written by Postbox are updated in
// place if they must be, but never deleted: `just down` has no business
// removing DNS somebody else set up. Ownership is read off the live record's
// comment, so it stays right even for deployments made before this existed.
const wanted = sendingDomain?.records ?? [];
const split = sendingDomain
  ? await classifyRecords(api, zoneId, wanted)
  : { ours: [], adopted: [] };

const asRecord = (record: (typeof wanted)[number]) => ({
  type: record.type,
  name: record.name,
  content: record.content,
  priority: record.priority,
  ttl: 1, // 1 = automatic
  proxied: false,
  comment: `Postbox · Resend ${record.purpose}`,
});

const sendingDns = sendingDomain
  ? await DnsRecords("resend-dns", {
      zoneId,
      records: split.ours.map(asRecord),
    })
  : undefined;

const adoptedDns =
  sendingDomain && split.adopted.length > 0
    ? await DnsRecords("resend-dns-adopted", {
        zoneId,
        records: split.adopted.map(asRecord),
        delete: false,
      })
    : undefined;

const verification =
  sendingDomain && sendingDns
    ? await ResendVerification("resend-verify", {
        domainId: sendingDomain.domainId,
        apiKey: config.resendApiKey,
        dependsOn: [...sendingDns.records, ...(adoptedDns?.records ?? [])]
          .map((r) => r.id)
          .join(","),
      })
    : undefined;

// The credential production actually runs on: send-only, pinned to this one
// domain. The full-access key from .env never leaves your machine.
const sendingKey = sendingDomain
  ? await ResendSendingKey("resend-key", {
      apiKey: config.resendApiKey,
      domainId: sendingDomain.domainId,
      name: `postbox-${config.stage}-${config.domain}`,
      stage: config.stage,
    })
  : undefined;

// ── 4. Inbound mail ─────────────────────────────────────────────────────────
// Free and unlimited on the Workers Free plan. Enabling this writes the apex
// MX + SPF records for receiving.
await EmailRouting("email-routing", {
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
  url: config.workersDevUrl,
  domains: [{ domainName: config.appHostname, zoneId, adopt: true }],
  // Wake up once a minute to flush scheduled sends and un-snooze threads.
  crons: ["* * * * *"],
  observability: { enabled: true },
  bindings: {
    DB: db,
    CACHE: cache,

    // The doorbell an open tab waits on, so new mail appears without polling
    // for it. SQLite-backed because that is the only kind the Workers Free
    // plan offers — and this one stores nothing anyway, so the backend costs
    // nothing either way.
    MAILBOX: DurableObjectNamespace("mailbox", {
      className: "Mailbox",
      sqlite: true,
    }),

    // Exactly one of these is present, depending on MAIL_PROVIDER. The
    // Cloudflare path needs no credential at all — the binding is already
    // authenticated as this Worker.
    ...(sendingKey
      ? { RESEND_API_KEY: alchemy.secret(sendingKey.token) }
      : {
          // Unrestricted on purpose: identities are added at runtime from
          // Settings, so pinning the allow-list at deploy time would break
          // every address created afterwards.
          EMAIL: EmailSender(),
        }),

    AUTH_SECRET: alchemy.secret(vault.authSecret!),
    APP_PASSWORD: alchemy.secret(vault.appPassword!),

    MAIL_DOMAIN: config.domain,
    DEFAULT_FROM: config.defaultFrom,
    APP_HOSTNAME: config.appHostname,
    FORWARD_TO: config.forwardTo ?? "",
    STAGE: config.stage,
    MAIL_PROVIDER: config.mailProvider,
    // Seeded from the verification we just ran; the Worker upgrades this to a
    // sticky "yes" in KV after its first successful send.
    SENDING_READY: usingResend ? (verification?.verified ? "1" : "0") : "1",
  },
});

// ── 6. Point the domain's mail at the Worker ────────────────────────────────
// Declared after the Worker so the rule has something to reference. A
// catch-all means every address on the domain — sales@, hi@, typos — lands in
// Postbox, which is what makes single-domain aliasing free.
// `zone` here is a hostname, not an id — Alchemy looks the zone up for you.
await EmailCatchAll("catch-all", {
  zone: config.domain,
  name: "Postbox — deliver everything to the app",
  enabled: true,
  actions: [{ type: "worker", value: [config.names.worker] }],
});

// A higher-priority literal rule cannot express "everything", so the optional
// Gmail copy is made by the Worker itself; this rule only exists to keep the
// destination address verified and visible in the dashboard.
if (forwardAddress) {
  await EmailRule("forward-postmaster", {
    zone: config.domain,
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
    provider: config.mailProvider,
    sendingStatus: usingResend ? (verification?.status ?? "pending") : "verified",
    forwardTo: forwardAddress?.email,
    forwardVerified: forwardAddress?.verified ?? false,
    dnsRecordCount:
      (sendingDns?.records.length ?? 0) + (adoptedDns?.records.length ?? 0),
    vaultRead: readVault(config.stage),
  });
}

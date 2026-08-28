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
import { createHash } from "node:crypto";

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
  Worker,
  createCloudflareApi,
  findZoneForHostname,
} from "alchemy/cloudflare";

import { resolveConfig } from "./infra/config.ts";
import {
  captureProvenance,
  classifyRecords,
  foreignRecordExists,
} from "./infra/provenance.ts";
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
  randomVapidKeys,
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
} catch (error) {
  // Only one of the failures in here means what it sounds like. Listing the
  // zones can also fail because the API had a bad minute or because the token
  // is short a permission, and telling someone their live domain does not
  // exist is a worse answer than showing them the error we actually got.
  const detail = error instanceof Error ? error.message : String(error);
  if (!detail.startsWith("Could not find zone for hostname")) {
    throw new Error(
      `Could not check whether "${config.domain}" is a zone in Cloudflare account ` +
        `${api.accountId}.\n  ${detail}\n` +
        "  This is usually temporary — run `just up` again. If it keeps happening,\n" +
        "  `just doctor` checks the token one permission at a time.",
      { cause: error },
    );
  }
  throw new Error(
    `"${config.domain}" is not a zone in Cloudflare account ${api.accountId}.\n` +
      "  Add the domain at https://dash.cloudflare.com and point its nameservers\n" +
      "  at Cloudflare, then run `just up` again.",
    { cause: error },
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
const vapid = readVault(config.stage).vapidPublicKey
  ? null
  : randomVapidKeys();

const vault = updateVault(config.stage, (current) => ({
  ...current,
  authSecret: current.authSecret ?? randomSecret(),
  appPassword: config.appPassword ?? current.appPassword ?? randomPassword(),
  appPasswordGenerated:
    current.appPasswordGenerated ?? (!config.appPassword && !current.appPassword),
  // Push notifications. Sticky for a sharper reason than the others:
  // regenerating this pair silently invalidates every phone already
  // subscribed, and the symptom is notifications that simply stop.
  vapidPublicKey: current.vapidPublicKey ?? vapid?.publicKey,
  vapidPrivateKey: current.vapidPrivateKey ?? vapid?.privateKey,
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
// DMARC is the record nobody writes and every receiver looks for. Without one
// a domain has no published policy, and mail from a new domain with no policy
// is exactly the shape of mail that lands in spam — so Postbox publishes one
// if, and only if, the domain does not already have *somebody else's*. A
// policy already there is a decision about the whole domain, quite possibly
// stricter than ours, and replacing it silently would be worse than never
// writing it. One Postbox wrote is a different matter: it has to stay in the
// desired set to survive the next deploy.
//
// Asked on both paths, not just Resend's. Nothing about a published policy is
// specific to who does the sending, and Cloudflare Email Sending publishes no
// DMARC of its own either.
const dmarcName = `_dmarc.${config.domain}`;
const dmarcTaken = await foreignRecordExists(api, zoneId, "TXT", dmarcName);

// `rua` is the half of DMARC that reports back. Without it the record is a
// one-way instruction: receivers act on the policy and you never learn who is
// sending as your domain, nor which of your own senders are failing — which
// makes every later decision to tighten the policy a guess. `adkim`/`aspf`
// stay relaxed because the sending provider's Return-Path lives on a
// subdomain, and strict alignment would fail every message.
const dmarcTags = [
  "v=DMARC1",
  `p=${config.dmarcPolicy}`,
  ...(config.dmarcRua ? [`rua=${config.dmarcRua}`] : []),
  ...(config.dmarcPct !== undefined ? [`pct=${config.dmarcPct}`] : []),
  "adkim=r",
  "aspf=r",
  // Report on the whole domain rather than per-message-failure: `fo=1` asks
  // for a report whenever *any* mechanism fails, which is what makes a partial
  // misconfiguration visible instead of only a total one.
  ...(config.dmarcRua ? ["fo=1"] : []),
];

const dmarcRecord = dmarcTaken
  ? []
  : [
      {
        type: "TXT" as const,
        name: dmarcName,
        content: dmarcTags.join("; "),
        priority: undefined,
        purpose: "DMARC policy",
      },
    ];

// ── TLS reporting ───────────────────────────────────────────────────────────
// One record, no moving parts, nothing it can break: receivers mail a daily
// summary of how TLS negotiation to your MX went. It is the cheapest visibility
// in the whole setup, and the only way to notice a downgrade before it matters.
const tlsRptName = `_smtp._tls.${config.domain}`;
const tlsRptTaken = config.tlsRptTo
  ? await foreignRecordExists(api, zoneId, "TXT", tlsRptName)
  : true;

const tlsRptRecord =
  config.tlsRptTo && !tlsRptTaken
    ? [
        {
          type: "TXT" as const,
          name: tlsRptName,
          content: `v=TLSRPTv1; rua=${config.tlsRptTo}`,
          priority: undefined,
          purpose: "TLS reporting",
        },
      ]
    : [];

// ── MTA-STS ─────────────────────────────────────────────────────────────────
// Tells senders that mail for this domain must go over authenticated TLS to a
// named set of MX hosts, which closes the downgrade attack SMTP is open to by
// default. The policy is served over HTTPS by its own tiny Worker (below), and
// the id below must change whenever the policy text does — so it is derived
// from the policy text itself and cannot drift out of step with it.
const mtaStsPolicy =
  config.mtaSts === "off"
    ? undefined
    : [
        "version: STSv1",
        `mode: ${config.mtaSts}`,
        // Every Email Routing MX is under this suffix, so one wildcard covers
        // route1/2/3 and survives Cloudflare adding a fourth.
        "mx: *.mx.cloudflare.net",
        "max_age: 86400",
      ].join("\n") + "\n";

const mtaStsId = mtaStsPolicy
  ? createHash("sha256").update(mtaStsPolicy).digest("hex").slice(0, 16)
  : undefined;

const mtaStsHostname = `mta-sts.${config.domain}`;

const mtaStsRecords =
  mtaStsPolicy && mtaStsId
    ? [
        {
          type: "TXT" as const,
          name: `_mta-sts.${config.domain}`,
          content: `v=STSv1; id=${mtaStsId}`,
          priority: undefined,
          purpose: "MTA-STS policy id",
        },
      ]
    : [];

// ── domain ownership ────────────────────────────────────────────────────────
// Google Postmaster Tools is the only place Gmail will tell you your own spam
// complaint rate and domain reputation, and it will not tell you until the
// domain is verified. One TXT record buys that.
const siteVerificationRecord = config.siteVerification
  ? [
      {
        type: "TXT" as const,
        name: config.domain,
        content: `google-site-verification=${config.siteVerification.replace(/^google-site-verification=/, "")}`,
        priority: undefined,
        purpose: "Google site verification",
      },
    ]
  : [];

// The provider's own records keep their provider in the comment; DMARC is
// Postbox's regardless of which provider is sending.
const providerRecords = (sendingDomain?.records ?? []).map((record) => ({
  ...record,
  purpose: `Resend ${record.purpose}`,
}));

const wanted = [
  ...providerRecords,
  ...dmarcRecord,
  ...tlsRptRecord,
  ...mtaStsRecords,
  ...siteVerificationRecord,
];
const split =
  wanted.length > 0
    ? await classifyRecords(api, zoneId, wanted)
    : { ours: [] as typeof wanted, adopted: [] as typeof wanted };

const asRecord = (record: (typeof wanted)[number]) => ({
  type: record.type as "TXT" | "MX" | "CNAME" | "A" | "AAAA",
  name: record.name,
  content: record.content,
  priority: record.priority,
  ttl: 1, // 1 = automatic
  proxied: false,
  comment: `Postbox · ${record.purpose}`,
});

// The id is the key Alchemy files this resource's state under, so every
// deployment that already has a "resend-dns" has to keep it: a rename reads as
// one resource gone and another arrived, which would delete live DNS and write
// it straight back.
const dnsId = usingResend ? "resend-dns" : "postbox-dns";

const managedDns =
  sendingDomain || split.ours.length > 0
    ? await DnsRecords(dnsId, {
        zoneId,
        records: split.ours.map(asRecord),
      })
    : undefined;

const adoptedDns =
  split.adopted.length > 0
    ? await DnsRecords(`${dnsId}-adopted`, {
        zoneId,
        records: split.adopted.map(asRecord),
        delete: false,
      })
    : undefined;

const verification =
  sendingDomain && managedDns
    ? await ResendVerification("resend-verify", {
        domainId: sendingDomain.domainId,
        apiKey: config.resendApiKey,
        dependsOn: [...managedDns.records, ...(adoptedDns?.records ?? [])]
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
  //
  // The manifest and the two icon paths are here for the same reason. They
  // look like static files and are not: what they answer with depends on the
  // icon this mailbox has chosen, so they have to be generated. The icon
  // Postbox ships stays a real static file under /icons/, which these patterns
  // deliberately do not match — the default costs no Worker request at all.
  assets: {
    run_worker_first: [
      "/api/*",
      "/manifest.webmanifest",
      "/icons/app.png",
      "/icons/app-maskable.png",
      "/apple-touch-icon.png",
    ],
  },
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

    // The public half is not a secret — the browser is handed it to subscribe
    // with, and it is in every push we sign. It is bound as a plain variable
    // for exactly that reason.
    VAPID_PUBLIC_KEY: vault.vapidPublicKey!,
    VAPID_PRIVATE_KEY: alchemy.secret(vault.vapidPrivateKey!),

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

// ── 5b. The MTA-STS policy ──────────────────────────────────────────────────
// Its own Worker, on its own hostname, serving exactly one file.
//
// The policy has to be fetched over HTTPS from `mta-sts.<domain>`, and the
// obvious shortcut — hanging that hostname off the app Worker — would put a
// second public door on the mailbox to serve a 200-byte text file. This one
// has no bindings, so it cannot reach the database even by accident.
const mtaStsWorker = mtaStsPolicy
  ? await Worker("mta-sts", {
      name: `${config.names.worker}-mta-sts`,
      adopt: true,
      script: `const POLICY = ${JSON.stringify(mtaStsPolicy)};

export default {
  fetch(request) {
    if (new URL(request.url).pathname !== "/.well-known/mta-sts.txt") {
      return new Response("Not found\\n", { status: 404 });
    }
    return new Response(POLICY, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        // Senders cache the policy for max_age anyway; an hour at the edge is
        // short enough that a mode change takes effect the same day.
        "cache-control": "public, max-age=3600",
      },
    });
  },
};
`,
      domains: [{ domainName: mtaStsHostname, zoneId, adopt: true }],
      observability: { enabled: true },
    })
  : undefined;

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

/**
 * Whether anyone has clicked the link Cloudflare sent the forwarding address.
 *
 * Asked of Cloudflare rather than read off `forwardAddress.verified`, because
 * Alchemy skips an unchanged resource without re-reading it — so that field
 * goes on saying what it said the day the address was created, which is "no",
 * for as long as the address exists. The id is safe to reuse from state: it
 * does not change, only the verification does.
 */
async function isVerified(addressId: string): Promise<boolean> {
  const response = await api.get(
    `/accounts/${api.accountId}/email/routing/addresses/${addressId}`,
  );
  if (!response.ok) return false;
  const body = (await response.json()) as { result?: { verified?: string | null } };
  return Boolean(body.result?.verified);
}

// A higher-priority literal rule cannot express "everything", so the optional
// Gmail copy is made by the Worker itself; this rule only exists to keep the
// destination address verified and visible in the dashboard.
//
// It waits for the confirmation rather than failing on it. Cloudflare rejects
// any rule naming an unconfirmed address, and the confirmation is an email a
// human has to open — which cannot happen inside the same deploy that sends
// it. Failing here would mean every first deploy with FORWARD_TO set dies at
// the last resource, having already built everything that matters.
const forwardVerified = forwardAddress ? await isVerified(forwardAddress.addressId) : false;

if (forwardAddress && forwardVerified) {
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
    forwardVerified,
    dnsRecordCount:
      (managedDns?.records.length ?? 0) + (adoptedDns?.records.length ?? 0),
    mtaStsHostname: mtaStsWorker ? mtaStsHostname : undefined,
    vaultRead: readVault(config.stage),
  });
}

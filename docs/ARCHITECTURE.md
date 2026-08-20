# How Postbox works

Reference notes for anyone modifying or deploying this. For getting started, see the [README](../README.md).

## Shape of it

```
                        ┌──────────────────────────────┐
  inbound mail  ───────►│  Cloudflare Email Routing    │
  (anything@domain)     │  catch-all → Worker          │
                        └──────────────┬───────────────┘
                                       │ email()
  browser ──────────────►┌─────────────▼───────────────┐
                         │  Worker: postbox            │
                         │  · static assets (React UI) │
                         │  · Hono JSON API (/api/*)   │
                         │  · email() handler          │
                         │  · scheduled() cron         │
                         └──────┬───────────────┬──────┘
                                │               │
                          ┌─────▼─────┐   ┌─────▼──────┐
                          │  D1       │   │  KV        │
                          │  mail     │   │  sessions  │
                          └───────────┘   └────────────┘
                                │
                          ┌─────▼──────┐
   outbound mail ◄────────│  Resend    │
                          └────────────┘
```

One Worker with three entry points: `fetch` serves the UI and the API, `email` receives, `scheduled` ticks once a minute for send-later and snooze. They share a database binding and the same threading code, so a message looks identical however it arrived.

## Why Workers and not Pages

Pages Functions cannot register an `email()` handler; email triggers are Workers-only. Serving the UI from Workers static assets keeps everything in one deployable, and static asset requests are free and unmetered exactly as they are on Pages. This is also the model Cloudflare now recommends for new projects.

## Sending providers

Cloudflare's own Email Sending is the natural fit, but its pricing is explicit: sending to arbitrary recipients requires the Workers Paid plan. Inbound routing is free and unlimited; outbound is not available at all on the free plan. So Resend is the default, and Cloudflare is one environment variable away.

```
MAIL_PROVIDER=resend      # default, free
MAIL_PROVIDER=cloudflare  # no third party, requires Workers Paid
```

Everything provider-shaped lives behind one interface in `src/worker/lib/mail/`:

```
mail/
  types.ts       MailProvider, SendRequest, ProviderLimits, SendError
  index.ts       picks the provider, enforces quota, exposes send()
  resend.ts      REST call + Resend's error vocabulary
  cloudflare.ts  send_email binding + Cloudflare's error vocabulary
  render.ts      Markdown → mail-safe HTML (shared)
  quota.ts       KV counters (shared)
```

A provider declares its own limits, so the UI reports the truth without knowing which one is active. Resend caps at 100/day and 3,000/month and refuses beyond that; Cloudflare publishes no fixed daily number (it scales with account reputation) and bills past 3,000/month rather than refusing. The sidebar switches between "Sends today" and "Sent this month" accordingly.

`alchemy.run.ts` branches too. On Resend it provisions the domain, DNS records, verification and a scoped key. On Cloudflare it provisions none of that and binds `EmailSender()` to the Worker instead, so the Worker holds no sending credential at all. `RESEND_API_KEY` stops being a required variable, which leaves `DOMAIN` and `CLOUDFLARE_API_TOKEN` as the only two.

Cloudflare requires the domain to be onboarded once before the first send:

```bash
npx wrangler email sending enable yourdomain.com
```

There is no public REST endpoint for this, so it stays a one-time manual step rather than something `just up` pretends to handle. If you forget, the first send fails with that exact command in the error message.

Switching providers in either direction leaves your stored mail untouched.

Inbound is unaffected by any of this. Email Routing owns the apex MX records; Resend publishes under `send.<domain>` and `resend._domainkey.<domain>`. Different names, no collision.

## Adding another provider

Implement `MailProvider` and register it in `mail/index.ts`. That is one file, one method, and a `limits` block. The quota accounting, the Markdown rendering, the draft-preserved-on-failure behaviour and the UI all come for free.

## Authentication, and why not Cloudflare Access

The app is gated by a single password. Sessions are stateless HMAC tokens, so rotating `AUTH_SECRET` revokes every session, and failed sign-ins are rate-limited per IP.

Cloudflare Access would be better in several ways — real SSO, MFA from your identity provider, per-user policies, audit logs, and bot traffic rejected at the edge before it reaches the Worker. It is not the default here for one reason: Cloudflare's Zero Trust onboarding asks for a payment method even when you pick the free plan, and "no credit card" is a promise this project makes on its front page.

### Putting Cloudflare Access in front

If you already run Zero Trust, adding it is worthwhile. Three steps, and the third is the one people miss:

1. **Zero Trust → Access → Applications → Add self-hosted**, with the domain set to your `mail.yourdomain.com`.
2. Add an **Allow** policy — usually `Emails` → your address, or `Emails ending in` → your domain.
3. **Make sure there is no second door.** Access protects a hostname, not a Worker. If the Worker is also published on `*.workers.dev`, that URL bypasses Access completely. Postbox ships with `WORKERS_DEV_URL=false` by default precisely so this hole does not exist; leave it off.

The password layer stays underneath and does no harm. For belt-and-braces you can also verify the `Cf-Access-Jwt-Assertion` header in `src/worker/index.ts` against your team's public keys at `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, checking that the token's `aud` matches your application's AUD tag. With step 3 done, that is defence in depth rather than a requirement.

## Layout

```
alchemy.run.ts          all infrastructure, one file
infra/
  config.ts             env resolution: required vs derived
  vault.ts              machine-local secret store
  resend.ts             Resend domain + scoped key, as Alchemy resources
  names.ts              derived resource names, shared with the justfile
  report.ts             the post-deploy summary
  doctor.ts             pre-flight checks
migrations/             D1 schema, applied automatically on deploy
src/
  shared/types.ts       the contract between Worker and UI
  worker/
    index.ts            fetch / email / scheduled
    lib/                auth, threading, inbound parsing, cron
    lib/mail/           sending providers behind one interface
    routes/             auth · mail · compose · workspace
  ui/
    components/ui/      shadcn primitives
    components/mail/    the client
```

## Configuration

Three variables cannot be derived, because each is either a human decision or an authorisation:

| Variable | Why |
|---|---|
| `DOMAIN` | Which domain this mailbox is for. |
| `CLOUDFLARE_API_TOKEN` | Authorisation. `just login` stores a profile instead. |
| `RESEND_API_KEY` | Authorisation. Resend has no API for creating an account. Not needed when `MAIL_PROVIDER=cloudflare`. |

Everything else is worked out at deploy time: the account ID from the token, the zone ID from the domain, the hostname as `mail.$DOMAIN`, the default identity as `hello@$DOMAIN`, the Resend domain and its DNS records, a send-only Resend key, the session signing secret, the UI password, and every resource name.

`infra/names.ts` prints the derived names as shell exports, and the justfile evals it. There is one definition of "what is this stage's database called", and the CLI cannot drift from the deploy.

## Credential handling

The full-access Resend key is used exactly twice on first deploy: to register the domain, and to mint a `sending_access` key pinned to that domain. The Worker runs on the second key. The full-access key never reaches production.

Generated secrets cache in `.secrets/postbox.<stage>.json`:

- directory is `0700`, dot-prefixed, git-ignored
- the file is written `0600` then set to `0400`, so a stray redirect bounces off a read-only file
- writes unlock, write, and re-lock

The cache is what makes redeploys idempotent. Without it, `just up` twice would mint two Resend keys and roll the session secret, signing you out. Resend reveals a key's token only at creation, so deleting the vault orphans the old key in your Resend dashboard and mints a replacement.

## Data model

A **message** lives in exactly one folder. A **thread** has no folder of its own; it appears in a folder when it contains at least one message there. That is why archiving a conversation removes it from Inbox but leaves your reply in Sent.

Thread summaries are materialised into a `threads` table and rewritten in the same D1 batch as the messages they summarise, so the list view is one indexed read rather than a `GROUP BY` over the whole mailbox.

Threading uses `In-Reply-To` and `References` first, since those are authoritative, and falls back to normalised-subject matching within 30 days for clients that drop them.

Search is a standalone FTS5 table written by the Worker in the same batch as the message. Drafts are indexed too.

## Limits and deliberate trade-offs

- **Sending**: whatever the active provider allows — 100/day and 3,000/month on Resend's free tier, reputation-scaled daily and 3,000/month included on Cloudflare. The sidebar shows the current position; a send that would exceed a hard cap fails with an explanation and keeps the draft.
- **Attachments**: 8 MB total per outgoing message. Inbound attachments are stored in D1 up to 4 MB each and 12 MB per message. Above that the message and its metadata are kept but the bytes are dropped, because the Workers Free plan's CPU budget cannot reliably base64 a 25 MB message. Losing an attachment beats losing the email.
- **Undo send** is client-side. Closing the tab during the window flushes the send via `sendBeacon` rather than cancelling it.
- **Send later** is minute-granular, the finest a Cloudflare cron offers.
- **Spam** filtering is conservative: only mail that actively fails SPF, DKIM *and* DMARC is quarantined, since Cloudflare already rejects unauthenticated mail upstream.

## Security

- One password gates the whole app. Sessions are stateless HMAC tokens, so rotating `AUTH_SECRET` revokes every session. Failed sign-ins are rate-limited per IP.
- The `*.workers.dev` hostname is off by default, so the app is reachable only on your own domain. See [Putting Cloudflare Access in front](#putting-cloudflare-access-in-front).
- Received HTML is sanitised client-side (scripts, handlers, styles, unknown URL schemes removed) and links are forced to `target="_blank" rel="noopener"`.
- Stored attachments are served with `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`.

## A note on Alchemy's version

This pins `alchemy@0.94.0` rather than tracking `latest`. Alchemy's `latest` tag currently points at the `2.0.0-beta` line, a rewrite on top of [Effect](https://effect.website) in which infrastructure *and* the Worker's handlers are Effect generators. That is a different programming model for the whole application, still in beta.

The 0.94 line is the stable async/await API: resources are awaited function calls and `src/worker/index.ts` is an ordinary Worker module. `alchemy.run.ts` type-checks against Alchemy's real published types as part of `just check`, so a version bump surfaces as a type error rather than a failed deploy.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `"<domain>" is not a zone in Cloudflare account …` | Add the domain in Cloudflare and point its nameservers there. If the zone exists, the token is missing **Zone → Zone → Read**. |
| Sends fail with "domain is not verified" | DNS is still propagating. `just verify`. |
| `Resend rejected the API key` at deploy | `RESEND_API_KEY` must be **Full access**, not sending-only. |
| Forwarding copy never arrives | Cloudflare emailed `FORWARD_TO` a confirmation link; click it. Mail inside Postbox works regardless. |
| Lost the UI password | `just secrets` |

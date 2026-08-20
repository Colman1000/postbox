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

## Why Resend for sending

Cloudflare's own Email Sending is the natural fit, and the code was written against it first, but its pricing is explicit: sending to arbitrary recipients requires the Workers Paid plan. Inbound routing is free and unlimited; outbound is not available at all on the free plan.

The two coexist rather than conflict. Email Routing owns the apex MX records for receiving; Resend publishes under `send.<domain>` and `resend._domainkey.<domain>`. Different names, no collision.

To move to Cloudflare sending on a paid plan, replace `src/worker/lib/outbound.ts` with the `send_email` binding. Nothing else changes.

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
    lib/                auth, threading, inbound parsing, Resend, cron
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
| `RESEND_API_KEY` | Authorisation. Resend has no API for creating an account. |

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

- **Sending**: 100/day, 3,000/month on Resend's free tier. The sidebar shows the current position; a send that would exceed it fails with an explanation and keeps the draft.
- **Attachments**: 8 MB total per outgoing message. Inbound attachments are stored in D1 up to 4 MB each and 12 MB per message. Above that the message and its metadata are kept but the bytes are dropped, because the Workers Free plan's CPU budget cannot reliably base64 a 25 MB message. Losing an attachment beats losing the email.
- **Undo send** is client-side. Closing the tab during the window flushes the send via `sendBeacon` rather than cancelling it.
- **Send later** is minute-granular, the finest a Cloudflare cron offers.
- **Spam** filtering is conservative: only mail that actively fails SPF, DKIM *and* DMARC is quarantined, since Cloudflare already rejects unauthenticated mail upstream.

## Security

- One password gates the whole app. Sessions are stateless HMAC tokens, so rotating `AUTH_SECRET` revokes every session. Failed sign-ins are rate-limited per IP.
- Cloudflare Access can sit in front of the hostname for SSO; this layer stays harmless underneath it.
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

# Deliverability

Why self-hosted mail lands in spam, what Postbox does about it, and what only
time can fix.

## The thing nobody tells you first

When you buy a mailbox with a domain — Google Workspace, Zoho, Fastmail — the
thing you are really buying is somebody else's twenty-year-old sending
reputation. Your mail leaves on IPs that have carried human correspondence
continuously since before spam filtering was machine-learned. Those IPs have
feedback loops with every major receiver, postmaster relationships, per-tenant
abuse enforcement and per-user warmup. For a domain with no history of its own,
that IP reputation is the dominant signal, and it carries your new domain on
its back.

Postbox gives you the records. It cannot give you the reputation.

Your mail leaves on a shared transactional pool — shared with password resets,
receipts, and a long tail of new free-tier accounts, some of which are sending
things receivers dislike. Layer on the profile a receiver actually sees: a
recently registered domain, no sending history, a handful of messages a day, no
replies yet, arriving from a bulk pool. That is also, precisely, the shape of a
disposable phishing domain. The filter is not being unreasonable.

Two more asymmetries worth naming, because they are invisible and they matter:

- **Class of mail.** A mailbox provider's mail arrives by authenticated SMTP
  submission. Yours arrives from a transactional API. Receivers distinguish
  these, and one-to-one correspondence emerging from a bulk sending pool is
  anomalous.
- **Engagement history.** Gmail-to-Gmail is close to filter-free. Recipients
  reply, add the sender to contacts, and that history accrues to the account.
  A new setup starts at zero in both directions.

None of that is a bug, and no header fixes it. It is the structural cost of
running your own send path. What follows is everything that *can* be fixed.

## What Postbox does for you

Run `just mailcheck` at any time to see all of this against live DNS.

### Authentication

| Record | What it is | Set up by |
| --- | --- | --- |
| `MX` | Inbound mail to Cloudflare Email Routing | `just up` |
| `SPF` (apex) | Which hosts may send as you | `just up` |
| `DKIM` | The signing key for your provider | `just up` |
| `SPF` (`send.`) | The Return-Path subdomain, so SPF aligns | `just up` |
| `DMARC` | Your published policy, plus where to report | `DMARC_POLICY`, `DMARC_RUA` |
| `TLS-RPT` | Reports on TLS delivery to your MX | `TLS_RPT` |
| `MTA-STS` | Senders must use authenticated TLS to reach you | `MTA_STS` |

`just mailcheck` checks each one the way a receiver would, and catches the
failures that are invisible from a dashboard:

- **More than one SPF record.** The spec allows exactly one. Two is a permanent
  error, and most receivers score it as an outright SPF failure. This is the
  single most common self-inflicted authentication wound, and nothing warns you.
- **SPF over ten DNS lookups.** Also `permerror`, also silent. Each individual
  record looks fine; only the total is wrong.
- **Strict DMARC alignment.** The sending provider bounces from a subdomain, so
  `adkim=s`/`aspf=s` fails every message.
- **An unauthorised `rua` destination.** Reports to another domain are dropped
  unless that domain publishes `yourdomain._report._dmarc.theirdomain`. This is
  the usual reason a correct-looking DMARC record produces no reports at all.
- **An MTA-STS policy that does not match your live MX**, which in `enforce`
  mode rejects real mail.

### Message shape

Two things about how a message is built are worth knowing, because both were
working against delivery before and both are now fixed:

**The HTML is a bare fragment, not a document.** Mail wrapped in a full
`<html>` document with a centred fixed-width container, a page background and a
boxed-off footer is *campaign* markup — it is what marketing tools emit and
what no personal mail client emits. Filters read that structure, and a
one-to-one message wearing a newsletter's clothes gets scored as one. Postbox
now emits what Gmail and Apple Mail put on the wire: one wrapper `div` carrying
the font, and inline styling only where a block would otherwise be unreadable.

**The plain-text part is real prose.** Every message is `multipart/alternative`,
and the two parts are supposed to say the same thing. Shipping raw Markdown as
the text part meant they did not — the HTML said *emphasis* where the text said
`**emphasis**`. A visibly machine-generated text part beside a rendered HTML
part is the shape of a template rather than of a person typing. Markdown is now
rendered to genuine plain text: emphasis dropped, links written as
`label <https://url>`, lists and quotes in the conventions that predate HTML
mail, wrapped at 76 columns.

The `Message-ID` is also now set by Postbox rather than left to the provider,
so replies to your mail thread correctly instead of arriving as new
conversations. Threading is not a spam signal by itself, but replies are the
strongest positive signal a young domain can earn, and a thread that breaks is
a reply that does not happen.

### The pre-send check

The composer checks each draft as you write and says what a receiving filter is
likely to notice. It never blocks a send. It covers, among others: shouting or
money-shaped subject lines, empty subjects, link shorteners, links whose text
points somewhere other than their target, bare-IP links, image-only bodies,
attachment types gateways strip, oversized recipient lists, and sending from a
no-reply address.

A clean result is not a promise of an inbox. It only means the message is not
making things worse.

## Choosing a DMARC policy

DMARC has two independent halves, and it is worth being clear which one you are
turning on.

**`rua` is the reporting half.** Without it a DMARC record is write-only: you
publish an instruction and never learn who is sending as your domain, or which
of your own senders are failing. Turn this on first and leave it on forever. It
is free, it changes nothing about delivery, and it is the only thing that makes
the next decision an informed one. Postbox defaults it to `dmarc@yourdomain`,
which needs no setup because the catch-all already delivers there.

**`p=` is the enforcement half.** `none` means receivers take no action on
failures — spoofed mail claiming to be you still lands in inboxes. `quarantine`
sends failures to spam. `reject` bounces them at SMTP.

Quarantine is the right first rung because its failure mode is recoverable: if
you misjudged and a legitimate sender is unaligned, that mail goes to spam and
someone finds it. Under `reject` it is gone with a bounce the recipient may
never mention. There is a deliverability side too — several receivers treat an
enforced policy as a positive reputation signal, and BIMI will not consider a
domain at `p=none` at all.

The order that matters:

1. Deploy with `DMARC_RUA` on and `DMARC_POLICY=none`. Wait two weeks.
2. Read the reports. Confirm every legitimate sender — Postbox, and anything
   else sending as your domain — is passing SPF or DKIM with alignment.
3. Set `DMARC_POLICY=quarantine` and re-run `just up`. Optionally stage it with
   `DMARC_PCT=25` for a week first.
4. Only after quarantine has been quiet for a month, consider `reject`.

Doing steps 1 and 3 in one deploy is the risky version: you would start
quarantining before knowing whether anything of yours fails.

## Warming up

A new domain sending at full volume on day one is the most reliable way to get
filtered. The ramp that works:

| Week | Volume per day | What to aim for |
| --- | --- | --- |
| 1 | 5–10 | People who will actually reply |
| 2 | 10–20 | Keep the reply rate high |
| 3–4 | 20–40 | Vary recipients across providers |
| 5–8 | 50–100 | Normal use |

Four to eight weeks is realistic for a new domain on a shared pool. Sudden
volume spikes are a leading cause of spam placement, so a steady low number
beats an erratic higher one.

The things that actually move the needle, in order:

1. **Replies.** The single strongest positive signal there is. Low volume with
   high reply rates beats every technical tweak in this document.
2. **"Not spam" and adding you to contacts.** Fixes the individual relationship
   immediately and contributes to the domain's aggregate reputation.
3. **Consistency.** Same domain, same addresses, similar daily volume.
4. **Not sending to dead addresses.** Bounces to invalid recipients are scored
   against you. Type carefully; do not import a list.

## Watching the numbers

Two sources will tell you what receivers actually think, and both need to be
turned on before they have anything to say:

- **Google Postmaster Tools** — the only place Gmail reports your spam-complaint
  rate, domain reputation and authentication pass rates. Set `SITE_VERIFICATION`
  in `.env` to claim the domain. Gmail's threshold is a 0.30% complaint rate;
  the number to actually stay under is 0.10%.
- **DMARC aggregate reports** — who is sending as you, and whether it passes.
  On by default; point `DMARC_RUA` at a free analyser if you would rather read
  a summary than XML.

Microsoft publishes its own requirements for high-volume senders (SPF, DKIM and
DMARC, enforced since May 2025, with non-compliant mail rejected outright rather
than junked). Below 5,000 messages a day to consumer Outlook you are not in
scope, but the same records are what gets you through their filters anyway.

## What is deliberately not here

- **`List-Unsubscribe`.** Required for bulk senders, actively harmful for
  personal mail: it declares the message part of a list. Postbox sends one-to-one
  correspondence and does not add it.
- **Open and click tracking.** Tracking pixels and rewritten links are a
  meaningful negative signal for personal mail, and Postbox does not do either
  in the mail it sends — the same way it blocks them in the mail it receives.
- **A dedicated IP.** Worse, not better, below a few thousand messages a month:
  an unwarmed dedicated IP is more suspect than a mediocre shared pool.
- **BIMI.** Needs `p=quarantine` or stronger plus a Verified Mark Certificate,
  which is a commercial product costing more per year than this entire stack.
  Worth revisiting only if the logo in the recipient's client matters to you.

## If mail is landing in spam right now

1. Run `just mailcheck`. Fix every `✗` before assuming it is reputation.
2. Check whether it is *all* receivers or one. One provider filtering while
   others do not is usually reputation; everyone filtering at once is usually a
   record.
3. Look at a delivered copy's headers for the receiver's own verdict —
   `Authentication-Results` says exactly which of SPF, DKIM and DMARC passed.
4. Ask one recipient to mark it "not spam" and reply. Then send them another.
5. If authentication is clean and it is still filtered, it is reputation, and
   the answer is time, volume discipline and replies. There is no record you
   can add that substitutes for those.

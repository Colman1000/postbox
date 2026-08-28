/**
 * `just mailcheck` — everything a receiving mail server can find out about
 * this domain, and what it will conclude.
 *
 * Deployment problems announce themselves. Deliverability problems do not:
 * mail is accepted, the API returns 200, and the message quietly lands in a
 * spam folder you cannot see. The only way to catch that is to go and look at
 * the same records the receiver looks at, which is all this does.
 *
 * Nothing here needs a credential — it is public DNS and one HTTPS fetch — so
 * it runs against any domain, at any time, including one you have not deployed
 * to yet.
 */
import { loadDotEnv, resolveConfig, type PostboxConfig } from "./config.ts";

export type Status = "ok" | "warn" | "bad" | "info";

export interface Check {
  status: Status;
  text: string;
  /** What to do. Empty when there is nothing to do. */
  hints: string[];
}

const DOH = "https://cloudflare-dns.com/dns-query";

/** One DNS answer set, already unquoted and joined the way a resolver joins it. */
async function lookup(name: string, type: "TXT" | "MX" | "CNAME" | "A"): Promise<string[]> {
  const response = await fetch(
    `${DOH}?name=${encodeURIComponent(name)}&type=${type}`,
    { headers: { accept: "application/dns-json" } },
  ).catch(() => null);
  if (!response?.ok) return [];

  const body = (await response.json().catch(() => null)) as {
    Answer?: Array<{ type?: number; data?: string }>;
  } | null;

  return (body?.Answer ?? [])
    .map((answer) => (answer.data ?? "").trim())
    // A long TXT record arrives as several quoted strings that are meant to be
    // concatenated with nothing between them. Splitting on the quotes and
    // rejoining is the only way to read a DKIM key back correctly.
    .map((data) =>
      data.startsWith('"') ? data.split('" "').map((p) => p.replace(/"/g, "")).join("") : data,
    )
    .filter(Boolean);
}

/** DMARC and SPF are both `key=value; key=value` — this reads either. */
function tags(record: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of record.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key && rest.length > 0) out[key.trim().toLowerCase()] = rest.join("=").trim();
  }
  return out;
}

/**
 * SPF allows ten DNS-querying mechanisms per evaluation, total, including
 * everything reached through an `include`. Past ten the result is `permerror`,
 * which most receivers treat as a failure — and it is invisible until you
 * count, because each individual record looks fine.
 */
async function countSpfLookups(record: string, depth = 0, seen = new Set<string>()): Promise<number> {
  if (depth > 5) return 0;
  let count = 0;

  for (const term of record.split(/\s+/)) {
    const mechanism = term.replace(/^[+\-~?]/, "");
    if (/^(a|mx|ptr)([:/]|$)/i.test(mechanism)) count += 1;
    else if (/^exists:/i.test(mechanism)) count += 1;
    else if (/^(include|redirect)[:=]/i.test(mechanism)) {
      count += 1;
      const target = mechanism.split(/[:=]/).slice(1).join(":");
      if (!target || seen.has(target)) continue;
      seen.add(target);
      const nested = (await lookup(target, "TXT")).find((r) => /^v=spf1\b/i.test(r));
      if (nested) count += await countSpfLookups(nested, depth + 1, seen);
    }
  }

  return count;
}

export async function runChecks(config: PostboxConfig): Promise<Check[]> {
  const checks: Check[] = [];
  const domain = config.domain;
  const push = (status: Status, text: string, ...hints: string[]) =>
    checks.push({ status, text, hints });

  // ── receiving ─────────────────────────────────────────────────────────────
  const mx = await lookup(domain, "MX");
  const mxHosts = mx.map((r) => r.split(/\s+/).pop()?.replace(/\.$/, "").toLowerCase() ?? "");
  const cloudflareMx = mxHosts.filter((h) => h.endsWith(".mx.cloudflare.net"));

  if (cloudflareMx.length >= 3) {
    push("ok", `MX points at Cloudflare Email Routing (${cloudflareMx.length} hosts)`);
  } else if (mxHosts.length > 0) {
    push(
      "warn",
      `MX points somewhere other than Cloudflare Email Routing: ${mxHosts.join(", ")}`,
      "Inbound mail is not reaching Postbox. `just up` sets these; a stale record from a",
      "previous mail host will silently keep winning until it is removed.",
    );
  } else {
    push("bad", `${domain} has no MX records — it cannot receive mail at all`, "Run `just up`.");
  }

  // ── SPF ───────────────────────────────────────────────────────────────────
  const apexTxt = await lookup(domain, "TXT");
  const spfRecords = apexTxt.filter((r) => /^v=spf1\b/i.test(r));

  if (spfRecords.length === 0) {
    push(
      "bad",
      `No SPF record on ${domain}`,
      "Receivers have no list of who may send as you. `just up` publishes one via Email Routing.",
    );
  } else if (spfRecords.length > 1) {
    push(
      "bad",
      `${spfRecords.length} SPF records on ${domain} — the spec allows exactly one`,
      "More than one is a permanent error, and most receivers score it as an outright SPF failure.",
      "Merge them into a single record: keep one `v=spf1`, move every `include:` into it.",
      ...spfRecords.map((r) => `  ${r}`),
    );
  } else {
    const spf = spfRecords[0]!;
    const lookups = await countSpfLookups(spf);
    const all = /[~\-+?]all\b/.exec(spf)?.[0] ?? "";

    if (lookups > 10) {
      push(
        "bad",
        `SPF needs ${lookups} DNS lookups — the limit is 10`,
        "Over the limit the result is `permerror`, which receivers treat as a failure.",
        "Remove includes you no longer send from, or flatten them to IP ranges.",
      );
    } else if (lookups > 8) {
      push("warn", `SPF uses ${lookups} of its 10 permitted DNS lookups`, "Adding one more sender will break it.");
    } else {
      push("ok", `SPF published and within limits (${lookups}/10 lookups)`);
    }

    if (all === "+all") {
      push("bad", "SPF ends in `+all`, which authorises the entire internet to send as you", "Change it to `~all`.");
    } else if (!all) {
      push("warn", "SPF has no `all` mechanism, so it neither passes nor fails cleanly", "End the record with `~all`.");
    }
  }

  // ── DKIM ──────────────────────────────────────────────────────────────────
  // Every provider signs with its own selector, so the presence of a key is
  // the only thing worth asserting — its contents are the provider's business.
  const selectors: Array<[string, string]> = [
    ["resend", "Resend sending"],
    ["cf-bounce", "Cloudflare Email Sending"],
    ["cf2024-1", "Cloudflare Email Routing"],
  ];
  const found: string[] = [];
  for (const [selector, label] of selectors) {
    const record = await lookup(`${selector}._domainkey.${domain}`, "TXT");
    const cname = record.length === 0 ? await lookup(`${selector}._domainkey.${domain}`, "CNAME") : [];
    if (record.some((r) => /p=/i.test(r)) || cname.length > 0) found.push(label);
  }

  const expected = config.mailProvider === "resend" ? "Resend sending" : "Cloudflare Email Sending";
  if (found.includes(expected)) {
    push("ok", `DKIM key published for ${expected}${found.length > 1 ? ` (also: ${found.filter((f) => f !== expected).join(", ")})` : ""}`);
  } else if (found.length > 0) {
    push(
      "warn",
      `DKIM keys found for ${found.join(", ")}, but not for ${expected}`,
      "Mail sent through the configured provider will be unsigned, and DKIM is the half of",
      "authentication that survives forwarding. Run `just up`, then `just verify`.",
    );
  } else {
    push(
      "bad",
      `No DKIM key on ${domain}`,
      "Nothing you send is signed. Run `just up` to publish the provider's records, then `just verify`.",
    );
  }

  // The Return-Path lives on a subdomain, which is what makes relaxed
  // alignment necessary further down — worth confirming it actually exists.
  if (config.mailProvider === "resend") {
    const bounce = await lookup(`send.${domain}`, "TXT");
    if (bounce.some((r) => /^v=spf1\b/i.test(r))) {
      push("ok", `Return-Path subdomain send.${domain} is authorised`);
    } else {
      push(
        "warn",
        `No SPF record on send.${domain} — Resend's Return-Path domain`,
        "SPF will not align, leaving DKIM as the only thing holding DMARC up. Run `just up`.",
      );
    }
  }

  // ── DMARC ─────────────────────────────────────────────────────────────────
  const dmarcRecords = (await lookup(`_dmarc.${domain}`, "TXT")).filter((r) =>
    /^v=dmarc1\b/i.test(r),
  );

  if (dmarcRecords.length === 0) {
    push(
      "bad",
      `No DMARC record on ${domain}`,
      "Gmail, Yahoo and Outlook all expect one, and a domain without a published policy is",
      "treated as a domain nobody is minding. `just up` publishes one.",
    );
  } else {
    const dmarc = tags(dmarcRecords[0]!);
    const policy = (dmarc.p ?? "none").toLowerCase();

    if (policy === "none") {
      push(
        "warn",
        "DMARC is published but enforces nothing (p=none)",
        "Nothing claiming to be your domain is ever rejected or quarantined, and enforcement",
        "is itself a positive reputation signal. Once reports show your own mail passing,",
        "set DMARC_POLICY=quarantine in .env and re-run `just up`.",
      );
    } else {
      push("ok", `DMARC enforcing (p=${policy}${dmarc.pct ? `, pct=${dmarc.pct}` : ""})`);
    }

    if (!dmarc.rua) {
      push(
        "warn",
        "DMARC publishes no `rua`, so no receiver ever reports back",
        "You cannot see who is sending as your domain, or which of your own senders fail.",
        "Set DMARC_RUA in .env (it defaults to dmarc@" + domain + ") and re-run `just up`.",
      );
    } else {
      push("ok", `DMARC aggregate reports go to ${dmarc.rua.replace(/mailto:/g, "")}`);

      // Reports to another domain are silently dropped unless that domain has
      // published a record agreeing to receive them. It is the single most
      // common reason a correct-looking DMARC record produces no reports.
      for (const uri of dmarc.rua.split(",").map((u) => u.trim())) {
        const host = uri.replace(/^mailto:/i, "").split("@")[1]?.toLowerCase();
        if (!host || host === domain || host.endsWith(`.${domain}`)) continue;
        const authorised = await lookup(`${domain}._report._dmarc.${host}`, "TXT");
        if (authorised.some((r) => /^v=dmarc1\b/i.test(r))) {
          push("ok", `${host} is authorised to receive reports for ${domain}`);
        } else {
          push(
            "bad",
            `${host} has not authorised report delivery for ${domain}`,
            `Receivers will send nothing. ${host} must publish a TXT record at`,
            `  ${domain}._report._dmarc.${host}   with the value   v=DMARC1`,
            "Most report services do this for you once you add the domain in their dashboard.",
          );
        }
      }
    }

    if ((dmarc.adkim ?? "r").toLowerCase() === "s" || (dmarc.aspf ?? "r").toLowerCase() === "s") {
      push(
        "warn",
        "DMARC requires strict alignment (adkim=s or aspf=s)",
        "The sending provider signs and bounces from a subdomain, so strict alignment fails",
        "every message. Use relaxed alignment unless you know why you need strict.",
      );
    }
  }

  // ── transport security ────────────────────────────────────────────────────
  const tlsRpt = (await lookup(`_smtp._tls.${domain}`, "TXT")).filter((r) =>
    /^v=tlsrptv1\b/i.test(r),
  );
  push(
    tlsRpt.length > 0 ? "ok" : "info",
    tlsRpt.length > 0
      ? `TLS reporting on → ${tags(tlsRpt[0]!).rua?.replace(/mailto:/g, "") ?? "configured"}`
      : "No TLS reporting (_smtp._tls) — you will not hear about failed TLS delivery to your MX",
    ...(tlsRpt.length > 0 ? [] : ["One TXT record, nothing it can break. `just up` publishes it."]),
  );

  const stsTxt = (await lookup(`_mta-sts.${domain}`, "TXT")).filter((r) => /^v=stsv1\b/i.test(r));
  if (stsTxt.length === 0) {
    push(
      "info",
      "No MTA-STS policy — senders may be downgraded to unencrypted delivery",
      "Set MTA_STS=testing in .env to publish one without ever refusing a delivery.",
    );
  } else {
    const id = tags(stsTxt[0]!).id;
    const policyUrl = `https://mta-sts.${domain}/.well-known/mta-sts.txt`;
    const response = await fetch(policyUrl).catch((error: unknown) => ({
      ok: false as const,
      status: 0,
      reason: error instanceof Error ? error.message : String(error),
    }));
    const policy = response.ok && "text" in response ? await response.text() : null;

    if (!policy) {
      const why =
        response.status === 0
          ? `it is unreachable (${"reason" in response ? response.reason : "no response"})`
          : `it answered HTTP ${response.status}`;
      push(
        "bad",
        `MTA-STS is advertised (id=${id}) but ${policyUrl} serves no policy — ${why}`,
        "A sender that has cached the DNS record and cannot then fetch the policy may defer",
        "your mail. Either re-run `just up`, or set MTA_STS=off to withdraw the record.",
      );
    } else {
      const mode = /^mode:\s*(\w+)/m.exec(policy)?.[1] ?? "unknown";
      const policyMx = [...policy.matchAll(/^mx:\s*(\S+)/gm)].map((m) => m[1]!.toLowerCase());
      const covered = mxHosts.every((host) =>
        policyMx.some((pattern) =>
          pattern.startsWith("*.")
            ? host.endsWith(pattern.slice(1)) || host === pattern.slice(2)
            : host === pattern,
        ),
      );

      if (!covered) {
        push(
          "bad",
          `MTA-STS policy does not list every MX host (policy: ${policyMx.join(", ")}; live: ${mxHosts.join(", ")})`,
          mode === "enforce"
            ? "In enforce mode this REJECTS mail to the unlisted hosts. Set MTA_STS=testing until it matches."
            : "In testing mode nothing is lost, but the policy is wrong and cannot be promoted as it stands.",
        );
      } else if (mode === "enforce") {
        push("ok", "MTA-STS enforcing — inbound TLS cannot be downgraded");
      } else {
        push(
          "ok",
          `MTA-STS published in ${mode} mode`,
          "Nothing is refused while it is testing. Once TLS reports come back clean, set",
          "MTA_STS=enforce in .env and re-run `just up`.",
        );
      }
    }
  }

  return checks;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const paint = (code: string, text: string) =>
  process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text;

const BADGE: Record<Status, string> = {
  ok: paint("32", "✓"),
  warn: paint("33", "!"),
  bad: paint("31", "✗"),
  info: paint("90", "·"),
};

export function formatChecks(checks: Check[]): string[] {
  const lines: string[] = [];
  for (const check of checks) {
    lines.push(`  ${BADGE[check.status]} ${check.text}`);
    for (const hint of check.hints) lines.push(`      ${paint("2", hint)}`);
  }
  return lines;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadDotEnv();
  const config = resolveConfig();
  const checks = await runChecks(config);

  const bad = checks.filter((c) => c.status === "bad").length;
  const warn = checks.filter((c) => c.status === "warn").length;

  console.log(`\n  ${paint("1", `Deliverability — ${config.domain}`)}\n`);
  console.log(formatChecks(checks).join("\n"));
  console.log(
    "\n" +
      (bad > 0
        ? `  ${paint("31", `${bad} thing${bad === 1 ? "" : "s"} will actively hurt delivery.`)} Fix the ✗ lines above.`
        : warn > 0
          ? `  ${paint("33", `Authentication is sound; ${warn} improvement${warn === 1 ? "" : "s"} left.`)}`
          : `  ${paint("32", "Everything a receiver can check is in order.")}`) +
      "\n" +
      paint("2", "  What remains is reputation, and only time and replies build that.\n") +
      paint("2", "  See docs/DELIVERABILITY.md.\n"),
  );
  process.exit(bad > 0 ? 1 : 0);
}

/**
 * The thing you actually read after `just up`.
 *
 * A deploy that finishes but leaves you guessing at the URL, the password and
 * whether DNS landed is not finished. This prints all of it, plus the exact
 * next action whenever something still needs a human.
 */
import type { PostboxConfig } from "./config.ts";
import { updateVault, vaultPath, type VaultData } from "./vault.ts";

const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  gray: "\x1b[90m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

const supportsColor =
  process.stdout.isTTY && process.env.NO_COLOR === undefined;

const paint = (color: string, text: string) =>
  supportsColor ? `${color}${text}${c.reset}` : text;

export interface SummaryInput {
  config: PostboxConfig;
  provider: "resend" | "cloudflare";
  url: string;
  appHostname: string;
  password: string;
  passwordWasGenerated: boolean;
  sendingStatus: string;
  forwardTo?: string;
  forwardVerified: boolean;
  dnsRecordCount: number;
  vaultRead: VaultData;
  /** Hostname serving the MTA-STS policy, when MTA_STS is not "off". */
  mtaStsHostname?: string;
}

export async function printSummary(input: SummaryInput): Promise<void> {
  const { config } = input;
  const line = (label: string, value: string) =>
    `  ${paint(c.gray, label.padEnd(14))} ${value}`;

  const usingResend = input.provider === "resend";
  const sendingOk = input.sendingStatus === "verified";
  const sendingBadge = sendingOk
    ? paint(c.green, "verified")
    : input.sendingStatus === "failed"
      ? paint(c.red, "failed")
      : paint(c.yellow, `${input.sendingStatus} — DNS still propagating`);

  const out: string[] = [
    "",
    paint(c.bold, "  Postbox is live."),
    "",
    line("Mailbox", paint(c.cyan, `https://${input.appHostname}`)),
    ...(input.url && !input.url.includes(input.appHostname)
      ? [line("Also at", paint(c.dim, input.url))]
      : []),
    line("Stage", config.stage),
    "",
    paint(c.bold, "  Mail"),
    line("Receiving", `${paint(c.green, "on")} ${paint(c.dim, `— anything@${config.domain} lands in the app`)}`),
    line(
      "Sending",
      usingResend
        ? `${sendingBadge} ${paint(c.dim, `— via Resend, ${input.dnsRecordCount} DNS records written`)}`
        : `${paint(c.green, "on")} ${paint(c.dim, "— via Cloudflare Email Sending (Workers Paid)")}`,
    ),
    line("Send as", config.defaultFrom),
  ];

  if (input.forwardTo) {
    out.push(
      line(
        "Forwarding",
        input.forwardVerified
          ? `${paint(c.green, "verified")} ${paint(c.dim, `→ ${input.forwardTo}`)}`
          : `${paint(c.yellow, "awaiting confirmation")} ${paint(c.dim, `→ ${input.forwardTo}`)}`,
      ),
    );
  }

  // Deliverability is the difference between "it sent" and "they read it",
  // and it is the part that is invisible unless something says it out loud.
  out.push("", paint(c.bold, "  Deliverability"));
  out.push(
    line(
      "DMARC",
      config.dmarcPolicy === "none"
        ? `${paint(c.yellow, "p=none")} ${paint(c.dim, "— monitoring only; nothing is enforced yet")}`
        : `${paint(c.green, `p=${config.dmarcPolicy}`)}${
            config.dmarcPct !== undefined ? paint(c.dim, ` on ${config.dmarcPct}% of failures`) : ""
          }`,
    ),
    line(
      "Reports",
      config.dmarcRua
        ? `${paint(c.green, "on")} ${paint(c.dim, `→ ${config.dmarcRua.replace(/^mailto:/, "")}`)}`
        : `${paint(c.yellow, "off")} ${paint(c.dim, "— set DMARC_RUA to find out who is sending as you")}`,
    ),
  );
  if (config.tlsRptTo) {
    out.push(line("TLS reports", paint(c.dim, `→ ${config.tlsRptTo.replace(/^mailto:/, "")}`)));
  }
  if (input.mtaStsHostname) {
    out.push(
      line(
        "MTA-STS",
        `${config.mtaSts === "enforce" ? paint(c.green, "enforce") : paint(c.yellow, "testing")} ` +
          paint(c.dim, `— https://${input.mtaStsHostname}/.well-known/mta-sts.txt`),
      ),
    );
  }
  out.push(paint(c.dim, "  " + " ".repeat(14) + " just mailcheck  full DNS and authentication report"));

  out.push("", paint(c.bold, "  Sign in"));

  if (input.passwordWasGenerated) {
    out.push(
      line("Password", paint(c.bold, input.password)),
      "",
      paint(
        c.yellow,
        "  ↑ Shown once. It is also stored in " + vaultPath(config.stage) + ".",
      ),
    );
  } else {
    out.push(
      line("Password", paint(c.dim, `stored in ${vaultPath(config.stage)}`)),
    );
  }

  // The phone story, which is otherwise undiscoverable: nothing in the UI
  // says "install me", because the browser only offers that once you have
  // visited, and iOS never offers it at all.
  out.push(
    "",
    paint(c.bold, "  On your phone"),
    line(
      "Install",
      paint(c.dim, `open https://${input.appHostname} → Share → Add to Home Screen`),
    ),
    line("Notifications", paint(c.dim, "Settings → Alerts, from the installed app")),
  );

  // Anything that still needs a human, stated as an instruction.
  const todo: string[] = [];
  if (usingResend && !sendingOk) {
    todo.push(
      `Resend has not confirmed ${config.domain} yet. The records are already in\n` +
        "     Cloudflare DNS — this usually clears within a few minutes. Re-check with:\n" +
        paint(c.cyan, "       just verify"),
    );
  }
  if (input.forwardTo && !input.forwardVerified) {
    todo.push(
      `Cloudflare emailed ${input.forwardTo} a confirmation link. Click it to turn\n` +
        "     on the forwarding copy. Receiving inside Postbox already works.\n" +
        "     Then re-run to add the postmaster rule, which waits on the same click:\n" +
        paint(c.cyan, "       just up"),
    );
  }

  if (todo.length > 0) {
    out.push("", paint(c.bold, "  Still to do"));
    todo.forEach((item, i) => out.push(`  ${paint(c.yellow, `${i + 1}.`)} ${item}`));
  }

  out.push(
    "",
    paint(c.dim, "  just logs    stream worker logs"),
    paint(c.dim, "  just down    remove every resource this created"),
    "",
  );

  console.log(out.join("\n"));

  // The generated password is a one-time reveal; from here on the vault is the
  // only place it lives.
  if (input.passwordWasGenerated) {
    updateVault(config.stage, (v) => ({ ...v, appPasswordGenerated: false }));
  }
}

/**
 * Resolves the deployment configuration.
 *
 * Design rule for this project: if a value can be derived, it is derived.
 * Only three variables are genuinely un-derivable — the domain (a human
 * choice), the Cloudflare token (an authorisation) and the Resend key (an
 * authorisation for an account we cannot create via API).
 */
import fs from "node:fs";
import path from "node:path";

export type MailProvider = "resend" | "cloudflare";

export interface PostboxConfig {
  /** Apex domain / Cloudflare zone. */
  domain: string;
  /** Deployment stage — namespaces every resource. */
  stage: string;
  /** Hostname the UI is served on. */
  appHostname: string;
  /** Address Compose defaults to. */
  defaultFrom: string;
  /** Optional mailbox that also receives a copy of everything inbound. */
  forwardTo?: string;
  /** Which service sends outbound mail. */
  mailProvider: MailProvider;
  /** Resend sending region. Ignored unless mailProvider is "resend". */
  resendRegion: string;
  /** Full-access Resend key. Empty unless mailProvider is "resend". */
  resendApiKey: string;
  /**
   * Whether to also expose the Worker on its *.workers.dev hostname.
   * Off by default: a second public door to your mailbox that you did not
   * ask for is a liability, not a feature.
   */
  workersDevUrl: boolean;
  /**
   * DMARC policy to publish when the domain has none: "none", "quarantine" or
   * "reject". Postbox never replaces a policy that is already there.
   */
  dmarcPolicy: "none" | "quarantine" | "reject";
  /** Operator-supplied UI password, if any. */
  appPassword?: string;
  /** Explicit Cloudflare account, if the token spans several. */
  accountId?: string;
  /** Derived resource names. */
  names: {
    worker: string;
    database: string;
    kv: string;
  };
}

const RESEND_REGIONS = [
  "us-east-1",
  "eu-west-1",
  "sa-east-1",
  "ap-northeast-1",
] as const;

/** Minimal .env loader — no dependency, no surprises about precedence. */
export function loadDotEnv(file = ".env"): void {
  const full = path.resolve(process.cwd(), file);
  if (!fs.existsSync(full)) return;
  for (const rawLine of fs.readFileSync(full, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Real environment always wins over the file.
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
    }
  }
}

class ConfigError extends Error {
  constructor(problems: string[]) {
    super(
      [
        "",
        "Postbox is not configured yet.",
        "",
        ...problems.map((p) => `  ✗ ${p}`),
        "",
        "  Fix: cp .env.example .env   then fill in the values marked [REQUIRED].",
        "",
      ].join("\n"),
    );
    this.name = "ConfigError";
  }
}

const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function resolveConfig(): PostboxConfig {
  loadDotEnv();

  const problems: string[] = [];
  const env = (k: string): string | undefined => {
    const v = process.env[k];
    return v && v.trim() !== "" ? v.trim() : undefined;
  };

  const domain = env("DOMAIN")?.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!domain) {
    problems.push("DOMAIN is required — the domain you send and receive mail on.");
  } else if (!DOMAIN_RE.test(domain)) {
    problems.push(`DOMAIN "${domain}" is not a valid domain name.`);
  }

  // Alchemy also accepts an OAuth profile (`just login`), so a token in the
  // environment is one of two valid paths — we only complain if neither exists.
  const hasToken = !!env("CLOUDFLARE_API_TOKEN") || !!env("CLOUDFLARE_API_KEY");
  const hasProfile =
    !!env("CLOUDFLARE_PROFILE") ||
    !!env("ALCHEMY_PROFILE") ||
    fs.existsSync(
      path.join(process.env.HOME ?? "", ".alchemy", "profiles.json"),
    );
  if (!hasToken && !hasProfile) {
    problems.push(
      "CLOUDFLARE_API_TOKEN is required (or run `just login` once to store a profile).",
    );
  }

  const mailProvider = (env("MAIL_PROVIDER") ?? "resend").toLowerCase() as MailProvider;
  if (mailProvider !== "resend" && mailProvider !== "cloudflare") {
    problems.push(
      `MAIL_PROVIDER "${mailProvider}" must be either "resend" (free) or "cloudflare" (Workers Paid).`,
    );
  }

  // Only the Resend path needs a Resend key. On the Cloudflare path the whole
  // variable is irrelevant, so demanding it would be noise.
  const resendApiKey = env("RESEND_API_KEY");
  if (mailProvider === "resend") {
    if (!resendApiKey) {
      problems.push(
        "RESEND_API_KEY is required — a Full-access key from https://resend.com/api-keys.",
      );
    } else if (!resendApiKey.startsWith("re_")) {
      problems.push('RESEND_API_KEY looks wrong — Resend keys start with "re_".');
    }
  }

  const forwardTo = env("FORWARD_TO");
  if (forwardTo && !EMAIL_RE.test(forwardTo)) {
    problems.push(`FORWARD_TO "${forwardTo}" is not a valid email address.`);
  }

  const dmarcPolicy = (env("DMARC_POLICY") ?? "none").toLowerCase();
  if (!["none", "quarantine", "reject"].includes(dmarcPolicy)) {
    problems.push(
      `DMARC_POLICY "${dmarcPolicy}" must be one of: none, quarantine, reject.`,
    );
  }

  const resendRegion = env("RESEND_REGION") ?? "us-east-1";
  if (!RESEND_REGIONS.includes(resendRegion as (typeof RESEND_REGIONS)[number])) {
    problems.push(
      `RESEND_REGION "${resendRegion}" must be one of: ${RESEND_REGIONS.join(", ")}.`,
    );
  }

  if (problems.length > 0) throw new ConfigError(problems);

  const stage = (env("STAGE") ?? env("ALCHEMY_STAGE") ?? "prod")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");

  // Derived. A non-prod stage gets its own hostname so previews never collide.
  const appHostname =
    env("APP_HOSTNAME") ??
    (stage === "prod" ? `mail.${domain}` : `mail-${stage}.${domain}`);

  const defaultFrom = env("DEFAULT_FROM") ?? `hello@${domain}`;
  if (!EMAIL_RE.test(defaultFrom)) {
    throw new ConfigError([`DEFAULT_FROM "${defaultFrom}" is not a valid address.`]);
  }
  if (!defaultFrom.toLowerCase().endsWith(`@${domain}`)) {
    throw new ConfigError([
      `DEFAULT_FROM "${defaultFrom}" must be on DOMAIN (@${domain}) — ` +
        "Resend will only let you send from a domain you have verified.",
    ]);
  }

  const suffix = stage === "prod" ? "" : `-${stage}`;
  const slug = domain!.replace(/[^a-z0-9]/g, "-");

  return {
    domain: domain!,
    stage,
    appHostname,
    defaultFrom,
    forwardTo,
    mailProvider,
    resendRegion,
    resendApiKey: resendApiKey ?? "",
    dmarcPolicy: dmarcPolicy as PostboxConfig["dmarcPolicy"],
    workersDevUrl: (env("WORKERS_DEV_URL") ?? "false").toLowerCase() === "true",
    appPassword: env("APP_PASSWORD"),
    accountId: env("CLOUDFLARE_ACCOUNT_ID"),
    names: {
      worker: `postbox${suffix}`,
      database: `postbox-${slug}${suffix}`,
      kv: `postbox-cache-${slug}${suffix}`,
    },
  };
}

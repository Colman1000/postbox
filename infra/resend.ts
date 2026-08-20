/**
 * Resend provisioning, as Alchemy resources.
 *
 * Resend has no API for creating an *account*, so the operator must hand us
 * one full-access key. Everything downstream of that is automated:
 *
 *   1. `ResendDomain`     registers DOMAIN and tells us which DNS records it
 *                         wants. We hand those to Cloudflare DNS ourselves,
 *                         so there is no copy-paste step.
 *   2. `ResendSendingKey` mints a *narrow* key — send-only, pinned to that one
 *                         domain — which is the credential the Worker actually
 *                         runs with. The full-access key never reaches
 *                         production.
 *
 * Both resources are reversible: `just down` deletes the domain and revokes
 * the key it created.
 */
import { Resource, type Context } from "alchemy";
import { updateVault, readVault } from "./vault.ts";

const API = "https://api.resend.com";

// ── low-level client ────────────────────────────────────────────────────────

interface ResendError {
  statusCode?: number;
  name?: string;
  message?: string;
}

async function resend<T>(
  apiKey: string,
  method: "GET" | "POST" | "DELETE" | "PATCH",
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: T & ResendError }> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }
  return {
    ok: response.ok,
    status: response.status,
    data: data as T & ResendError,
  };
}

function fail(action: string, status: number, data: ResendError): never {
  const detail = data.message ?? data.name ?? "unknown error";
  if (status === 401 || status === 403) {
    throw new Error(
      `Resend rejected the API key while trying to ${action} (${status}: ${detail}).\n` +
        "  RESEND_API_KEY must be a **Full access** key — a sending-only key\n" +
        "  cannot register domains. Create one at https://resend.com/api-keys",
    );
  }
  throw new Error(`Failed to ${action} on Resend (${status}): ${detail}`);
}

// ── ResendDomain ────────────────────────────────────────────────────────────

/** A DNS record Resend needs, already normalised for the Cloudflare API. */
export interface ResendDnsRecord {
  /** What this record is for: SPF / DKIM / DMARC / Tracking. */
  purpose: string;
  type: "MX" | "TXT" | "CNAME";
  /** Fully-qualified record name. */
  name: string;
  /** Record value, unquoted and without a trailing dot. */
  content: string;
  priority?: number;
}

export interface ResendDomainProps {
  /** Apex domain to register. */
  name: string;
  /** Full-access Resend key. */
  apiKey: string;
  /** Sending region. */
  region: string;
  /** Stage, used for vault caching. */
  stage: string;
}

export interface ResendDomain {
  domainId: string;
  name: string;
  region: string;
  /** `not_started` | `pending` | `verified` | `failed` | `temporary_failure` */
  status: string;
  records: ResendDnsRecord[];
}

interface RawDomain {
  id: string;
  name: string;
  status: string;
  region: string;
  records?: Array<{
    record: string;
    type: string;
    name: string;
    value: string;
    ttl?: string;
    priority?: number;
    status?: string;
  }>;
}

/**
 * Resend returns record names relative to the zone ("send"), fully-qualified
 * ("links.example.com"), TXT values wrapped in literal quotes, and CNAME
 * values with a trailing dot. Cloudflare wants none of that.
 */
function normaliseRecords(raw: RawDomain, domain: string): ResendDnsRecord[] {
  return (raw.records ?? []).map((r) => {
    const bare = r.name.replace(/\.$/, "");
    const name =
      bare === domain || bare.endsWith(`.${domain}`) ? bare : `${bare}.${domain}`;
    let content = r.value.trim();
    if (content.startsWith('"') && content.endsWith('"')) {
      content = content.slice(1, -1);
    }
    if (r.type.toUpperCase() !== "TXT") content = content.replace(/\.$/, "");
    return {
      purpose: r.record,
      type: r.type.toUpperCase() as ResendDnsRecord["type"],
      name,
      content,
      priority: r.priority,
    };
  });
}

async function findDomainByName(apiKey: string, name: string) {
  const { ok, status, data } = await resend<{ data?: RawDomain[] }>(
    apiKey,
    "GET",
    "/domains",
  );
  if (!ok) fail("list domains", status, data);
  return (data.data ?? []).find(
    (d) => d.name.toLowerCase() === name.toLowerCase(),
  );
}

export const ResendDomain = Resource(
  "postbox::ResendDomain",
  async function (
    this: Context<ResendDomain>,
    _id: string,
    props: ResendDomainProps,
  ): Promise<ResendDomain> {
    if (this.phase === "delete") {
      const domainId = this.output?.domainId ?? readVault(props.stage).resendDomainId;
      if (domainId) {
        const { ok, status, data } = await resend(
          props.apiKey,
          "DELETE",
          `/domains/${domainId}`,
        );
        // 404 means someone already removed it in the dashboard — fine.
        if (!ok && status !== 404) fail("delete domain", status, data);
      }
      updateVault(props.stage, (v) => ({ ...v, resendDomainId: undefined }));
      return this.destroy();
    }

    // Adopt rather than duplicate: a domain can only be registered once per
    // Resend account, and the operator may have added it by hand already.
    let raw = await findDomainByName(props.apiKey, props.name);

    if (!raw) {
      const created = await resend<RawDomain>(props.apiKey, "POST", "/domains", {
        name: props.name,
        region: props.region,
      });
      if (!created.ok) fail(`register domain ${props.name}`, created.status, created.data);
      raw = created.data;
    } else {
      // Re-fetch by id so we always get the `records` array, which the list
      // endpoint omits.
      const fetched = await resend<RawDomain>(
        props.apiKey,
        "GET",
        `/domains/${raw.id}`,
      );
      if (fetched.ok) raw = fetched.data;
    }

    updateVault(props.stage, (v) => ({ ...v, resendDomainId: raw!.id }));

    return {
      domainId: raw.id,
      name: raw.name,
      region: raw.region ?? props.region,
      status: raw.status ?? "not_started",
      records: normaliseRecords(raw, props.name),
    };
  },
);

// ── ResendVerification ──────────────────────────────────────────────────────

export interface ResendVerificationProps {
  domainId: string;
  apiKey: string;
  /** Anything that, when changed, should re-trigger verification. */
  dependsOn?: unknown;
  /** Seconds to wait for Resend to see the records. */
  timeoutSeconds?: number;
}

export interface ResendVerification {
  domainId: string;
  status: string;
  verified: boolean;
}

/**
 * Asks Resend to re-check DNS, then polls until it flips to `verified`.
 *
 * Deliberately non-fatal: DNS can take a few minutes to be visible from
 * Resend's resolvers, and a slow DNS check should not fail an otherwise
 * good deploy. The post-deploy summary reports the real status either way.
 */
export const ResendVerification = Resource(
  "postbox::ResendVerification",
  async function (
    this: Context<ResendVerification>,
    _id: string,
    props: ResendVerificationProps,
  ): Promise<ResendVerification> {
    if (this.phase === "delete") return this.destroy();

    const timeout = (props.timeoutSeconds ?? 100) * 1000;
    const started = Date.now();

    await resend(props.apiKey, "POST", `/domains/${props.domainId}/verify`);

    let status = "pending";
    while (Date.now() - started < timeout) {
      const { ok, data } = await resend<RawDomain>(
        props.apiKey,
        "GET",
        `/domains/${props.domainId}`,
      );
      if (ok) {
        status = data.status ?? "pending";
        if (status === "verified") break;
        if (status === "failed") break;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }

    return {
      domainId: props.domainId,
      status,
      verified: status === "verified",
    };
  },
);

// ── ResendSendingKey ────────────────────────────────────────────────────────

export interface ResendSendingKeyProps {
  /** Full-access key used to mint the narrow one. */
  apiKey: string;
  /** Domain the minted key is restricted to. */
  domainId: string;
  /** Key name shown in the Resend dashboard. */
  name: string;
  stage: string;
}

export interface ResendSendingKey {
  keyId: string;
  name: string;
  /**
   * The send-only token. Resend reveals this exactly once, at creation, so it
   * is cached in the local vault — losing it means minting a new key.
   */
  token: string;
}

export const ResendSendingKey = Resource(
  "postbox::ResendSendingKey",
  async function (
    this: Context<ResendSendingKey>,
    _id: string,
    props: ResendSendingKeyProps,
  ): Promise<ResendSendingKey> {
    if (this.phase === "delete") {
      const keyId = this.output?.keyId ?? readVault(props.stage).resendSendingKeyId;
      if (keyId) {
        const { ok, status, data } = await resend(
          props.apiKey,
          "DELETE",
          `/api-keys/${keyId}`,
        );
        if (!ok && status !== 404) fail("revoke sending key", status, data);
      }
      updateVault(props.stage, (v) => ({
        ...v,
        resendSendingKey: undefined,
        resendSendingKeyId: undefined,
      }));
      return this.destroy();
    }

    // The token is unrecoverable from the API, so the vault is the source of
    // truth across deploys. Reuse it whenever we still hold it.
    const cached = readVault(props.stage);
    if (cached.resendSendingKey && cached.resendSendingKeyId) {
      return {
        keyId: cached.resendSendingKeyId,
        name: props.name,
        token: cached.resendSendingKey,
      };
    }

    const { ok, status, data } = await resend<{ id: string; token: string }>(
      props.apiKey,
      "POST",
      "/api-keys",
      {
        name: props.name.slice(0, 50),
        permission: "sending_access",
        domain_id: props.domainId,
      },
    );
    if (!ok) fail("create a send-only API key", status, data);

    updateVault(props.stage, (v) => ({
      ...v,
      resendSendingKey: data.token,
      resendSendingKeyId: data.id,
    }));

    return { keyId: data.id, name: props.name, token: data.token };
  },
);

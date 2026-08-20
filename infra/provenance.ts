/**
 * What was here before Postbox was.
 *
 * `just down` promises to remove what it made. The failure mode that promise
 * hides is the zone that was not empty when you arrived: a domain already
 * receiving mail through Email Routing, a catch-all already forwarding to
 * Gmail, DNS records someone wrote by hand. Tearing Postbox down must not take
 * any of that with it.
 *
 * Two kinds of evidence are used, and the difference matters:
 *
 *   Marks    Every record Postbox writes carries its name in the comment, and
 *            the rules it creates are named after it. That evidence is on the
 *            object itself, so it stays true for deployments that predate this
 *            file and cannot drift out of sync with reality.
 *
 *   Memory   Whether Email Routing was already switched on, or a destination
 *            address already verified, leaves no mark at all. That can only be
 *            observed *before* the first deploy, so it is recorded once and
 *            never rewritten.
 *
 * Where there is no evidence either way, the resource is kept. Leaving
 * something behind is a tidiness problem; deleting a stranger's DNS record is
 * an outage.
 */
import fs from "node:fs";
import path from "node:path";
import type { CloudflareApi } from "alchemy/cloudflare";
import { readVault, updateVault } from "./vault.ts";

/** Written into every DNS record Postbox creates, and looked for on the way out. */
export const POSTBOX_MARK = "Postbox ·";

/** Prefix of the Email Routing rules Postbox creates. */
export const POSTBOX_RULE_MARK = "Postbox —";

export interface Provenance {
  /** null where it could not be known — an install older than this record. */
  emailRouting: boolean | null;
  forwardAddress: boolean | null;
  database: boolean | null;
  kv: boolean | null;
  resendDomain: boolean | null;
  /** The catch-all rule as we found it, so `just down` can put it back. */
  catchAll: CatchAllRule | null;
  recordedAt: number | null;
}

export interface CatchAllRule {
  enabled: boolean;
  name?: string;
  matchers?: unknown;
  actions?: unknown;
}

const UNKNOWN: Provenance = {
  emailRouting: null,
  forwardAddress: null,
  database: null,
  kv: null,
  resendDomain: null,
  catchAll: null,
  recordedAt: null,
};

export function readProvenance(stage: string): Provenance {
  return readVault(stage).preexisting ?? UNKNOWN;
}

/** True once Alchemy has written state for this stage — i.e. not a first run. */
function hasDeployedBefore(stage: string): boolean {
  const dir = path.resolve(process.cwd(), ".alchemy", "postbox", stage);
  try {
    return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith(".json"));
  } catch {
    return false;
  }
}

async function json<T>(api: CloudflareApi, path: string): Promise<T | null> {
  try {
    const response = await api.get(path);
    if (!response.ok) return null;
    const body = (await response.json()) as { result?: T };
    return body.result ?? null;
  } catch {
    return null;
  }
}

/**
 * Look once, before anything is created, and remember what was already there.
 *
 * Deliberately never overwrites an existing record: the answer to "what was
 * here first" is only available on the first run, and every run after this one
 * would answer it with Postbox's own handiwork.
 */
export async function captureProvenance(
  api: CloudflareApi,
  input: {
    stage: string;
    zoneId: string;
    databaseName: string;
    kvTitle: string;
    forwardTo?: string;
    resendDomainExists?: boolean;
  },
): Promise<Provenance> {
  const existing = readVault(input.stage).preexisting;
  if (existing) return existing;

  // A deployment that already exists cannot be asked what came before it —
  // everything in the account is now Postbox's own handiwork, and probing
  // would happily report our database as something we found here. Record that
  // we do not know, which each decision downstream resolves in the careful
  // direction.
  if (hasDeployedBefore(input.stage)) {
    const unknown = { ...UNKNOWN, recordedAt: Date.now() };
    updateVault(input.stage, (v) => ({ ...v, preexisting: unknown }));
    return unknown;
  }

  const routing = await json<{ enabled?: boolean; status?: string }>(
    api,
    `/zones/${input.zoneId}/email/routing`,
  );

  const catchAll = await json<CatchAllRule>(
    api,
    `/zones/${input.zoneId}/email/routing/rules/catch_all`,
  );

  const addresses = await json<{ email: string }[]>(
    api,
    `/accounts/${api.accountId}/email/routing/addresses?per_page=100`,
  );

  const databases = await json<{ name: string }[]>(
    api,
    `/accounts/${api.accountId}/d1/database?name=${encodeURIComponent(input.databaseName)}`,
  );

  const namespaces = await json<{ title: string }[]>(
    api,
    `/accounts/${api.accountId}/storage/kv/namespaces?per_page=100`,
  );

  const captured: Provenance = {
    emailRouting: routing?.enabled === true,
    forwardAddress: input.forwardTo
      ? (addresses ?? []).some(
          (a) => a.email.toLowerCase() === input.forwardTo!.toLowerCase(),
        )
      : false,
    database: (databases ?? []).some((d) => d.name === input.databaseName),
    kv: (namespaces ?? []).some((n) => n.title === input.kvTitle),
    resendDomain: input.resendDomainExists ?? false,
    // Only worth remembering if it was actually doing something, and not if it
    // is already ours from a deploy that failed halfway through.
    catchAll:
      catchAll?.enabled && !isOurs(catchAll) ? stripRule(catchAll) : null,
    recordedAt: Date.now(),
  };

  updateVault(input.stage, (v) => ({ ...v, preexisting: captured }));
  return captured;
}

export function isOurs(rule: CatchAllRule | null | undefined): boolean {
  return typeof rule?.name === "string" && rule.name.startsWith(POSTBOX_RULE_MARK);
}

function stripRule(rule: CatchAllRule): CatchAllRule {
  return {
    enabled: rule.enabled,
    name: rule.name,
    matchers: rule.matchers,
    actions: rule.actions,
  };
}

/**
 * Whether a record of this type and name already exists at all, regardless of
 * who wrote it.
 *
 * Used for records Postbox will only ever *add* — a DMARC policy someone
 * already published is a decision about their whole domain, and quietly
 * replacing it with a weaker one would be worse than not writing it at all.
 */
export async function recordExists(
  api: CloudflareApi,
  zoneId: string,
  type: string,
  name: string,
): Promise<boolean> {
  const matches = await json<unknown[]>(
    api,
    `/zones/${zoneId}/dns_records?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}`,
  );
  return (matches ?? []).length > 0;
}

export interface WantedRecord {
  type: string;
  name: string;
  content: string;
  priority?: number;
  purpose?: string;
}

/**
 * Split the records a provider wants into the ones Postbox may delete later
 * and the ones it must not.
 *
 * Judged by the comment on the live record rather than by anything we stored,
 * so it is right the first time, right after someone edits a record by hand,
 * and right for a deployment made before any of this existed.
 */
export async function classifyRecords<T extends WantedRecord>(
  api: CloudflareApi,
  zoneId: string,
  wanted: T[],
): Promise<{ ours: T[]; adopted: T[] }> {
  const ours: T[] = [];
  const adopted: T[] = [];

  for (const record of wanted) {
    const matches = await json<{ comment?: string | null }[]>(
      api,
      `/zones/${zoneId}/dns_records?type=${encodeURIComponent(record.type)}&name=${encodeURIComponent(record.name)}`,
    );

    const live = (matches ?? [])[0];
    // No record yet, or one we wrote ourselves: ours to manage and to remove.
    if (!live || (live.comment ?? "").includes(POSTBOX_MARK)) ours.push(record);
    else adopted.push(record);
  }

  return { ours, adopted };
}

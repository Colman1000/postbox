import type { Env } from "../../env.ts";
import { cloudflareProvider } from "./cloudflare.ts";
import { incrementQuota, readQuota } from "./quota.ts";
import { resendProvider } from "./resend.ts";
import { SendError, type MailProvider, type SendRequest } from "./types.ts";

export { renderBody } from "./render.ts";
export { toPlainText, stripTags } from "./plaintext.ts";
export { checkDeliverability } from "./deliverability.ts";
export { readQuota } from "./quota.ts";
export { SendError };
export type { MailProvider, SendRequest, OutboundAttachment } from "./types.ts";

const PROVIDERS: Record<string, MailProvider> = {
  resend: resendProvider,
  cloudflare: cloudflareProvider,
};

/**
 * Which provider this deployment sends through.
 *
 * Set by `MAIL_PROVIDER` at deploy time. An unknown value falls back to Resend
 * rather than failing closed, because a typo in an env var should not take
 * sending offline.
 */
export function getProvider(env: Env): MailProvider {
  return PROVIDERS[env.MAIL_PROVIDER] ?? resendProvider;
}

/**
 * Sends, after checking there is headroom left.
 *
 * The quota check lives here rather than in each provider so both share the
 * same wording and the same accounting, and so adding a provider means
 * implementing one method.
 */
export async function send(
  env: Env,
  request: SendRequest,
): Promise<{ providerId: string }> {
  const provider = getProvider(env);
  const { daily, monthly, monthlyIsHardCap } = provider.limits;
  const quota = await readQuota(env);

  if (daily !== null && quota.sentToday >= daily) {
    throw new SendError(
      `Daily sending limit reached (${daily} on ${provider.label}'s free tier). ` +
        "It resets at midnight UTC — the message has been kept as a draft.",
      429,
      true,
    );
  }
  if (monthly !== null && monthlyIsHardCap && quota.sentThisMonth >= monthly) {
    throw new SendError(
      `Monthly sending limit reached (${monthly} on ${provider.label}'s free tier).`,
      429,
      true,
    );
  }

  const result = await provider.send(env, request);
  await incrementQuota(env);
  return result;
}

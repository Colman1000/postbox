import type { Address } from "../../../shared/types.ts";
import type { Env } from "../../env.ts";

/**
 * The sending contract.
 *
 * Postbox can send through more than one provider, and which one is in use is
 * a deployment decision rather than a code change. Everything provider-shaped
 * lives behind this interface: the API call, the error vocabulary, and the
 * free-tier limits the UI reports.
 */

export type ProviderId = "resend" | "cloudflare";

export interface OutboundAttachment {
  filename: string;
  content: ArrayBuffer;
  contentType?: string;
}

export interface SendRequest {
  from: Address;
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  replyTo?: string | null;
  subject: string;
  /** Rendered HTML body. */
  html: string;
  /** Plain-text alternative. Never omitted — some clients only show this. */
  text: string;
  inReplyTo?: string | null;
  references?: string | null;
  attachments?: OutboundAttachment[];
}

export interface ProviderLimits {
  /** Hard daily cap, or null where the provider does not publish one. */
  daily: number | null;
  /** Monthly allowance, or null where sending is unmetered. */
  monthly: number | null;
  /**
   * Whether exceeding `monthly` is a refusal or just the end of the included
   * allowance. Resend stops; Cloudflare bills.
   */
  monthlyIsHardCap: boolean;
  /** One line for the UI, explaining what the numbers mean. */
  note: string;
}

export interface MailProvider {
  id: ProviderId;
  label: string;
  limits: ProviderLimits;
  /** Throws {@link SendError} on failure. */
  send(env: Env, request: SendRequest): Promise<{ providerId: string }>;
}

export class SendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "SendError";
  }
}

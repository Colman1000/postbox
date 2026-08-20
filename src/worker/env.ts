/** Bindings declared in alchemy.run.ts, seen from inside the Worker. */
export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;

  /** "resend" (free) or "cloudflare" (needs Workers Paid). */
  MAIL_PROVIDER: string;
  /** Only bound when MAIL_PROVIDER is "resend". */
  RESEND_API_KEY: string;
  AUTH_SECRET: string;
  APP_PASSWORD: string;

  MAIL_DOMAIN: string;
  DEFAULT_FROM: string;
  APP_HOSTNAME: string;
  FORWARD_TO: string;
  STAGE: string;
  /** "1" when Resend had verified the domain at deploy time. */
  SENDING_READY: string;

  /** Only bound when MAIL_PROVIDER is "cloudflare". */
  EMAIL?: SendEmail;

  /** Injected by Alchemy's Vite resource for the static UI. */
  ASSETS: Fetcher;
}

/** Hono context variables set by middleware. */
export interface Vars {
  authenticated: boolean;
  /** Which sign-in is acting, for the audit log. Null for older tokens. */
  sessionId: string | null;
  /**
   * A better sentence for the audit log than method-and-path, set by routes
   * that know what they just did. Read once the response is on its way out.
   */
  auditDetail?: string;
}

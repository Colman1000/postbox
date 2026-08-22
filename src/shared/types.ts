/**
 * The contract between the Worker and the UI.
 *
 * Both sides import from here, so a field rename breaks the type-check rather
 * than the running app.
 */

export type Folder =
  | "inbox"
  | "sent"
  | "drafts"
  | "scheduled"
  | "archive"
  | "trash"
  | "spam";

export type MessageStatus =
  | "received"
  | "draft"
  | "scheduled"
  | "queued"
  | "sent"
  | "failed";

export type Direction = "inbound" | "outbound";

export interface Address {
  address: string;
  name?: string;
}

/** Verdicts Cloudflare attaches to inbound mail; drives the trust badge. */
export interface AuthResults {
  spf?: string | null;
  dkim?: string | null;
  dmarc?: string | null;
}

export interface AttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  isInline: boolean;
  contentId?: string | null;
}

export interface Message {
  id: string;
  threadId: string;
  direction: Direction;
  status: MessageStatus;
  folder: Folder;

  rfcMessageId?: string | null;
  inReplyTo?: string | null;

  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo?: string | null;

  subject: string;
  snippet: string;
  bodyText?: string | null;
  bodyHtml?: string | null;

  auth: AuthResults;
  rawSize?: number | null;

  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  attachments: AttachmentMeta[];

  scheduledAt?: number | null;
  sentAt?: number | null;
  receivedAt?: number | null;
  createdAt: number;
  updatedAt: number;

  providerId?: string | null;
  error?: string | null;
}

export interface Thread {
  id: string;
  subject: string;
  snippet: string;
  participants: Address[];
  folder: Folder;
  messageCount: number;
  unreadCount: number;
  hasAttachments: boolean;
  isStarred: boolean;
  lastMessageAt: number;
  snoozedUntil?: number | null;
  labels: Label[];
}

export interface ThreadDetail extends Thread {
  messages: Message[];
}

export type LabelTone = "neutral" | "slate" | "stone" | "zinc" | "contrast";

export interface Label {
  id: string;
  name: string;
  tone: LabelTone;
}

export interface Contact {
  address: string;
  name?: string | null;
  messageCount: number;
  isFavorite: boolean;
  lastSeenAt: number;
}

export interface Identity {
  id: string;
  address: string;
  name?: string | null;
  signatureHtml?: string | null;
  isDefault: boolean;
}

export interface Template {
  id: string;
  name: string;
  subject: string;
  body: string;
  shortcut?: string | null;
  updatedAt: number;
}

export interface ActivityEvent {
  id: string;
  type: string;
  messageId?: string | null;
  threadId?: string | null;
  detail?: string | null;
  createdAt: number;
}

/** Counts + quota, polled by the sidebar. */
export interface Stats {
  counts: Record<Folder, number>;
  unread: Record<Folder, number>;
  starred: number;
  /** Whatever the configured sending provider allows. */
  quota: {
    provider: string;
    providerLabel: string;
    sentToday: number;
    sentThisMonth: number;
    /** null where the provider publishes no fixed daily cap. */
    dailyLimit: number | null;
    /** null where sending is unmetered. */
    monthlyLimit: number | null;
    /** False when passing the monthly figure means billing, not refusal. */
    monthlyIsHardCap: boolean;
    note: string;
  };
  storage: {
    messages: number;
    attachmentBytes: number;
  };
}

/**
 * One row of the access log.
 *
 * With a single shared password there is no user to name, so the actor is the
 * sign-in: `sessionId` ties every action back to the session it came from, and
 * the address and device say where that session was.
 */
export interface AuditEntry {
  id: string;
  sessionId: string | null;
  /** sign-in | sign-in-failed | sign-in-blocked | sign-out | change */
  action: string;
  detail: string | null;
  ip: string | null;
  country: string | null;
  userAgent: string | null;
  createdAt: number;
}

/** One inbound message, as announced by the polling endpoint. */
export interface Arrival {
  id: string;
  threadId: string;
  subject: string;
  snippet: string;
  from: Address;
  receivedAt: number;
}

/**
 * The answer to "has anything arrived?", polled by every open tab.
 *
 * `now` is the server's clock, which the client sends back as `since` on the
 * next poll — comparing against the browser's clock would double-announce or
 * silently skip mail whenever the two disagree.
 */
export interface MailUpdate {
  now: number;
  /** Unread inbound messages in the inbox. Drives the tab title. */
  unread: number;
  arrivals: Arrival[];
}

export interface SessionInfo {
  authenticated: boolean;
  domain: string;
  defaultFrom: string;
  appHostname: string;
  stage: string;
  /** False until Resend confirms DNS; the UI warns instead of failing sends. */
  sendingReady: boolean;
}

/** What Compose posts. */
export interface DraftInput {
  id?: string;
  from: string;
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  subject: string;
  /** Markdown. Converted to HTML + text on send. */
  body: string;
  inReplyTo?: string | null;
  threadId?: string | null;
  attachmentIds?: string[];
}

export interface SendResult {
  messageId: string;
  threadId: string;
  providerId?: string;
  scheduledAt?: number;
}

export interface Paginated<T> {
  items: T[];
  cursor?: string | null;
  hasMore: boolean;
}

/**
 * Total attachment bytes one outgoing message may carry.
 *
 * Enforced by the Worker, and checked by the composer before it starts
 * uploading — finding out that a file is too big only after sending it over a
 * slow connection is the worst possible time to learn it.
 */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export const FOLDERS: Folder[] = [
  "inbox",
  "sent",
  "drafts",
  "scheduled",
  "archive",
  "spam",
  "trash",
];

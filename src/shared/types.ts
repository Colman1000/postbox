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
  /** Resend free tier is 100 sends/day, 3,000/month. */
  quota: {
    sentToday: number;
    dailyLimit: number;
    sentThisMonth: number;
    monthlyLimit: number;
  };
  storage: {
    messages: number;
    attachmentBytes: number;
  };
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

export const FOLDERS: Folder[] = [
  "inbox",
  "sent",
  "drafts",
  "scheduled",
  "archive",
  "spam",
  "trash",
];

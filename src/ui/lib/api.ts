import type {
  ActivityEvent,
  AppIconSetting,
  AuditEntry,
  Contact,
  DraftInput,
  Folder,
  Identity,
  Label,
  Mailbox,
  MailboxSuggestion,
  MailUpdate,
  Paginated,
  PushDevice,
  SendResult,
  SessionInfo,
  Stats,
  Template,
  Thread,
  ThreadDetail,
} from "@shared/types.ts";

/**
 * The one place the UI talks to the Worker.
 *
 * Errors arrive as `ApiError` with the server's own sentence in `.message`,
 * because the API already writes human-readable failures — re-wording them in
 * the client would only make them vaguer.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** An upload the writer stopped. Not a failure, and not worth a toast. */
export class UploadCancelled extends Error {
  constructor() {
    super("Upload cancelled");
    this.name = "UploadCancelled";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }

  if (!response.ok) {
    const body = data as { error?: string; hint?: string } | null;
    throw new ApiError(
      body?.error ?? `Request failed (${response.status})`,
      response.status,
      body?.hint,
    );
  }

  return data as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export type ThreadAction =
  | "read"
  | "unread"
  | "star"
  | "unstar"
  | "archive"
  | "inbox"
  | "trash"
  | "restore"
  | "spam"
  | "not-spam"
  | "snooze"
  | "unsnooze"
  | "delete";

export const api = {
  // ── session ───────────────────────────────────────────────────────────────
  session: () => request<SessionInfo>("/auth/session"),
  login: (password: string) => post<{ ok: true }>("/auth/login", { password }),
  logout: () => post<{ ok: true }>("/auth/logout"),

  // ── mail ──────────────────────────────────────────────────────────────────
  threads: (params: {
    folder?: Folder;
    starred?: boolean;
    label?: string;
    mailbox?: string;
    cursor?: string | null;
    limit?: number;
  }) => {
    const query = new URLSearchParams();
    if (params.folder) query.set("folder", params.folder);
    if (params.starred) query.set("starred", "1");
    if (params.label) query.set("label", params.label);
    if (params.mailbox) query.set("mailbox", params.mailbox);
    if (params.cursor) query.set("cursor", params.cursor);
    if (params.limit) query.set("limit", String(params.limit));
    return request<Paginated<Thread>>(`/threads?${query}`);
  },

  thread: (id: string) => request<ThreadDetail>(`/threads/${id}`),

  search: (q: string) =>
    request<Paginated<Thread> & { invalidQuery?: boolean }>(
      `/search?q=${encodeURIComponent(q)}`,
    ),

  act: (ids: string[], action: ThreadAction, until?: number) =>
    post<{ ok: true; affected: number }>("/threads/actions", { ids, action, until }),

  setLabels: (threadId: string, add: string[], remove: string[]) =>
    post<{ labels: Label[] }>(`/threads/${threadId}/labels`, { add, remove }),

  attachmentUrl: (id: string) => `/api/attachments/${id}`,

  // ── compose ───────────────────────────────────────────────────────────────
  saveDraft: (draft: DraftInput) =>
    post<{ id: string; threadId: string; updatedAt: number }>("/drafts", draft),

  draft: (id: string) => request<import("@shared/types.ts").Message>(`/drafts/${id}`),

  deleteDraft: (id: string) => request<{ ok: true }>(`/drafts/${id}`, { method: "DELETE" }),

  send: (draft: DraftInput & { scheduledAt?: number }) => post<SendResult>("/send", draft),

  /**
   * What a receiving spam filter is likely to notice about this draft.
   *
   * Advisory: it never blocks a send, and a clean result is not a promise of
   * an inbox. See docs/DELIVERABILITY.md for what it cannot see.
   */
  deliverability: (draft: DraftInput) =>
    post<{ findings: import("@shared/types.ts").DeliverabilityFinding[] }>(
      "/deliverability/check",
      draft,
    ),

  cancelScheduled: (id: string) => post<{ ok: true }>(`/scheduled/${id}/cancel`),

  /**
   * An upload you can watch, and stop.
   *
   * The one place this file does not use `fetch`: the browser only reports how
   * far a request body has been sent through `XMLHttpRequest`. On a phone
   * uploading a few megabytes, a bar that moves is the difference between
   * "working" and "broken", and an upload you can abandon is the difference
   * between waiting and starting again.
   */
  uploadAttachment: (
    draftId: string,
    file: File,
    options?: { onProgress?: (fraction: number) => void; signal?: AbortSignal },
  ) =>
    new Promise<{ id: string; filename: string; mimeType: string; size: number }>(
      (resolve, reject) => {
        if (options?.signal?.aborted) {
          reject(new UploadCancelled());
          return;
        }

        const upload = new XMLHttpRequest();
        upload.open("POST", `/api/drafts/${draftId}/attachments`);
        upload.withCredentials = true;

        upload.upload.addEventListener("progress", (event) => {
          if (event.lengthComputable) options?.onProgress?.(event.loaded / event.total);
        });

        upload.addEventListener("load", () => {
          let data: Record<string, unknown> | null = null;
          try {
            data = upload.responseText ? JSON.parse(upload.responseText) : null;
          } catch {
            data = null;
          }
          if (upload.status >= 200 && upload.status < 300) {
            resolve(data as unknown as { id: string; filename: string; mimeType: string; size: number });
          } else {
            reject(
              new ApiError(
                (data?.error as string) ?? `Upload failed (${upload.status})`,
                upload.status,
                data?.hint as string | undefined,
              ),
            );
          }
        });

        upload.addEventListener("error", () =>
          reject(new ApiError("The upload did not finish — check your connection.", 0)),
        );
        upload.addEventListener("abort", () => reject(new UploadCancelled()));
        options?.signal?.addEventListener("abort", () => upload.abort());

        const form = new FormData();
        form.append("file", file);
        upload.send(form);
      },
    ),

  removeAttachment: (id: string) =>
    request<{ ok: true }>(`/attachments/${id}`, { method: "DELETE" }),

  // ── workspace ─────────────────────────────────────────────────────────────
  labels: () => request<(Label & { count: number })[]>("/labels"),
  createLabel: (name: string, tone = "neutral") => post<Label>("/labels", { name, tone }),
  deleteLabel: (id: string) => request<{ ok: true }>(`/labels/${id}`, { method: "DELETE" }),

  /**
   * Sidebar mailboxes: one address each, with what clicking it will list.
   *
   * Creating one moves no mail — the grouping is derived from the address each
   * message arrived at — so `createMailbox` is instant and `deleteMailbox`
   * costs nothing but the sidebar entry.
   */
  mailboxes: () => request<Mailbox[]>("/mailboxes"),
  mailboxSuggestions: () => request<MailboxSuggestion[]>("/mailboxes/suggestions"),
  createMailbox: (address: string, name?: string) =>
    post<Mailbox>("/mailboxes", { address, name }),
  deleteMailbox: (id: string) => request<{ ok: true }>(`/mailboxes/${id}`, { method: "DELETE" }),

  identities: () => request<Identity[]>("/identities"),
  saveIdentity: (identity: Partial<Identity>) => post<{ ok: true }>("/identities", identity),
  deleteIdentity: (id: string) =>
    request<{ ok: true }>(`/identities/${id}`, { method: "DELETE" }),

  templates: () => request<Template[]>("/templates"),
  saveTemplate: (template: Partial<Template>) => post<Template>("/templates", template),
  deleteTemplate: (id: string) =>
    request<{ ok: true }>(`/templates/${id}`, { method: "DELETE" }),

  contacts: (q?: string, limit = 8) =>
    request<Contact[]>(`/contacts?q=${encodeURIComponent(q ?? "")}&limit=${limit}`),

  favoriteContact: (address: string, favorite: boolean) =>
    post<{ ok: true }>(`/contacts/${encodeURIComponent(address)}/favorite`, { favorite }),

  settings: () => request<Record<string, unknown>>("/settings"),
  saveSettings: (patch: Record<string, unknown>) =>
    request<{ ok: true }>("/settings", { method: "PATCH", body: JSON.stringify(patch) }),

  // ── push ──────────────────────────────────────────────────────────────────
  //
  // The subscription itself is created by the browser; these only tell the
  // mailbox about it. See lib/push.ts for the half that talks to the browser.
  subscribePush: (subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }) => post<{ ok: true }>("/push/subscribe", subscription),

  unsubscribePush: (endpoint: string) => post<{ ok: true }>("/push/unsubscribe", { endpoint }),

  pushDevices: () => request<PushDevice[]>("/push/devices"),

  /** Sends a real notification through the real push service. */
  testPush: () => post<{ ok: true; delivered: number }>("/push/test"),

  // ── app icon ──────────────────────────────────────────────────────────────
  //
  // Both variants are rendered in the browser (see lib/app-icon.ts) and posted
  // as finished PNGs, because a Worker cannot draw one.
  saveAppIcon: (icon: { any: Blob; maskable: Blob }, meta: AppIconSetting) => {
    const form = new FormData();
    form.append("any", icon.any, "any.png");
    form.append("maskable", icon.maskable, "maskable.png");
    form.append("meta", JSON.stringify(meta));
    return request<AppIconSetting>("/icon", { method: "POST", body: form });
  },

  /** Back to the icon Postbox ships, which is a static asset. */
  resetAppIcon: () => request<AppIconSetting>("/icon", { method: "DELETE" }),

  stats: () => request<Stats>("/stats"),
  updates: (since: number) => request<MailUpdate>(`/updates?since=${since}`),
  // Both logs page newest-first on an id cursor; see the note on LOG_PAGE.
  events: (cursor?: string | null) =>
    request<Paginated<ActivityEvent>>(`/events${cursor ? `?cursor=${cursor}` : ""}`),
  audit: (cursor?: string | null) =>
    request<Paginated<AuditEntry>>(`/audit${cursor ? `?cursor=${cursor}` : ""}`),
};

import type {
  ActivityEvent,
  AuditEntry,
  Contact,
  DraftInput,
  Folder,
  Identity,
  Label,
  MailUpdate,
  Paginated,
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
    cursor?: string | null;
    limit?: number;
  }) => {
    const query = new URLSearchParams();
    if (params.folder) query.set("folder", params.folder);
    if (params.starred) query.set("starred", "1");
    if (params.label) query.set("label", params.label);
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

  cancelScheduled: (id: string) => post<{ ok: true }>(`/scheduled/${id}/cancel`),

  uploadAttachment: async (draftId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{ id: string; filename: string; mimeType: string; size: number }>(
      `/drafts/${draftId}/attachments`,
      { method: "POST", body: form },
    );
  },

  removeAttachment: (id: string) =>
    request<{ ok: true }>(`/attachments/${id}`, { method: "DELETE" }),

  // ── workspace ─────────────────────────────────────────────────────────────
  labels: () => request<(Label & { count: number })[]>("/labels"),
  createLabel: (name: string, tone = "neutral") => post<Label>("/labels", { name, tone }),
  deleteLabel: (id: string) => request<{ ok: true }>(`/labels/${id}`, { method: "DELETE" }),

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

  stats: () => request<Stats>("/stats"),
  updates: (since: number) => request<MailUpdate>(`/updates?since=${since}`),
  events: () => request<ActivityEvent[]>("/events"),
  audit: (limit = 100) => request<AuditEntry[]>(`/audit?limit=${limit}`),
};

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type { Folder, Thread } from "@shared/types.ts";
import { api, type ThreadAction } from "./api.ts";

/**
 * Server state.
 *
 * Conversation actions are applied optimistically across every cached list at
 * once — waiting ~150 ms for a round-trip before a row disappears is the
 * difference between a mail client that feels native and one that feels like a
 * web page.
 */

export const keys = {
  session: ["session"] as const,
  threads: (folder: string, label?: string, starred?: boolean) =>
    ["threads", folder, label ?? null, starred ?? false] as const,
  thread: (id: string) => ["thread", id] as const,
  search: (q: string) => ["search", q] as const,
  stats: ["stats"] as const,
  labels: ["labels"] as const,
  identities: ["identities"] as const,
  templates: ["templates"] as const,
  contacts: (q: string) => ["contacts", q] as const,
  settings: ["settings"] as const,
  events: ["events"] as const,
  audit: ["audit"] as const,
  updates: ["updates"] as const,
};

export function useSession() {
  return useQuery({
    queryKey: keys.session,
    queryFn: api.session,
    staleTime: 60_000,
    retry: false,
  });
}

export function useThreads(view: {
  folder: Folder;
  label?: string;
  starred?: boolean;
}) {
  return useInfiniteQuery({
    queryKey: keys.threads(view.folder, view.label, view.starred),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.threads({
        folder: view.folder,
        label: view.label,
        starred: view.starred,
        cursor: pageParam,
      }),
    getNextPageParam: (last) => (last.hasMore ? last.cursor : undefined),
    staleTime: 15_000,
  });
}

export function useSearch(query: string) {
  return useQuery({
    queryKey: keys.search(query),
    queryFn: () => api.search(query),
    enabled: query.trim().length >= 2,
    staleTime: 30_000,
  });
}

export function useThread(id: string | null) {
  return useQuery({
    queryKey: keys.thread(id ?? ""),
    queryFn: () => api.thread(id!),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useStats() {
  return useQuery({
    queryKey: keys.stats,
    queryFn: api.stats,
    // Cheap, and it drives the unread badges — a minute stale is plenty.
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

export const useLabels = () =>
  useQuery({ queryKey: keys.labels, queryFn: api.labels, staleTime: 300_000 });

export const useIdentities = () =>
  useQuery({ queryKey: keys.identities, queryFn: api.identities, staleTime: 300_000 });

export const useTemplates = () =>
  useQuery({ queryKey: keys.templates, queryFn: api.templates, staleTime: 300_000 });

export const useSettings = () =>
  useQuery({ queryKey: keys.settings, queryFn: api.settings, staleTime: 300_000 });

/**
 * The two logs in Settings.
 *
 * Both are read the same way — newest first, scrolled until the answer shows
 * up — so both page rather than arriving as one slab. Neither is fetched until
 * its tab is opened, since Radix does not mount a panel nobody has looked at.
 */
export const useEvents = () =>
  useInfiniteQuery({
    queryKey: keys.events,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.events(pageParam),
    getNextPageParam: (last) => (last.hasMore ? last.cursor : undefined),
    staleTime: 20_000,
  });

export const useAudit = () =>
  useInfiniteQuery({
    queryKey: keys.audit,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.audit(pageParam),
    getNextPageParam: (last) => (last.hasMore ? last.cursor : undefined),
    staleTime: 20_000,
  });

export function useContacts(query: string) {
  return useQuery({
    queryKey: keys.contacts(query),
    queryFn: () => api.contacts(query),
    staleTime: 120_000,
  });
}

/** Which actions remove a conversation from the list you are looking at. */
function removesFromView(action: ThreadAction, folder: Folder, starred?: boolean): boolean {
  if (action === "delete") return true;
  // Starred is a filter, not a folder: unstarring is what removes a row there.
  if (action === "unstar") return starred === true;
  if (action === "archive") return folder === "inbox" || folder === "spam";
  if (action === "trash") return folder !== "trash";
  if (action === "spam") return folder === "inbox";
  if (action === "not-spam" || action === "inbox") return folder === "spam" || folder === "trash";
  if (action === "restore") return folder === "trash";
  if (action === "snooze") return true;
  return false;
}

function patchThread(thread: Thread, action: ThreadAction, until?: number): Thread {
  switch (action) {
    case "read":
      return { ...thread, unreadCount: 0 };
    case "unread":
      return { ...thread, unreadCount: Math.max(1, thread.unreadCount) };
    case "star":
      return { ...thread, isStarred: true };
    case "unstar":
      return { ...thread, isStarred: false };
    case "snooze":
      return { ...thread, snoozedUntil: until ?? null };
    case "unsnooze":
      return { ...thread, snoozedUntil: null };
    default:
      return thread;
  }
}

/**
 * Applies a conversation action to every cached thread list immediately, then
 * reconciles with the server. On failure the whole snapshot is rolled back, so
 * a dropped request never leaves the UI lying.
 */
export function useThreadAction(view: { folder: Folder; starred?: boolean }) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({
      ids,
      action,
      until,
    }: {
      ids: string[];
      action: ThreadAction;
      until?: number;
    }) => api.act(ids, action, until),

    onMutate: async ({ ids, action, until }) => {
      await client.cancelQueries({ queryKey: ["threads"] });
      const snapshot = client.getQueriesData({ queryKey: ["threads"] });
      const idSet = new Set(ids);
      const drop = removesFromView(action, view.folder, view.starred);

      client.setQueriesData<{ pages: { items: Thread[] }[] }>(
        { queryKey: ["threads"] },
        (data) => {
          if (!data?.pages) return data;
          return {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              items: drop
                ? page.items.filter((t) => !idSet.has(t.id))
                : page.items.map((t) => (idSet.has(t.id) ? patchThread(t, action, until) : t)),
            })),
          };
        },
      );

      return { snapshot };
    },

    onError: (_error, _vars, context) => {
      for (const [key, data] of context?.snapshot ?? []) {
        client.setQueryData(key, data);
      }
    },

    onSettled: (_data, _error, { ids }) => {
      client.invalidateQueries({ queryKey: ["threads"] });
      client.invalidateQueries({ queryKey: keys.stats });
      // Reading or archiving changes the unread count, and the count is what
      // the tab title shows — leaving it 15 seconds stale is 15 seconds of the
      // title claiming mail you have already read.
      client.invalidateQueries({ queryKey: keys.updates });
      for (const id of ids) client.invalidateQueries({ queryKey: keys.thread(id) });
    },
  });
}

/** Called after a send so counts, lists and the thread all catch up at once. */
export function refreshAfterSend(client: QueryClient, threadId?: string) {
  client.invalidateQueries({ queryKey: ["threads"] });
  client.invalidateQueries({ queryKey: keys.stats });
  client.invalidateQueries({ queryKey: keys.updates });
  client.invalidateQueries({ queryKey: keys.events });
  client.invalidateQueries({ queryKey: keys.contacts("") });
  if (threadId) client.invalidateQueries({ queryKey: keys.thread(threadId) });
}

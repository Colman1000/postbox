import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Address, Folder, Message, SessionInfo, Thread } from "@shared/types.ts";
import { api } from "@/lib/api.ts";
import { useHotkeys } from "@/hooks/use-hotkeys.ts";
import { useIsMobile } from "@/hooks/use-media-query.ts";
import { useSearch, useThreadAction, useThreads } from "@/lib/queries.ts";
import { useMailTitle, useNewMail } from "@/hooks/use-new-mail.ts";
import { lazyWithReload } from "@/lib/lazy.ts";
import { ErrorBoundary } from "@/components/error-boundary.tsx";
import { cn } from "@/lib/utils.ts";
import type { ComposeSeed } from "./composer.tsx";
import { Sidebar } from "./sidebar.tsx";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet.tsx";
import { ThreadList } from "./thread-list.tsx";
import { SplitPane } from "./split-pane.tsx";
import { ThreadView } from "./thread-view.tsx";

/*
 * Everything below the fold is code-split.
 *
 * The composer pulls in a Markdown renderer and the palette pulls in cmdk;
 * neither is needed to render an inbox, so they load on first use instead of
 * on first paint. `lazyWithReload` is what makes that safe across a deploy —
 * see the note there.
 */
const Composer = lazyWithReload(() =>
  import("./composer.tsx").then((m) => ({ default: m.Composer })),
);
const CommandPalette = lazyWithReload(() =>
  import("./command-palette.tsx").then((m) => ({ default: m.CommandPalette })),
);
const SettingsDialog = lazyWithReload(() =>
  import("./settings-dialog.tsx").then((m) => ({ default: m.SettingsDialog })),
);
const ShortcutsDialog = lazyWithReload(() =>
  import("./shortcuts-dialog.tsx").then((m) => ({ default: m.ShortcutsDialog })),
);

export interface MailView {
  folder: Folder;
  label?: string;
  labelName?: string;
  starred?: boolean;
}

/**
 * The application.
 *
 * Owns the three pieces of state that everything else reacts to — the current
 * view, the selected conversation, and the composer — and wires the keyboard
 * map to them. Child components stay presentational, which is what keeps the
 * shortcut behaviour in one readable place.
 */
export function MailApp({ session }: { session: SessionInfo }) {
  const client = useQueryClient();

  const [view, setView] = useState<MailView>({ folder: "inbox" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [compose, setCompose] = useState<ComposeSeed | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [navOpen, setNavOpen] = useState(false);
  const isMobile = useIsMobile();
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");

  const searchRef = useRef<HTMLInputElement>(null);

  // Mail that arrives while you are here (or elsewhere): refreshes the lists,
  // counts the unread for the tab title, and raises the alert you asked for.
  const openArrival = useCallback((threadId: string) => {
    setView({ folder: "inbox" });
    setQuery("");
    setSelectedId(threadId);
  }, []);
  const { unread, live } = useNewMail({ onOpenThread: openArrival });
  useMailTitle(unread, session.domain);

  // Debounce so every keystroke does not become an FTS query.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 220);
    return () => clearTimeout(timer);
  }, [query]);

  const searching = debouncedQuery.length >= 2;
  const listQuery = useThreads(view);
  const searchQuery = useSearch(debouncedQuery);
  const act = useThreadAction({ folder: view.folder, starred: view.starred });

  const threads: Thread[] = useMemo(() => {
    if (searching) return searchQuery.data?.items ?? [];
    return listQuery.data?.pages.flatMap((page) => page.items) ?? [];
  }, [searching, searchQuery.data, listQuery.data]);

  // A conversation that scrolled out of the current result set should not stay
  // open in the reading pane.
  useEffect(() => {
    if (selectedId && threads.length > 0 && !threads.some((t) => t.id === selectedId)) {
      setSelectedId(null);
    }
  }, [threads, selectedId]);

  const changeView = useCallback((next: MailView) => {
    setView(next);
    setSelectedId(null);
    setChecked(new Set());
    setQuery("");
    setNavOpen(false);
  }, []);

  const openThread = useCallback(
    (thread: Thread) => {
      setSelectedId(thread.id);
      if (thread.unreadCount > 0) act.mutate({ ids: [thread.id], action: "read" });
    },
    [act],
  );

  /** Targets for a keyboard action: the checked set, else the open conversation. */
  const targets = useCallback((): string[] => {
    if (checked.size > 0) return [...checked];
    return selectedId ? [selectedId] : [];
  }, [checked, selectedId]);

  const runAction = useCallback(
    (
      action: Parameters<typeof act.mutate>[0]["action"],
      until?: number,
      /**
       * Explicit targets, for callers that already know which conversation
       * they mean — a swipe, say. Routing those through the checked-set state
       * would read it back before React had applied the update.
       */
      explicitIds?: string[],
    ) => {
      const ids = explicitIds ?? targets();
      if (ids.length === 0) return;

      // Move the cursor before the row vanishes, so archiving repeatedly walks
      // down the list instead of dumping you back at nothing selected.
      const removes = ["archive", "trash", "spam", "delete", "snooze"].includes(action);
      if (removes && selectedId && ids.includes(selectedId)) {
        const index = threads.findIndex((t) => t.id === selectedId);
        const next = threads[index + 1] ?? threads[index - 1];
        setSelectedId(next && !ids.includes(next.id) ? next.id : null);
      }

      act.mutate(
        { ids, action, until },
        {
          onError: (error) => toast.error((error as Error).message),
        },
      );
      setChecked(new Set());

      const past: Record<string, string> = {
        archive: "Archived",
        trash: "Moved to Trash",
        spam: "Reported as spam",
        "not-spam": "Moved to Inbox",
        restore: "Restored",
        delete: "Deleted permanently",
        snooze: "Snoozed",
        star: "Starred",
        unstar: "Unstarred",
        unread: "Marked unread",
      };
      if (past[action]) {
        toast.success(`${past[action]}${ids.length > 1 ? ` · ${ids.length}` : ""}`, {
          action:
            action !== "delete"
              ? {
                  label: "Undo",
                  onClick: () =>
                    act.mutate({
                      ids,
                      action:
                        action === "archive" || action === "trash" || action === "spam"
                          ? view.folder === "trash"
                            ? "restore"
                            : "inbox"
                          : action === "star"
                            ? "unstar"
                            : action === "unstar"
                              ? "star"
                              : action === "unread"
                                ? "read"
                                : "unsnooze",
                    }),
                }
              : undefined,
        });
      }
    },
    [act, targets, selectedId, threads, view.folder],
  );

  /**
   * S toggles, rather than only ever starring.
   *
   * With a mixed selection the useful reading is "star the rest", so it only
   * unstars when every target is already starred — the same rule the toolbar
   * button follows, so the two never disagree.
   */
  const toggleStar = useCallback(() => {
    const ids = targets();
    if (ids.length === 0) return;
    const selection = threads.filter((t) => ids.includes(t.id));
    const allStarred = selection.length > 0 && selection.every((t) => t.isStarred);
    runAction(allStarred ? "unstar" : "star", undefined, ids);
  }, [targets, threads, runAction]);

  const move = useCallback(
    (delta: number) => {
      if (threads.length === 0) return;
      const index = selectedId ? threads.findIndex((t) => t.id === selectedId) : -1;
      const next = Math.max(0, Math.min(threads.length - 1, index + delta));
      const thread = threads[next];
      if (thread) {
        setSelectedId(thread.id);
        if (thread.unreadCount > 0) act.mutate({ ids: [thread.id], action: "read" });
      }
    },
    [threads, selectedId, act],
  );

  const startCompose = useCallback((seed?: ComposeSeed) => {
    setCompose(seed ?? { mode: "new" });
  }, []);

  useHotkeys(
    {
      c: () => startCompose(),
      "mod+k": () => setShowPalette(true),
      "/": () => searchRef.current?.focus(),
      "?": () => setShowShortcuts(true),
      j: () => move(1),
      k: () => move(-1),
      e: () => runAction("archive"),
      "#": () => runAction("trash"),
      "!": () => runAction("spam"),
      s: () => toggleStar(),
      u: () => runAction("unread"),
      Escape: () => {
        if (checked.size > 0) setChecked(new Set());
        else if (selectedId) setSelectedId(null);
      },
      "g i": () => changeView({ folder: "inbox" }),
      "g s": () => changeView({ folder: "sent" }),
      "g d": () => changeView({ folder: "drafts" }),
      "g a": () => changeView({ folder: "archive" }),
      "g t": () => changeView({ folder: "trash" }),
      "g e": () => changeView({ folder: "scheduled" }),
      "mod+/": () => setShowShortcuts(true),
    },
    !compose && !isMobile && !navOpen,
  );

  const title = searching
    ? `Results for “${debouncedQuery}”`
    : view.starred
      ? "Starred"
      : view.labelName
        ? view.labelName
        : view.folder[0].toUpperCase() + view.folder.slice(1);

  return (
    <div className="bg-background flex h-screen overflow-hidden">
      <Sidebar
        open={sidebarOpen}
        view={view}
        session={session}
        onChangeView={changeView}
        onCompose={() => startCompose()}
        onOpenSettings={() => setShowSettings(true)}
        onShowShortcuts={() => setShowShortcuts(true)}
        onToggle={() => setSidebarOpen((v) => !v)}
      />

      {/* Same navigation, in a drawer, for phones. */}
      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetContent side="left" showClose={false} className="p-0">
          <SheetTitle className="sr-only">Mailboxes</SheetTitle>
          <Sidebar
            variant="sheet"
            open
            view={view}
            session={session}
            onChangeView={changeView}
            onCompose={() => {
              setNavOpen(false);
              startCompose();
            }}
            onOpenSettings={() => {
              setNavOpen(false);
              setShowSettings(true);
            }}
            onShowShortcuts={() => {
              setNavOpen(false);
              setShowShortcuts(true);
            }}
            onToggle={() => {}}
          />
        </SheetContent>
      </Sheet>

      <SplitPane
        storageKey="postbox:split"
        className="h-full flex-1"
        leftClassName={cn(selectedId && "max-lg:hidden")}
        rightClassName={cn(!selectedId && "max-lg:hidden")}
        left={
          <div className="h-full">
            <ThreadList
              title={title}
              threads={threads}
              selectedId={selectedId}
              checked={checked}
              density={density}
              view={view}
              self={session.defaultFrom}
              query={query}
              searchRef={searchRef}
              isLoading={searching ? searchQuery.isLoading : listQuery.isLoading}
              isFetching={searching ? searchQuery.isFetching : listQuery.isFetching}
              hasMore={!searching && (listQuery.hasNextPage ?? false)}
              isLoadingMore={listQuery.isFetchingNextPage}
              onLoadMore={() => listQuery.fetchNextPage()}
              onQueryChange={setQuery}
              onSelect={openThread}
              onCheck={setChecked}
              onAction={runAction}
              onRefresh={() => client.invalidateQueries({ queryKey: ["threads"] })}
              onDensityChange={setDensity}
              onOpenNav={() => setNavOpen(true)}
              onCompose={() => startCompose()}
              onShowShortcuts={() => setShowShortcuts(true)}
            />
          </div>
        }
        right={
          <div className="h-full">
            <ThreadView
              threadId={selectedId}
              session={session}
              onClose={() => setSelectedId(null)}
              onAction={runAction}
              onCompose={startCompose}
            />
          </div>
        }
      />

      <ErrorBoundary compact label="That dialog">
      <Suspense fallback={null}>
        {compose && (
          <Composer
            seed={compose}
            session={session}
            onClose={() => setCompose(null)}
            onSent={(threadId) => {
              setCompose(null);
              if (threadId) setSelectedId(threadId);
            }}
          />
        )}

        {showPalette && (
          <CommandPalette
            open={showPalette}
            onOpenChange={setShowPalette}
            onNavigate={changeView}
            onCompose={() => startCompose()}
            onOpenSettings={() => setShowSettings(true)}
            onShowShortcuts={() => setShowShortcuts(true)}
            onOpenThread={(id) => setSelectedId(id)}
          />
        )}

        {showSettings && (
          <SettingsDialog
            open
            onOpenChange={setShowSettings}
            session={session}
            live={live}
          />
        )}
        {showShortcuts && <ShortcutsDialog open onOpenChange={setShowShortcuts} />}
      </Suspense>
      </ErrorBoundary>

    </div>
  );
}

/** Shared by the reply/forward buttons and the keyboard shortcuts. */
export function seedReply(
  message: Message,
  self: string,
  mode: "reply" | "reply-all" | "forward",
): ComposeSeed {
  const quoted = [
    "",
    "",
    `> On ${new Date(message.createdAt).toLocaleString()}, ${message.from.name ?? message.from.address} wrote:`,
    ...(message.bodyText ?? message.snippet).split("\n").map((line) => `> ${line}`),
  ].join("\n");

  if (mode === "forward") {
    return {
      mode: "forward",
      to: [],
      subject: message.subject.replace(/^(fwd?:\s*)*/i, "Fwd: "),
      body: `\n\n---------- Forwarded message ----------\nFrom: ${message.from.address}\nDate: ${new Date(message.createdAt).toLocaleString()}\nSubject: ${message.subject}\n\n${message.bodyText ?? message.snippet}`,
      from: self,
    };
  }

  const isOwn = message.from.address.toLowerCase() === self.toLowerCase();
  const primary: Address[] = isOwn ? message.to : [message.from];
  const everyone =
    mode === "reply-all"
      ? [...primary, ...message.to, ...message.cc].filter(
          (a) => a.address.toLowerCase() !== self.toLowerCase(),
        )
      : primary;

  const seen = new Set<string>();
  const to = everyone.filter((a) => {
    const key = a.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    mode,
    to,
    subject: /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`,
    body: quoted,
    inReplyTo: message.rfcMessageId ?? undefined,
    threadId: message.threadId,
    from: self,
  };
}

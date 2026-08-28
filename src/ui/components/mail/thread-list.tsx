import { useEffect, useRef, useState } from "react";
import {
  ArchiveIcon,
  MenuIcon,
  PencilLineIcon,
  ClockIcon,
  KeyboardIcon,
  LoaderCircleIcon,
  MailOpenIcon,
  PaperclipIcon,
  RefreshCwIcon,
  Rows3Icon,
  Rows4Icon,
  SearchIcon,
  ShieldAlertIcon,
  StarIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import type { Thread } from "@shared/types.ts";
import { participantSummary, shortDate } from "@/lib/format.ts";
import type { ThreadAction } from "@/lib/api.ts";
import { cn } from "@/lib/utils.ts";
import type { MailView } from "./mail-app.tsx";
import { EmptyState } from "./empty-state.tsx";
import { SnoozeMenu } from "./snooze-menu.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";

export function ThreadList({
  title,
  threads,
  selectedId,
  checked,
  density,
  view,
  self,
  query,
  searchRef,
  isLoading,
  isFetching,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onQueryChange,
  onSelect,
  onCheck,
  onAction,
  onRefresh,
  onDensityChange,
  onOpenNav,
  onCompose,
  onShowShortcuts,
}: {
  title: string;
  threads: Thread[];
  selectedId: string | null;
  checked: Set<string>;
  density: "comfortable" | "compact";
  view: MailView;
  self: string;
  query: string;
  searchRef: React.RefObject<HTMLInputElement | null>;
  isLoading: boolean;
  isFetching: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  onQueryChange: (value: string) => void;
  onSelect: (thread: Thread) => void;
  onCheck: (next: Set<string>) => void;
  onAction: (action: ThreadAction, until?: number, ids?: string[]) => void;
  onRefresh: () => void;
  onDensityChange: (density: "comfortable" | "compact") => void;
  /** Phone only: opens the navigation drawer. */
  onOpenNav: () => void;
  /** Phone only: the compose button lives here rather than in a hidden rail. */
  onCompose: () => void;
  onShowShortcuts: () => void;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // Infinite scroll, with a generous root margin so the next page is usually
  // already there by the time the reader reaches the bottom.
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !isLoadingMore) onLoadMore();
      },
      { root: scroller.current, rootMargin: "600px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, isLoadingMore, onLoadMore]);

  // Keep the keyboard cursor visible when j/k walks past the viewport edge.
  useEffect(() => {
    if (!selectedId) return;
    scroller.current
      ?.querySelector(`[data-thread-id="${selectedId}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  function onSwipeArchive(id: string, restore: boolean) {
    // Named explicitly rather than via the checked set — the set is React
    // state, and this needs to act on the row that was actually swiped, now.
    onAction(restore ? "inbox" : "archive", undefined, [id]);
  }

  const allChecked = threads.length > 0 && checked.size === threads.length;
  const someChecked = checked.size > 0;

  // Starring a selection that is already entirely starred can only sensibly
  // mean the opposite, which is also how the S key reads it.
  const checkedAllStarred =
    someChecked && threads.filter((t) => checked.has(t.id)).every((t) => t.isStarred);

  function toggle(id: string, shiftKey: boolean) {
    const next = new Set(checked);
    if (next.has(id)) next.delete(id);
    else next.add(id);

    // Shift-click fills the range from the last selection, as in every list UI.
    if (shiftKey && checked.size > 0) {
      const indices = threads
        .map((t, i) => (checked.has(t.id) ? i : -1))
        .filter((i) => i >= 0);
      const anchor = indices[indices.length - 1];
      const current = threads.findIndex((t) => t.id === id);
      const [from, to] = anchor < current ? [anchor, current] : [current, anchor];
      for (let i = from; i <= to; i++) next.add(threads[i].id);
    }
    onCheck(next);
  }

  return (
    <div className="bg-background flex h-full flex-col">
      {/* Search — on a phone the drawer button shares this row, because two
          full-height bars is most of a small screen before any mail shows. */}
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-3 pt-safe max-md:h-auto max-md:py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onOpenNav}
          className="text-muted-foreground shrink-0 md:hidden"
          aria-label="Open mailboxes"
        >
          <MenuIcon />
        </Button>

        <div className="relative flex-1">
          <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                onQueryChange("");
                e.currentTarget.blur();
              }
            }}
            placeholder="Search mail"
            className="h-8 border-transparent bg-muted/60 pr-8 pl-8 text-[13px] focus-visible:bg-background"
          />
          {query ? (
            <button
              type="button"
              onClick={() => onQueryChange("")}
              className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
              aria-label="Clear search"
            >
              <XIcon className="size-3.5" />
            </button>
          ) : (
            <Kbd className="absolute top-1/2 right-2 -translate-y-1/2">/</Kbd>
          )}
        </div>
      </div>

      {/* Title row / bulk toolbar */}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b px-3">
        <Checkbox
          checked={allChecked ? true : someChecked ? "indeterminate" : false}
          onCheckedChange={(value) =>
            onCheck(value ? new Set(threads.map((t) => t.id)) : new Set())
          }
          aria-label="Select all conversations"
          className="mr-1"
        />

        {someChecked ? (
          <div className="flex flex-1 items-center gap-0.5">
            <span className="text-muted-foreground mr-1 text-[12px] tabular-nums">
              {checked.size}
            </span>
            <IconAction label="Archive" shortcut="E" onClick={() => onAction("archive")}>
              <ArchiveIcon />
            </IconAction>
            {/* Nothing moves out of Trash except permanently. */}
            <IconAction
              label={view.folder === "trash" ? "Delete forever" : "Trash"}
              shortcut="#"
              onClick={() => onAction(view.folder === "trash" ? "delete" : "trash")}
            >
              <Trash2Icon />
            </IconAction>
            <IconAction label="Mark unread" shortcut="U" onClick={() => onAction("unread")}>
              <MailOpenIcon />
            </IconAction>
            <IconAction
              label={checkedAllStarred ? "Unstar" : "Star"}
              shortcut="S"
              onClick={() => onAction(checkedAllStarred ? "unstar" : "star")}
            >
              <StarIcon className={cn(checkedAllStarred && "fill-current")} />
            </IconAction>
            <SnoozeMenu onSnooze={(until) => onAction("snooze", until)}>
              <Button variant="ghost" size="icon-sm" className="text-muted-foreground">
                <ClockIcon />
              </Button>
            </SnoozeMenu>
            {view.folder !== "spam" && (
              <IconAction label="Report spam" shortcut="!" onClick={() => onAction("spam")}>
                <ShieldAlertIcon />
              </IconAction>
            )}
          </div>
        ) : (
          <h2 className="flex-1 truncate text-[13px] font-semibold tracking-tight">{title}</h2>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              onClick={() =>
                onDensityChange(density === "comfortable" ? "compact" : "comfortable")
              }
            >
              {density === "comfortable" ? <Rows3Icon /> : <Rows4Icon />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{density === "comfortable" ? "Compact rows" : "Comfortable rows"}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground max-md:hidden"
              onClick={onShowShortcuts}
              aria-label="Keyboard shortcuts"
            >
              <KeyboardIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent className="flex items-center gap-1.5">
            Keyboard shortcuts <Kbd>?</Kbd>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              onClick={onRefresh}
            >
              <RefreshCwIcon className={cn(isFetching && "animate-spin")} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh</TooltipContent>
        </Tooltip>
      </div>

      {/* Rows */}
      <div ref={scroller} className="scroll-panel flex-1 overflow-y-auto pb-safe">
        {isLoading ? (
          <ul className="divide-y">
            {Array.from({ length: 8 }, (_, i) => (
              <li key={i} className="space-y-2 px-4 py-3">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-3 w-28" />
                  <Skeleton className="ml-auto h-3 w-10" />
                </div>
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </li>
            ))}
          </ul>
        ) : threads.length === 0 ? (
          <EmptyState
            folder={view.folder}
            mailboxName={view.mailbox ? (view.mailboxName ?? "this mailbox") : undefined}
            searching={query.trim().length >= 2}
            onCompose={onCompose}
            onShowShortcuts={onShowShortcuts}
          />
        ) : (
          <ul className="divide-y">
            {threads.map((thread) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                self={self}
                density={density}
                selected={thread.id === selectedId}
                checked={checked.has(thread.id)}
                onSelect={() => onSelect(thread)}
                onToggle={(shiftKey) => toggle(thread.id, shiftKey)}
                onToggleStar={() =>
                  onAction(thread.isStarred ? "unstar" : "star", undefined, [thread.id])
                }
                onSwipeArchive={
                  view.folder === "inbox" || view.folder === "archive"
                    ? () => onSwipeArchive(thread.id, view.folder === "archive")
                    : undefined
                }
              />
            ))}
          </ul>
        )}

        <div ref={sentinel} />
        {isLoadingMore && (
          <div className="text-muted-foreground flex items-center justify-center gap-2 py-4 text-xs">
            <LoaderCircleIcon className="size-3.5 animate-spin" /> Loading more
          </div>
        )}
      </div>

      {/* Compose is the primary action, and on a phone the rail that normally
          holds it is behind a drawer — so it gets a thumb-reachable button. */}
      <Button
        onClick={onCompose}
        size="icon"
        className="inset-b-safe fixed right-4 z-30 size-13 rounded-full shadow-lg md:hidden"
        aria-label="Compose"
      >
        <PencilLineIcon className="size-5" />
      </Button>
    </div>
  );
}

/** Past this fraction of the row's width, releasing commits the swipe. */
const SWIPE_COMMIT_RATIO = 0.35;

function ThreadRow({
  thread,
  self,
  density,
  selected,
  checked,
  onSelect,
  onToggle,
  onToggleStar,
  onSwipeArchive,
}: {
  thread: Thread;
  self: string;
  density: "comfortable" | "compact";
  selected: boolean;
  checked: boolean;
  onSelect: () => void;
  onToggle: (shiftKey: boolean) => void;
  onToggleStar: () => void;
  /** Absent in folders where archiving is meaningless (Trash, Drafts…). */
  onSwipeArchive?: () => void;
}) {
  const unread = thread.unreadCount > 0;
  const compact = density === "compact";

  /*
   * Swipe to archive.
   *
   * Tracked with pointer events so it works for touch and pen without a
   * gesture library. Vertical intent wins: if the first movement is mostly
   * up or down the gesture is abandoned, so swiping never fights scrolling.
   */
  const rowRef = useRef<HTMLLIElement>(null);
  const gesture = useRef<{
    x: number;
    y: number;
    axis: "undecided" | "horizontal" | "vertical";
  } | null>(null);

  // The offset lives in a ref, and state only mirrors it for rendering.
  // Pointer events can arrive faster than React re-renders — a quick flick
  // delivers its last move and the release in the same task — so deciding
  // whether the swipe committed must not read a value from a stale closure.
  const offsetRef = useRef(0);
  const [offset, setOffset] = useState(0);

  const swipeable = !!onSwipeArchive;
  const committed = Math.abs(offset) >= (rowRef.current?.offsetWidth ?? 400) * SWIPE_COMMIT_RATIO;

  function onPointerDown(event: React.PointerEvent) {
    if (!swipeable || event.pointerType === "mouse") return;
    gesture.current = { x: event.clientX, y: event.clientY, axis: "undecided" };
  }

  function onPointerMove(event: React.PointerEvent) {
    const start = gesture.current;
    if (!start) return;

    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;

    if (start.axis === "undecided") {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      // Vertical intent wins, so swiping never fights scrolling.
      start.axis = Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
      if (start.axis === "vertical") {
        gesture.current = null;
        return;
      }
    }

    // Resist beyond half the row, so the gesture always feels bounded.
    const width = rowRef.current?.offsetWidth ?? 400;
    const next = Math.max(-width / 2, Math.min(width / 2, dx));
    offsetRef.current = next;
    setOffset(next);
  }

  function endGesture() {
    if (!gesture.current) return;
    const width = rowRef.current?.offsetWidth ?? 400;
    const travelled = Math.abs(offsetRef.current);
    gesture.current = null;
    offsetRef.current = 0;
    setOffset(0);
    if (travelled >= width * SWIPE_COMMIT_RATIO) onSwipeArchive?.();
  }

  return (
    <li
      ref={rowRef}
      data-thread-id={thread.id}
      onClick={() => {
        // A swipe that moved should not also count as a tap.
        if (offsetRef.current === 0 && !gesture.current) onSelect();
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      style={
        offset !== 0
          ? { transform: `translateX(${offset}px)`, transition: "none" }
          : undefined
      }
      className={cn(
        "group relative flex cursor-pointer gap-3 px-3 transition-colors",
        compact ? "py-2" : "py-2.5",
        selected ? "bg-accent" : "hover:bg-accent/50",
        checked && !selected && "bg-muted/60",
        // Comfortable to hit with a thumb.
        "max-md:py-3",
        swipeable && "touch-pan-y",
      )}
    >
      {/* Revealed behind the row while swiping. */}
      {offset !== 0 && (
        <span
          aria-hidden
          className={cn(
            "bg-muted text-muted-foreground absolute inset-y-0 -z-10 flex items-center gap-1.5 px-4 text-[12px] font-medium",
            offset > 0 ? "left-0 -translate-x-full" : "right-0 translate-x-full",
            committed && "text-foreground",
          )}
        >
          <ArchiveIcon className="size-4" />
          {committed ? "Release to archive" : "Archive"}
        </span>
      )}
      {/* Unread marker — a bar, not a dot: it survives at compact density. */}
      <span
        aria-hidden
        className={cn(
          "bg-foreground absolute inset-y-1 left-0 w-0.5 rounded-full transition-opacity",
          unread ? "opacity-100" : "opacity-0",
        )}
      />

      <div
        className="flex items-start pt-0.5"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <Checkbox
          checked={checked}
          onClick={(e) => onToggle(e.shiftKey)}
          aria-label={`Select ${thread.subject || "conversation"}`}
        />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[13px]",
              unread ? "text-foreground font-semibold" : "text-foreground/85",
            )}
          >
            {participantSummary(thread.participants, self)}
            {thread.messageCount > 1 && (
              <span className="text-muted-foreground ml-1.5 font-normal tabular-nums">
                {thread.messageCount}
              </span>
            )}
          </span>

          {/*
            A button, not an ornament. It stays in the layout unstarred but
            invisible until the row is hovered or focused, so a list of
            unstarred mail stays quiet while the target is always in the same
            place — and starred rows keep showing it whatever the pointer does.
          */}
          <button
            type="button"
            onClick={(event) => {
              // The row itself opens the conversation; starring must not.
              event.stopPropagation();
              onToggleStar();
            }}
            aria-label={thread.isStarred ? "Unstar conversation" : "Star conversation"}
            aria-pressed={thread.isStarred}
            className={cn(
              "shrink-0 rounded-sm p-0.5 transition-opacity",
              "focus-visible:ring-ring/40 outline-none focus-visible:ring-2",
              thread.isStarred
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-60 hover:!opacity-100 focus-visible:opacity-100 max-md:opacity-40",
            )}
          >
            <StarIcon
              className={cn(
                "size-3",
                thread.isStarred ? "fill-foreground text-foreground" : "text-muted-foreground",
              )}
            />
          </button>
          {thread.hasAttachments && (
            <PaperclipIcon className="text-muted-foreground size-3 shrink-0" />
          )}
          {thread.snoozedUntil && (
            <ClockIcon className="text-muted-foreground size-3 shrink-0" />
          )}

          <time
            dateTime={new Date(thread.lastMessageAt).toISOString()}
            className="text-muted-foreground shrink-0 text-[11px] tabular-nums"
          >
            {shortDate(thread.lastMessageAt)}
          </time>
        </div>

        <p
          className={cn(
            "truncate text-[13px]",
            unread ? "text-foreground font-medium" : "text-foreground/75",
          )}
        >
          {thread.subject || <span className="italic opacity-60">(no subject)</span>}
        </p>

        {!compact && (
          <p className="text-muted-foreground truncate text-[12px]">{thread.snippet}</p>
        )}

        {thread.labels.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {thread.labels.map((label) => (
              <Badge key={label.id} variant="outline" className="h-4 px-1 text-[10px]">
                {label.name}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

function IconAction({
  label,
  shortcut,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="gap-2">
        {label}
        {shortcut && (
          <Kbd className="bg-primary-foreground/15 text-primary-foreground border-transparent">
            {shortcut}
          </Kbd>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  ClockIcon,
  CornerUpLeftIcon,
  MailIcon,
  ReplyAllIcon,
  ShieldAlertIcon,
  StarIcon,
  TagIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";
import type { SessionInfo } from "@shared/types.ts";
import { api, type ThreadAction } from "@/lib/api.ts";
import { keys, useLabels, useThread } from "@/lib/queries.ts";
import { cn } from "@/lib/utils.ts";
import type { ComposeSeed } from "./composer.tsx";
import { seedReply } from "./mail-app.tsx";
import { MessageCard } from "./message-card.tsx";
import { parseMailto } from "@/lib/mailto.ts";
import { SnoozeMenu } from "./snooze-menu.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";

export function ThreadView({
  threadId,
  session,
  onClose,
  onAction,
  onCompose,
}: {
  threadId: string | null;
  session: SessionInfo;
  onClose: () => void;
  onAction: (action: ThreadAction, until?: number, ids?: string[]) => void;
  onCompose: (seed: ComposeSeed) => void;
}) {
  const client = useQueryClient();
  const thread = useThread(threadId);
  const labels = useLabels();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Opening a conversation expands the newest message and any unread ones —
  // the rest stay collapsed so a 30-message thread is still navigable.
  useEffect(() => {
    if (!thread.data) return;
    const messages = thread.data.messages;
    const next = new Set(
      messages.filter((m) => m.direction === "inbound" && !m.isRead).map((m) => m.id),
    );
    const last = messages[messages.length - 1];
    if (last) next.add(last.id);
    setExpanded(next);
  }, [thread.data?.id, thread.data?.messages.length]);

  if (!threadId) {
    return (
      <div className="bg-rail/40 flex h-full flex-col items-center justify-center gap-3 px-8 text-center max-lg:hidden">
        <MailIcon className="text-muted-foreground/50 size-8" />
        <div>
          <p className="text-[13px] font-medium">No conversation selected</p>
          <p className="text-muted-foreground mt-1 text-[12px]">
            Pick one from the list, or press <Kbd>C</Kbd> to write.
          </p>
        </div>
      </div>
    );
  }

  if (thread.isLoading) {
    return (
      <div className="space-y-6 p-6">
        <Skeleton className="h-6 w-2/3" />
        <div className="space-y-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-11/12" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      </div>
    );
  }

  if (!thread.data) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground text-sm">This conversation is no longer available.</p>
      </div>
    );
  }

  const data = thread.data;
  const latest = data.messages[data.messages.length - 1];
  const appliedLabels = new Set(data.labels.map((l) => l.id));

  async function toggleLabel(labelId: string) {
    const has = appliedLabels.has(labelId);
    await api.setLabels(data.id, has ? [] : [labelId], has ? [labelId] : []);
    client.invalidateQueries({ queryKey: keys.thread(data.id) });
    client.invalidateQueries({ queryKey: keys.labels });
    client.invalidateQueries({ queryKey: ["threads"] });
  }

  return (
    <div className="bg-background flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex h-14 shrink-0 items-center gap-1 border-b px-3 pt-safe max-md:h-auto max-md:py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          className="text-muted-foreground shrink-0 lg:hidden"
          aria-label="Back to list"
        >
          <ArrowLeftIcon />
        </Button>

        <Action label="Archive" shortcut="E" onClick={() => onAction("archive")}>
          <ArchiveIcon />
        </Action>
        {/*
          In Trash there is nowhere further to move a conversation to, so the
          same button means the only thing left it can mean. It is deliberately
          worded as forever: this is the one action in the app with no undo.
        */}
        <Action
          label={data.folder === "trash" ? "Delete forever" : "Move to trash"}
          shortcut="#"
          onClick={() => onAction(data.folder === "trash" ? "delete" : "trash")}
        >
          <Trash2Icon />
        </Action>
        <Action
          label={data.isStarred ? "Unstar" : "Star"}
          shortcut="S"
          onClick={() => onAction(data.isStarred ? "unstar" : "star")}
        >
          <StarIcon className={cn(data.isStarred && "fill-foreground")} />
        </Action>

        <SnoozeMenu onSnooze={(until) => onAction("snooze", until)}>
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground">
            <ClockIcon />
          </Button>
        </SnoozeMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground">
              <TagIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuLabel>Labels</DropdownMenuLabel>
            {(labels.data ?? []).length === 0 && (
              <p className="text-muted-foreground px-2 py-1.5 text-[12px]">
                No labels yet — create one in Settings.
              </p>
            )}
            {labels.data?.map((label) => (
              <DropdownMenuCheckboxItem
                key={label.id}
                checked={appliedLabels.has(label.id)}
                onSelect={(e) => {
                  e.preventDefault();
                  toggleLabel(label.id);
                }}
              >
                {label.name}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <span className="max-sm:hidden">
          <Action label="Report spam" shortcut="!" onClick={() => onAction("spam")}>
            <ShieldAlertIcon />
          </Action>
        </span>

        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onCompose(seedReply(latest, session.defaultFrom, "reply"))}
          >
            <CornerUpLeftIcon /> <span className="max-sm:sr-only">Reply</span>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            onClick={() => onCompose(seedReply(latest, session.defaultFrom, "reply-all"))}
            aria-label="Reply all"
          >
            <ReplyAllIcon />
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="scroll-panel flex-1 overflow-y-auto pb-safe">
        <div className="mx-auto max-w-3xl px-6 py-6 max-md:px-4 max-md:py-4">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <h1 className="text-lg leading-snug font-semibold tracking-tight">
              {data.subject || <span className="italic opacity-60">(no subject)</span>}
            </h1>
            {data.labels.map((label) => (
              <Badge key={label.id} variant="outline" className="h-5">
                {label.name}
              </Badge>
            ))}
          </div>
          <p className="text-muted-foreground mb-5 text-[12px]">
            {data.messageCount} message{data.messageCount === 1 ? "" : "s"}
            {data.snoozedUntil && data.snoozedUntil > Date.now() && (
              <> · snoozed until {new Date(data.snoozedUntil).toLocaleString()}</>
            )}
          </p>

          <Separator className="mb-1" />

          <div className="divide-y">
            {data.messages.map((message) => (
              <MessageCard
                key={message.id}
                message={message}
                self={session.defaultFrom}
                expanded={expanded.has(message.id)}
                onToggle={() =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(message.id)) next.delete(message.id);
                    else next.add(message.id);
                    return next;
                  })
                }
                onReply={(mode) => onCompose(seedReply(message, session.defaultFrom, mode))}
                onMailto={(href) => {
                  const seed = parseMailto(href);
                  if (seed) onCompose({ ...seed, from: session.defaultFrom });
                }}
                onEditDraft={() =>
                  onCompose({
                    mode: "edit",
                    id: message.id,
                    from: message.from.address,
                    to: message.to,
                    cc: message.cc,
                    bcc: message.bcc,
                    subject: message.subject,
                    body: message.bodyText ?? "",
                    threadId: message.threadId,
                  })
                }
                onCancelSchedule={async () => {
                  await api.cancelScheduled(message.id);
                  client.invalidateQueries({ queryKey: keys.thread(data.id) });
                  client.invalidateQueries({ queryKey: ["threads"] });
                  toast.success("Moved back to Drafts");
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Action({
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

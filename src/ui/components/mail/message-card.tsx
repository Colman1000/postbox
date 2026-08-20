import { useMemo, useState } from "react";
import {
  AlertCircleIcon,
  ChevronDownIcon,
  ClockIcon,
  CornerUpLeftIcon,
  CornerUpRightIcon,
  DownloadIcon,
  ImageOffIcon,
  PencilIcon,
  ReplyAllIcon,
  ShieldCheckIcon,
  ShieldQuestionIcon,
  XIcon,
} from "lucide-react";
import type { Message } from "@shared/types.ts";
import { api } from "@/lib/api.ts";
import { mailtoFromClick } from "@/lib/mailto.ts";
import { displayName, fileSize, fullDate, initials, shortDate } from "@/lib/format.ts";
import { renderPlainText, sanitizeEmailHtml } from "@/lib/sanitize.ts";
import { cn } from "@/lib/utils.ts";
import { Avatar, AvatarFallback } from "@/components/ui/avatar.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip.tsx";

/**
 * One message inside a conversation.
 *
 * Collapsed by default unless it is the newest or unread, so long threads read
 * top-to-bottom without a wall of quoted text.
 */
export function MessageCard({
  message,
  self,
  expanded,
  onToggle,
  onReply,
  onEditDraft,
  onCancelSchedule,
  onMailto,
}: {
  message: Message;
  self: string;
  expanded: boolean;
  onToggle: () => void;
  onReply: (mode: "reply" | "reply-all" | "forward") => void;
  onEditDraft: () => void;
  onCancelSchedule: () => void;
  /** A `mailto:` link in the message body, handed back to the app. */
  onMailto: (href: string) => void;
}) {
  const [showImages, setShowImages] = useState(false);

  const inlineImages = useMemo(() => {
    const map = new Map<string, string>();
    for (const attachment of message.attachments) {
      if (attachment.contentId) {
        map.set(attachment.contentId.replace(/^<|>$/g, ""), api.attachmentUrl(attachment.id));
      }
    }
    return map;
  }, [message.attachments]);

  const rendered = useMemo(() => {
    if (message.bodyHtml)
      return sanitizeEmailHtml(message.bodyHtml, { showImages, inlineImages });
    if (message.bodyText) return { html: renderPlainText(message.bodyText), blockedImages: 0 };
    return { html: "", blockedImages: 0 };
  }, [message.bodyHtml, message.bodyText, showImages, inlineImages]);

  const isDraft = message.status === "draft" || message.status === "failed";
  const isScheduled = message.status === "scheduled";
  const attachments = message.attachments.filter((a) => !a.isInline);

  return (
    <article className={cn("py-4", !expanded && "cursor-pointer")} onClick={!expanded ? onToggle : undefined}>
      {/* Header */}
      <header className="flex items-start gap-3">
        <Avatar className="mt-0.5 size-7 shrink-0">
          <AvatarFallback>{initials(message.from)}</AvatarFallback>
        </Avatar>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[13px] font-semibold">
              {displayName(message.from)}
            </span>
            {message.direction === "inbound" && <TrustBadge message={message} />}
            {isDraft && (
              <Badge variant="outline" className="h-4">
                {message.status === "failed" ? "Not sent" : "Draft"}
              </Badge>
            )}
            {isScheduled && message.scheduledAt && (
              <Badge variant="outline" className="h-4 gap-1">
                <ClockIcon className="size-2.5" />
                {shortDate(message.scheduledAt)}
              </Badge>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <time
                  dateTime={new Date(message.createdAt).toISOString()}
                  className="text-muted-foreground ml-auto shrink-0 text-[11px] tabular-nums"
                >
                  {shortDate(message.createdAt)}
                </time>
              </TooltipTrigger>
              <TooltipContent>{fullDate(message.createdAt)}</TooltipContent>
            </Tooltip>

            {expanded && (
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground -mr-1"
                onClick={onToggle}
                aria-label="Collapse message"
              >
                <ChevronDownIcon className="rotate-180" />
              </Button>
            )}
          </div>

          <p className="text-muted-foreground truncate text-[11px]">
            {expanded ? (
              <>
                <span className="font-mono">{message.from.address}</span>
                {message.to.length > 0 && (
                  <> · to {message.to.map((a) => displayName(a)).join(", ")}</>
                )}
                {message.cc.length > 0 && (
                  <> · cc {message.cc.map((a) => displayName(a)).join(", ")}</>
                )}
              </>
            ) : (
              message.snippet
            )}
          </p>
        </div>
      </header>

      {!expanded ? null : (
        <div className="mt-3 pl-10 max-sm:pl-0">
          {message.error && (
            <div className="bg-muted mb-3 flex items-start gap-2 rounded-md p-3 text-[12px] leading-relaxed">
              <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
              <div>
                <p className="font-medium">This message was not sent.</p>
                <p className="text-muted-foreground mt-0.5">{message.error}</p>
              </div>
            </div>
          )}

          {rendered.blockedImages > 0 && (
            <div className="bg-muted mb-3 flex items-center gap-2 rounded-md px-3 py-2 text-[12px]">
              <ImageOffIcon className="size-3.5 shrink-0" />
              <span className="text-muted-foreground">
                {rendered.blockedImages} remote image
                {rendered.blockedImages === 1 ? "" : "s"} blocked — they can report that you
                opened this.
              </span>
              <Button size="xs" variant="secondary" className="ml-auto" onClick={() => setShowImages(true)}>
                Show
              </Button>
            </div>
          )}

          {rendered.html ? (
            <div
              className="mail-body"
              // A mail client that hands its own mailto: links to the operating
              // system is not really your mail client. Caught here, at the
              // container, because the click usually lands on something inside
              // the anchor rather than the anchor itself.
              onClick={(event) => {
                const href = mailtoFromClick(event);
                if (!href) return;
                event.preventDefault();
                onMailto(href);
              }}
              // Sanitised in sanitizeEmailHtml: scripts, handlers, styles and
              // unknown URL schemes are removed before this point.
              dangerouslySetInnerHTML={{ __html: rendered.html }}
            />
          ) : (
            <p className="text-muted-foreground text-[13px] italic">No content.</p>
          )}

          {attachments.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {attachments.map((attachment) => (
                <a
                  key={attachment.id}
                  href={api.attachmentUrl(attachment.id)}
                  download={attachment.filename}
                  className="group hover:bg-accent flex items-center gap-2 rounded-md border px-2.5 py-1.5 transition-colors"
                >
                  <DownloadIcon className="text-muted-foreground size-3.5" />
                  <span className="max-w-[14rem] truncate text-[12px] font-medium">
                    {attachment.filename}
                  </span>
                  <span className="text-muted-foreground text-[11px] tabular-nums">
                    {fileSize(attachment.size)}
                  </span>
                </a>
              ))}
            </div>
          )}

          {/* Per-message actions */}
          <div className="mt-4 flex flex-wrap items-center gap-1.5">
            {isDraft ? (
              <Button size="sm" variant="outline" onClick={onEditDraft}>
                <PencilIcon /> Continue editing
              </Button>
            ) : isScheduled ? (
              <Button size="sm" variant="outline" onClick={onCancelSchedule}>
                <XIcon /> Cancel scheduled send
              </Button>
            ) : (
              <>
                <Button size="sm" variant="outline" onClick={() => onReply("reply")}>
                  <CornerUpLeftIcon /> Reply
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onReply("reply-all")}>
                  <ReplyAllIcon /> Reply all
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onReply("forward")}>
                  <CornerUpRightIcon /> Forward
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

/**
 * SPF / DKIM / DMARC, surfaced rather than buried.
 *
 * "Did this really come from who it says" is the question a mail client should
 * always be able to answer, and it is the one most clients hide three menus deep.
 */
function TrustBadge({ message }: { message: Message }) {
  const { spf, dkim, dmarc } = message.auth;
  const verdicts = [spf, dkim, dmarc];
  const passes = verdicts.filter((v) => v === "pass").length;
  const fails = verdicts.filter((v) => v && v !== "pass" && v !== "none").length;

  if (passes === 0 && fails === 0) return null;

  const trusted = fails === 0 && passes > 0;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex shrink-0 items-center",
            trusted ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {trusted ? (
            <ShieldCheckIcon className="size-3.5" />
          ) : (
            <ShieldQuestionIcon className="size-3.5" />
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        <span className="font-mono text-[10px]">
          SPF {spf ?? "—"} · DKIM {dkim ?? "—"} · DMARC {dmarc ?? "—"}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

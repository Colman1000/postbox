import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  ClockIcon,
  EyeIcon,
  FileTextIcon,
  LoaderCircleIcon,
  Maximize2Icon,
  Minimize2Icon,
  PaperclipIcon,
  PencilIcon,
  SendIcon,
  SquareCodeIcon,
  Trash2Icon,
  TypeIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import type { Address, AttachmentMeta, SessionInfo } from "@shared/types.ts";
import { MAX_ATTACHMENT_BYTES } from "@shared/types.ts";
import { api, ApiError, UploadCancelled } from "@/lib/api.ts";
import { fileSize } from "@/lib/format.ts";
import { markdownToHtml } from "@/lib/markdown.ts";
import { refreshAfterSend, useIdentities, useTemplates } from "@/lib/queries.ts";
import { cn } from "@/lib/utils.ts";
import { RecipientInput } from "./recipient-input.tsx";
import { RichTextEditor } from "./rich-text-editor.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Progress } from "@/components/ui/progress.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";

/** How long "Sending…" stays undoable before the request actually goes out. */
const UNDO_WINDOW_MS = 8000;

/**
 * How the body is being edited.
 *
 * `rich` is the default and what almost everyone will ever see: buttons for
 * bold, lists and links. `markdown` is the same document with the formatting
 * written out in full — the fallback for people who prefer it, and the escape
 * hatch when the visual editor gets something wrong. `preview` is neither, and
 * shows the message as the recipient will receive it.
 */
type View = "rich" | "markdown" | "preview";

/** A file on its way to the draft. */
interface Upload {
  id: string;
  filename: string;
  size: number;
  /** 0–1, as reported by the browser. */
  progress: number;
  cancel: () => void;
}

const VIEW_KEY = "postbox:composer-view";

export interface ComposeSeed {
  mode: "new" | "reply" | "reply-all" | "forward" | "edit";
  id?: string;
  from?: string;
  to?: Address[];
  cc?: Address[];
  bcc?: Address[];
  subject?: string;
  body?: string;
  inReplyTo?: string;
  threadId?: string;
}

export function Composer({
  seed,
  session,
  onClose,
  onSent,
}: {
  seed: ComposeSeed;
  session: SessionInfo;
  onClose: () => void;
  onSent: (threadId?: string) => void;
}) {
  const client = useQueryClient();
  const identities = useIdentities();
  const templates = useTemplates();

  const [from, setFrom] = useState(seed.from ?? session.defaultFrom);
  const [to, setTo] = useState<Address[]>(seed.to ?? []);
  const [cc, setCc] = useState<Address[]>(seed.cc ?? []);
  const [bcc, setBcc] = useState<Address[]>(seed.bcc ?? []);
  const [subject, setSubject] = useState(seed.subject ?? "");
  const [body, setBody] = useState(seed.body ?? "");
  const [attachments, setAttachments] = useState<AttachmentMeta[]>([]);
  const [uploads, setUploads] = useState<Upload[]>([]);

  const [showCc, setShowCc] = useState((seed.cc?.length ?? 0) > 0 || (seed.bcc?.length ?? 0) > 0);
  const [fullscreen, setFullscreen] = useState(false);
  const [view, setView] = useState<View>(() =>
    localStorage.getItem(VIEW_KEY) === "markdown" ? "markdown" : "rich",
  );
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<number | null>(null);
  const [scheduleAt, setScheduleAt] = useState("");

  const draftId = useRef<string | undefined>(seed.id);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  /** Where the eye button goes back to, and the choice that is remembered. */
  const editView = useRef<Exclude<View, "preview">>(view === "markdown" ? "markdown" : "rich");
  const fileRef = useRef<HTMLInputElement>(null);
  const dirty = useRef(false);

  const recipientCount = to.length + cc.length + bcc.length;
  // Sending mid-upload would send the message without the file, which is the
  // one outcome nobody wants from having attached it.
  const canSend = recipientCount > 0 && !busy && uploads.length === 0;

  useEffect(() => {
    if (view === "preview") return;
    editView.current = view;
    localStorage.setItem(VIEW_KEY, view);
  }, [view]);

  // ── an existing draft's attachments ───────────────────────────────────────

  /**
   * Reopening a draft has to bring its attachments with it.
   *
   * They are stored against the draft rather than held in the composer, so
   * they were always sent — but an empty attachment bar says the opposite,
   * and there was no way to take one off again. Only the files are fetched:
   * everything else about the draft is already in the seed.
   */
  useEffect(() => {
    const id = seed.id;
    if (!id) return;
    let cancelled = false;
    api
      .draft(id)
      .then((message) => {
        if (!cancelled) setAttachments(message.attachments ?? []);
      })
      .catch(() => {
        // The draft opens either way; the files are still attached to it.
      });
    return () => {
      cancelled = true;
    };
  }, [seed.id]);

  // ── autosave ──────────────────────────────────────────────────────────────

  const payload = useMemo(
    () => ({
      id: draftId.current,
      from,
      to,
      cc,
      bcc,
      subject,
      body,
      inReplyTo: seed.inReplyTo,
      threadId: seed.threadId,
    }),
    [from, to, cc, bcc, subject, body, seed.inReplyTo, seed.threadId],
  );

  const persist = useCallback(async () => {
    if (!dirty.current) return;
    // An entirely empty composer is not worth a row in Drafts.
    if (recipientCount === 0 && !subject.trim() && !body.trim()) return;
    try {
      const result = await api.saveDraft({ ...payload, id: draftId.current });
      draftId.current = result.id;
      dirty.current = false;
      setSaved(result.updatedAt);
    } catch {
      // Autosave failing is not worth interrupting the writer over; the
      // explicit Send path reports its own errors.
    }
  }, [payload, recipientCount, subject, body]);

  useEffect(() => {
    dirty.current = true;
    const timer = setTimeout(persist, 1200);
    return () => clearTimeout(timer);
  }, [persist]);

  // ── send ──────────────────────────────────────────────────────────────────

  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dispatch = useCallback(
    async (at?: number) => {
      try {
        const result = await api.send({
          ...payload,
          id: draftId.current,
          scheduledAt: at,
        });
        refreshAfterSend(client, result.threadId);
        if (at) {
          toast.success(`Scheduled for ${new Date(at).toLocaleString()}`);
        } else {
          toast.success("Sent");
        }
        return result.threadId;
      } catch (error) {
        const message =
          error instanceof ApiError ? error.message : "The message could not be sent.";
        toast.error(message, {
          description: "It is saved in Drafts — nothing was lost.",
          duration: 10_000,
        });
        refreshAfterSend(client);
        return undefined;
      }
    },
    [payload, client],
  );

  const send = useCallback(
    async (at?: number) => {
      if (recipientCount === 0) {
        toast.error("Add at least one recipient.");
        return;
      }
      if (uploads.length > 0) {
        toast.error("A file is still uploading.", {
          description: "Sending now would leave it behind.",
        });
        return;
      }
      setBusy(true);
      await persist();

      if (at) {
        const threadId = await dispatch(at);
        setBusy(false);
        onSent(threadId);
        return;
      }

      // Close immediately and hold the actual request for the undo window —
      // this is the whole point of "Undo send": it has to feel instant.
      onSent(seed.threadId);

      const snapshot = { ...payload, id: draftId.current };
      pending.current = setTimeout(async () => {
        pending.current = null;
        sessionStorage.removeItem("postbox:pending-send");
        await dispatch();
      }, UNDO_WINDOW_MS);

      // Recorded so a reload or tab close still delivers rather than dropping it.
      sessionStorage.setItem("postbox:pending-send", JSON.stringify(snapshot));

      toast("Sending…", {
        duration: UNDO_WINDOW_MS,
        action: {
          label: "Undo",
          onClick: () => {
            if (pending.current) clearTimeout(pending.current);
            pending.current = null;
            sessionStorage.removeItem("postbox:pending-send");
            toast.success("Send cancelled — the draft is intact.");
            refreshAfterSend(client);
          },
        },
      });
    },
    [recipientCount, uploads.length, persist, dispatch, onSent, payload, seed.threadId, client],
  );

  // If the tab goes away mid-undo, flush the send with a beacon rather than
  // losing it. Same endpoint, same payload, no response needed.
  useEffect(() => {
    function flush() {
      const stored = sessionStorage.getItem("postbox:pending-send");
      if (!stored || !pending.current) return;
      clearTimeout(pending.current);
      pending.current = null;
      navigator.sendBeacon(
        "/api/send",
        new Blob([stored], { type: "application/json" }),
      );
      sessionStorage.removeItem("postbox:pending-send");
    }
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  // ── attachments ───────────────────────────────────────────────────────────

  const attach = useCallback(
    async (files: FileList | File[]) => {
      const chosen = Array.from(files);
      if (chosen.length === 0) return;

      dirty.current = true;
      await persist();
      if (!draftId.current) {
        // persist() bails on a wholly empty composer; force one so the upload
        // has something to hang off.
        const result = await api.saveDraft({ ...payload, subject: subject || "" });
        draftId.current = result.id;
      }

      // Counted here as well as on the server, so a file that could never be
      // accepted is refused before it is uploaded rather than after.
      let used = attachments.reduce((total, attachment) => total + attachment.size, 0);

      for (const file of chosen) {
        if (used + file.size > MAX_ATTACHMENT_BYTES) {
          toast.error(`${file.name} does not fit.`, {
            description: `A message can carry ${fileSize(MAX_ATTACHMENT_BYTES)} of attachments in total. Link to the file instead.`,
          });
          continue;
        }
        used += file.size;

        const id = crypto.randomUUID();
        const controller = new AbortController();
        setUploads((current) => [
          ...current,
          {
            id,
            filename: file.name || "attachment",
            size: file.size,
            progress: 0,
            cancel: () => controller.abort(),
          },
        ]);

        try {
          const meta = await api.uploadAttachment(draftId.current!, file, {
            signal: controller.signal,
            onProgress: (fraction) =>
              setUploads((current) =>
                current.map((upload) =>
                  upload.id === id ? { ...upload, progress: fraction } : upload,
                ),
              ),
          });
          setAttachments((current) => [...current, { ...meta, isInline: false }]);
        } catch (error) {
          used -= file.size;
          // A cancelled upload is a decision, not a failure.
          if (error instanceof UploadCancelled) continue;
          toast.error(
            error instanceof ApiError ? error.message : `Could not attach ${file.name}`,
          );
        } finally {
          setUploads((current) => current.filter((upload) => upload.id !== id));
        }
      }
    },
    [persist, payload, subject, attachments],
  );

  // ── keyboard ──────────────────────────────────────────────────────────────

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key === "Enter") {
        event.preventDefault();
        if (event.shiftKey) document.getElementById("postbox-schedule")?.click();
        else void send();
      }
      if (mod && event.shiftKey && event.key.toLowerCase() === "m") {
        event.preventDefault();
        setView((current) => (current === "markdown" ? "rich" : "markdown"));
      }
      if (event.key === "Escape" && !fullscreen) {
        const target = event.target as HTMLElement | null;
        if (target?.closest("[data-radix-popper-content-wrapper]")) return;
        event.preventDefault();
        void persist().then(onClose);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [send, persist, onClose, fullscreen]);

  // Rendered with the same Markdown settings the Worker sends with, so the
  // preview is a preview rather than an approximation.
  const previewHtml = useMemo(
    () => (view === "preview" ? markdownToHtml(body) : ""),
    [view, body],
  );

  return (
    <div
      className={cn(
        "bg-popover fixed z-40 flex flex-col overflow-hidden shadow-2xl",
        // Mobile first, deliberately: a docked panel on a phone is just a
        // smaller phone screen, so compose owns the viewport there. The desktop
        // variants are layered on at `md` rather than fighting `inset-0` with
        // an override, which is what silently breaks when both apply at once.
        "inset-0 pt-safe pb-safe",
        fullscreen
          ? "md:inset-4 md:rounded-xl md:border lg:inset-10"
          : [
              "md:inset-auto md:right-4 md:bottom-4",
              "md:h-[32rem] md:w-[min(38rem,calc(100vw-2rem))]",
              "md:rounded-xl md:border md:pt-0 md:pb-0",
            ],
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length > 0) void attach(e.dataTransfer.files);
      }}
    >
      {/* Title bar */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <span className="flex-1 truncate text-[12px] font-medium">
          {seed.mode === "forward"
            ? "Forward"
            : seed.mode.startsWith("reply")
              ? "Reply"
              : seed.mode === "edit"
                ? "Edit draft"
                : "New message"}
          {saved && (
            <span className="text-muted-foreground ml-2 font-normal">Saved</span>
          )}
        </span>

        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground max-md:hidden"
          onClick={() => setFullscreen((v) => !v)}
          aria-label={fullscreen ? "Exit full screen" : "Full screen"}
        >
          {fullscreen ? <Minimize2Icon /> : <Maximize2Icon />}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          onClick={() => void persist().then(onClose)}
          aria-label="Close"
        >
          <XIcon />
        </Button>
      </div>

      {/* Headers */}
      <div className="shrink-0">
        <div className="flex items-center gap-2 border-b px-3 py-1.5">
          <span className="text-muted-foreground w-9 shrink-0 text-[12px]">From</span>
          <Select value={from} onValueChange={setFrom}>
            <SelectTrigger size="sm" className="h-7 border-0 px-1 text-[13px] shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(identities.data ?? []).map((identity) => (
                <SelectItem key={identity.id} value={identity.address}>
                  {identity.name ? `${identity.name} · ${identity.address}` : identity.address}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {!showCc && (
            <button
              type="button"
              onClick={() => setShowCc(true)}
              className="text-muted-foreground hover:text-foreground ml-auto text-[11px]"
            >
              Cc / Bcc
            </button>
          )}
        </div>

        <RecipientInput
          label="To"
          value={to}
          onChange={setTo}
          autoFocus={seed.mode === "new" || seed.mode === "forward"}
          placeholder="name@example.com"
        />
        {showCc && (
          <>
            <RecipientInput label="Cc" value={cc} onChange={setCc} />
            <RecipientInput label="Bcc" value={bcc} onChange={setBcc} />
          </>
        )}

        <div className="flex items-center gap-2 border-b px-3 py-1.5">
          <span className="text-muted-foreground w-9 shrink-0 text-[12px]">Subj</span>
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            className="h-7 border-0 px-1 text-[13px] shadow-none focus-visible:ring-0"
          />
        </div>
      </div>

      {/* Body */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {view === "preview" && (
          <div
            className="mail-body scroll-panel h-full overflow-y-auto px-4 py-3"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        )}

        {view === "rich" && (
          <RichTextEditor
            value={body}
            onChange={setBody}
            placeholder="Write your message…"
            autoFocus={seed.mode !== "new" && seed.mode !== "forward"}
            onSwitchToMarkdown={() => setView("markdown")}
          />
        )}

        {view === "markdown" && (
          <>
            <div className="text-muted-foreground flex h-9 shrink-0 items-center gap-2 border-b px-3 text-[11px]">
              <SquareCodeIcon className="size-3.5 shrink-0" />
              <span className="truncate">Markdown source</span>
              <Button
                variant="ghost"
                size="xs"
                className="text-muted-foreground ml-auto shrink-0 gap-1"
                onClick={() => setView("rich")}
              >
                <TypeIcon /> Rich text
                <Kbd className="ml-1">⌘⇧M</Kbd>
              </Button>
            </div>
            <Textarea
              ref={bodyRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              autoFocus={seed.mode !== "new" && seed.mode !== "forward"}
              placeholder="Write your message. Markdown works — **bold**, [links](https://…), lists."
              className="min-h-0 flex-1 resize-none rounded-none border-0 px-4 py-3 font-mono text-[12px] leading-relaxed shadow-none focus-visible:ring-0"
            />
          </>
        )}

        {dragging && (
          <div className="bg-popover/90 pointer-events-none absolute inset-0 flex items-center justify-center border-2 border-dashed">
            <p className="text-[13px] font-medium">Drop to attach</p>
          </div>
        )}
      </div>

      {/* Attachments */}
      {(attachments.length > 0 || uploads.length > 0) && (
        <div className="flex shrink-0 flex-wrap gap-1.5 border-t px-3 py-2">
          {attachments.map((attachment) => (
            <span
              key={attachment.id}
              className="bg-muted flex h-6 items-center gap-1.5 rounded-md pr-1 pl-2 text-[11px]"
            >
              <span className="max-w-[12rem] truncate">{attachment.filename}</span>
              <span className="text-muted-foreground tabular-nums">
                {fileSize(attachment.size)}
              </span>
              <button
                type="button"
                onClick={async () => {
                  await api.removeAttachment(attachment.id);
                  setAttachments((c) => c.filter((a) => a.id !== attachment.id));
                }}
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${attachment.filename}`}
              >
                <XIcon className="size-3" />
              </button>
            </span>
          ))}

          {/* Still arriving. Bytes rather than a percentage: on a slow
              connection "1.2 MB of 6.4 MB" answers "is it moving?" and "how
              much longer?" at the same time. */}
          {uploads.map((upload) => (
            <span
              key={upload.id}
              className="bg-muted flex h-6 items-center gap-1.5 rounded-md pr-1 pl-2 text-[11px]"
            >
              <LoaderCircleIcon className="text-muted-foreground size-3 animate-spin" />
              <span className="max-w-[10rem] truncate">{upload.filename}</span>
              <span className="text-muted-foreground tabular-nums">
                {fileSize(Math.round(upload.size * upload.progress))} of {fileSize(upload.size)}
              </span>
              <Progress
                // Rounded, not just for the eye: a fractional value reads as
                // "indeterminate" to the progress bar, which is what a screen
                // reader would then announce.
                value={Math.round(upload.progress * 100)}
                aria-label={`Uploading ${upload.filename}`}
                className="h-1 w-12"
              />
              <button
                type="button"
                onClick={upload.cancel}
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Stop uploading ${upload.filename}`}
              >
                <XIcon className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Footer */}
      <div className="flex h-12 shrink-0 items-center gap-1 border-t px-3 max-md:h-14">
        <Button onClick={() => void send()} disabled={!canSend} size="sm" className="gap-1.5">
          {busy ? <LoaderCircleIcon className="animate-spin" /> : <SendIcon />}
          Send
          <Kbd className="bg-primary-foreground/15 text-primary-foreground ml-1 border-transparent">
            ⌘⏎
          </Kbd>
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              id="postbox-schedule"
              variant="outline"
              size="icon-sm"
              disabled={!canSend}
              aria-label="Send later"
            >
              <ClockIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel>Send later</DropdownMenuLabel>
            {schedulePresets().map((preset) => (
              <DropdownMenuItem key={preset.label} onSelect={() => void send(preset.at())}>
                {preset.label}
                <span className="text-muted-foreground ml-auto text-[11px]">
                  {preset.detail}
                </span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <div className="flex items-center gap-1.5 p-1.5" onKeyDown={(e) => e.stopPropagation()}>
              <Input
                type="datetime-local"
                value={scheduleAt}
                onChange={(e) => setScheduleAt(e.target.value)}
                className="h-7 flex-1 text-[11px]"
              />
              <Button
                size="xs"
                disabled={!scheduleAt}
                onClick={() => {
                  const at = new Date(scheduleAt).getTime();
                  if (Number.isFinite(at) && at > Date.now() + 30_000) void send(at);
                  else toast.error("Pick a time at least a minute from now.");
                }}
              >
                Set
              </Button>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>

        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            // Copied out before the input is reset: `e.target.files` is live,
            // and clearing the value empties the very list `attach` is about
            // to read once its first `await` resolves. Dropping files worked
            // and picking them did nothing, for exactly this reason.
            const picked = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (picked.length > 0) void attach(picked);
          }}
        />

        <FooterIcon label="Attach a file" onClick={() => fileRef.current?.click()}>
          <PaperclipIcon />
        </FooterIcon>

        <FooterIcon
          label={view === "preview" ? "Back to editing" : "Preview as the recipient sees it"}
          onClick={() => setView(view === "preview" ? editView.current : "preview")}
        >
          {view === "preview" ? <PencilIcon /> : <EyeIcon />}
        </FooterIcon>

        {(templates.data?.length ?? 0) > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="text-muted-foreground">
                <FileTextIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel>Templates</DropdownMenuLabel>
              {templates.data?.map((template) => (
                <DropdownMenuItem
                  key={template.id}
                  onSelect={() => {
                    if (template.subject && !subject) setSubject(template.subject);
                    setBody((current) => (current ? `${template.body}\n\n${current}` : template.body));
                  }}
                >
                  {template.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <div className="ml-auto">
          <FooterIcon
            label="Discard draft"
            onClick={async () => {
              if (draftId.current) await api.deleteDraft(draftId.current).catch(() => {});
              refreshAfterSend(client);
              toast.success("Draft discarded");
              onClose();
            }}
          >
            <Trash2Icon />
          </FooterIcon>
        </div>
      </div>
    </div>
  );
}

function FooterIcon({
  label,
  onClick,
  children,
}: {
  label: string;
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
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function schedulePresets() {
  const at = (hours: number, hour?: number) => () => {
    const date = new Date();
    if (hour === undefined) return date.getTime() + hours * 3600_000;
    date.setDate(date.getDate() + hours);
    date.setHours(hour, 0, 0, 0);
    return date.getTime();
  };

  return [
    { label: "In an hour", detail: "", at: at(1) },
    { label: "This evening", detail: "18:00", at: at(0, 18) },
    { label: "Tomorrow morning", detail: "08:00", at: at(1, 8) },
    { label: "Monday morning", detail: "08:00", at: () => {
      const date = new Date();
      date.setDate(date.getDate() + ((1 - date.getDay() + 7) % 7 || 7));
      date.setHours(8, 0, 0, 0);
      return date.getTime();
    } },
  ];
}

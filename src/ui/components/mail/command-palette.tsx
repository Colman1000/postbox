import { useEffect, useState } from "react";
import {
  ArchiveIcon,
  AtSignIcon,
  ClockIcon,
  FileTextIcon,
  InboxIcon,
  CircleQuestionMarkIcon,
  KeyboardIcon,
  MailIcon,
  PencilLineIcon,
  SendIcon,
  SettingsIcon,
  ShieldAlertIcon,
  StarIcon,
  Trash2Icon,
} from "lucide-react";
import { useMailboxes, useSearch } from "@/lib/queries.ts";
import { participantSummary, shortDate } from "@/lib/format.ts";
import type { MailView } from "./mail-app.tsx";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command.tsx";

/**
 * ⌘K.
 *
 * Doubles as search: type two characters and conversations appear below the
 * commands, so one keystroke covers both "go somewhere" and "find something".
 */
export function CommandPalette({
  open,
  onOpenChange,
  onNavigate,
  onCompose,
  onOpenSettings,
  onShowShortcuts,
  onShowHelp,
  onOpenThread,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (view: MailView) => void;
  onCompose: () => void;
  onOpenSettings: () => void;
  onShowShortcuts: () => void;
  onShowHelp: () => void;
  onOpenThread: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const results = useSearch(debounced);
  const mailboxes = useMailboxes();

  function run(action: () => void) {
    onOpenChange(false);
    action();
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} shouldFilter={debounced.length < 2}>
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Search mail, or jump to…"
      />
      <CommandList>
        <CommandEmpty>Nothing matched.</CommandEmpty>

        {debounced.length >= 2 && (results.data?.items.length ?? 0) > 0 && (
          <>
            <CommandGroup heading="Conversations">
              {results.data?.items.slice(0, 8).map((thread) => (
                <CommandItem
                  key={thread.id}
                  value={`thread-${thread.id}`}
                  onSelect={() => run(() => onOpenThread(thread.id))}
                >
                  <MailIcon />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px]">{thread.subject || "(no subject)"}</p>
                    <p className="text-muted-foreground truncate text-[11px]">
                      {participantSummary(thread.participants, "")} · {thread.snippet}
                    </p>
                  </div>
                  <CommandShortcut>{shortDate(thread.lastMessageAt)}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        <CommandGroup heading="Actions">
          <CommandItem onSelect={() => run(onCompose)}>
            <PencilLineIcon /> Compose <CommandShortcut>C</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => run(onOpenSettings)}>
            <SettingsIcon /> Settings
          </CommandItem>
          <CommandItem onSelect={() => run(onShowShortcuts)}>
            <KeyboardIcon /> Keyboard shortcuts <CommandShortcut>?</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => run(onShowHelp)}>
            <CircleQuestionMarkIcon /> Help
          </CommandItem>
        </CommandGroup>

        {(mailboxes.data?.length ?? 0) > 0 && (
          <CommandGroup heading="Mailboxes">
            {mailboxes.data?.map((mailbox) => (
              <CommandItem
                key={mailbox.id}
                value={`mailbox ${mailbox.name ?? ""} ${mailbox.address}`}
                onSelect={() =>
                  run(() =>
                    onNavigate({
                      folder: "inbox",
                      mailbox: mailbox.id,
                      mailboxName: mailbox.name || mailbox.address,
                    }),
                  )
                }
              >
                <AtSignIcon /> {mailbox.name || mailbox.address.split("@")[0]}
                <CommandShortcut>
                  {mailbox.unread > 0 ? `${mailbox.unread} unread` : mailbox.address}
                </CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandGroup heading="Go to">
          <CommandItem onSelect={() => run(() => onNavigate({ folder: "inbox" }))}>
            <InboxIcon /> Inbox <CommandShortcut>G I</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => run(() => onNavigate({ folder: "inbox", starred: true }))}>
            <StarIcon /> Starred
          </CommandItem>
          <CommandItem onSelect={() => run(() => onNavigate({ folder: "sent" }))}>
            <SendIcon /> Sent <CommandShortcut>G S</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => run(() => onNavigate({ folder: "drafts" }))}>
            <FileTextIcon /> Drafts <CommandShortcut>G D</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => run(() => onNavigate({ folder: "scheduled" }))}>
            <ClockIcon /> Scheduled <CommandShortcut>G E</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => run(() => onNavigate({ folder: "archive" }))}>
            <ArchiveIcon /> Archive <CommandShortcut>G A</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => run(() => onNavigate({ folder: "spam" }))}>
            <ShieldAlertIcon /> Spam
          </CommandItem>
          <CommandItem onSelect={() => run(() => onNavigate({ folder: "trash" }))}>
            <Trash2Icon /> Trash <CommandShortcut>G T</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

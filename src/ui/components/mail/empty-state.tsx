import {
  ArchiveIcon,
  AtSignIcon,
  ClockIcon,
  FileTextIcon,
  InboxIcon,
  SearchXIcon,
  SendIcon,
  ShieldAlertIcon,
  Trash2Icon,
} from "lucide-react";
import type { Folder } from "@shared/types.ts";
import { Kbd } from "@/components/ui/kbd.tsx";

/**
 * Empty is a state, not an error.
 *
 * Each message says what would put something here, so a new mailbox explains
 * itself instead of just looking broken.
 */
const COPY: Record<Folder, { icon: typeof InboxIcon; title: string; body: string }> = {
  inbox: {
    icon: InboxIcon,
    title: "Inbox zero",
    body: "Every address on your domain lands here — no aliases to configure first.",
  },
  sent: {
    icon: SendIcon,
    title: "Nothing sent yet",
    body: "Press C to write your first message.",
  },
  drafts: {
    icon: FileTextIcon,
    title: "No drafts",
    body: "Anything you start writing is saved here automatically.",
  },
  scheduled: {
    icon: ClockIcon,
    title: "Nothing scheduled",
    body: "Use Send later in the composer to queue a message for a specific time.",
  },
  archive: {
    icon: ArchiveIcon,
    title: "Archive is empty",
    body: "Archived conversations stay searchable but leave your inbox.",
  },
  spam: {
    icon: ShieldAlertIcon,
    title: "No spam",
    body: "Mail that fails SPF, DKIM and DMARC is quarantined here.",
  },
  trash: {
    icon: Trash2Icon,
    title: "Trash is empty",
    body: "Deleted conversations wait here until you remove them for good.",
  },
};

export function EmptyState({
  folder,
  mailboxName,
  searching,
  onCompose,
  onShowShortcuts,
}: {
  folder: Folder;
  /** Set when the empty list is a mailbox rather than a folder. */
  mailboxName?: string;
  searching: boolean;
  onCompose?: () => void;
  onShowShortcuts?: () => void;
}) {
  if (searching) {
    return (
      <Frame icon={<SearchXIcon />} title="No matches">
        Try fewer words, or search for an address instead of a name.
      </Frame>
    );
  }

  // A mailbox is empty for one specific reason, and saying which one is the
  // difference between "this works, nothing has come yet" and "did I set this
  // up wrong?" — the likelier worry for something you defined a minute ago.
  if (mailboxName) {
    return (
      <Frame icon={<AtSignIcon />} title={`Nothing for ${mailboxName} yet`}>
        Mail sent to this address will gather here as it arrives — and stay in your Inbox too.
      </Frame>
    );
  }

  const copy = COPY[folder] ?? COPY.inbox;
  return (
    <Frame
      icon={<copy.icon />}
      title={copy.title}
      /*
        An empty folder is the calmest moment in the app and the likeliest one
        to be someone's first — so it is where the two keys worth knowing get
        introduced. They are buttons as well as hints: a shortcut you cannot
        find any other way is not discoverable, it is folklore.
      */
      footer={
        (onCompose || onShowShortcuts) && (
          <div className="mt-4 flex items-center justify-center gap-1">
            {onCompose && (
              <Hint onClick={onCompose} keyLabel="C">
                Compose
              </Hint>
            )}
            {onShowShortcuts && (
              <Hint onClick={onShowShortcuts} keyLabel="?">
                Shortcuts
              </Hint>
            )}
          </div>
        )
      }
    >
      {copy.body}
    </Frame>
  );
}

function Hint({
  keyLabel,
  onClick,
  children,
}: {
  keyLabel: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring/40 flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] transition-colors outline-none focus-visible:ring-2"
    >
      <Kbd>{keyLabel}</Kbd>
      {children}
    </button>
  );
}

function Frame({
  icon,
  title,
  children,
  footer,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-8 py-20 text-center">
      <div className="text-muted-foreground bg-muted mb-4 flex size-11 items-center justify-center rounded-xl [&_svg]:size-5">
        {icon}
      </div>
      <p className="text-[13px] font-semibold">{title}</p>
      <p className="text-muted-foreground mt-1 max-w-[16rem] text-[12px] leading-relaxed">
        {children}
      </p>
      {footer}
    </div>
  );
}

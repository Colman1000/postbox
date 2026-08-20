import {
  ArchiveIcon,
  ClockIcon,
  FileTextIcon,
  InboxIcon,
  SearchXIcon,
  SendIcon,
  ShieldAlertIcon,
  Trash2Icon,
} from "lucide-react";
import type { Folder } from "@shared/types.ts";

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

export function EmptyState({ folder, searching }: { folder: Folder; searching: boolean }) {
  if (searching) {
    return (
      <Frame icon={<SearchXIcon />} title="No matches">
        Try fewer words, or search for an address instead of a name.
      </Frame>
    );
  }

  const copy = COPY[folder] ?? COPY.inbox;
  return (
    <Frame icon={<copy.icon />} title={copy.title}>
      {copy.body}
    </Frame>
  );
}

function Frame({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
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
    </div>
  );
}

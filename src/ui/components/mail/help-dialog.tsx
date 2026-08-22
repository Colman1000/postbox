import { ChevronRightIcon, KeyboardIcon } from "lucide-react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";

/**
 * How the place works.
 *
 * Nobody reads help. They arrive with one question, so the answer has to be
 * findable in a glance: six headings, each with a line saying what is inside,
 * and the detail folded away until it is asked for. The first section is open
 * so the panel does not read as a list of closed doors.
 *
 * Keystrokes live in the shortcuts sheet, which is one button away at the
 * bottom — repeating that list here would only mean maintaining it twice.
 */
export function HelpDialog({
  open,
  onOpenChange,
  onShowShortcuts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShowShortcuts: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>How Postbox works</DialogTitle>
          <DialogDescription>
            Open whichever part you need. Most of it you can ignore until you do.
          </DialogDescription>
        </DialogHeader>

        <div className="scroll-panel -mx-1 max-h-[60vh] overflow-y-auto px-1">
          <Topic title="Your mail" gist="Every address at your domain, one inbox" open>
            <Point term="No aliases to set up">
              Anything sent to your domain lands here — <code>hi@</code>, <code>billing@</code>,
              the typo somebody made last Tuesday — and you can send from any of those addresses.
            </Point>
            <Point term="It arrives on its own">
              New mail shows up without a refresh, and the tab title carries the unread count while
              you are somewhere else.
            </Point>
          </Topic>

          <Topic title="Writing" gist="Formatting, attachments, send later, undo">
            <Point term="Start one">
              <Key>C</Key> for a new message, <Key>R</Key> to reply to the one you are reading.
            </Point>
            <Point term="Format it">
              The toolbar covers bold, headings, lists, checklists and links. Starting a line with
              a dash and a space makes a bullet; a hash and a space makes a heading. If you would
              rather write Markdown yourself, <Key>⌘</Key> <Key>⇧</Key> <Key>M</Key> swaps the
              toolbar for it and back.
            </Point>
            <Point term="Attach files">
              The paperclip, or drop them onto the composer — 8 MB in one message. Large ones show
              their progress and can be stopped part-way.
            </Point>
            <Point term="Change your mind">
              Drafts save as you type. After you send there are eight seconds to take it back, and
              closing the tab in that window still sends it rather than losing it. The clock beside
              Send schedules for later instead.
            </Point>
          </Topic>

          <Topic title="Reading" gist="Blocked images, and who really sent it">
            <Point term="Images wait to be asked">
              Remote images stay blocked until you want them, and each message says how many it
              held back — in most mail those are tracking pixels rather than pictures.
            </Point>
            <Point term="Sender checks, in plain sight">
              Every message carries what SPF, DKIM and DMARC made of it, which is as close as mail
              gets to answering "is this really from my bank".
            </Point>
          </Topic>

          <Topic title="Tidying up" gist="Archive, trash, snooze, stars and labels">
            <Point term="Archive or trash">
              Archived mail stays searchable, it is just out of the way. Trash keeps things until
              you empty it, and emptying it is permanent.
            </Point>
            <Point term="Snooze">
              Puts a conversation away until a time you pick, and brings it back unread.
            </Point>
            <Point term="Stars and labels">
              Both live in the conversation toolbar. Labels appear in the sidebar with a count, and
              follow a conversation wherever you file it.
            </Point>
          </Topic>

          <Topic title="Finding things" gist="Search, and the command palette">
            <Point term="Search">
              <Key>/</Key> searches everything you have ever sent or received, drafts included.
            </Point>
            <Point term="The palette">
              <Key>⌘</Key> <Key>K</Key> searches and jumps to any folder at the same time, which is
              usually the fastest way anywhere.
            </Point>
          </Topic>

          <Topic title="Settings" gist="Addresses, signatures, templates, alerts, limits">
            <Point term="Make it yours">
              Name the addresses you send from and give each a signature, keep labels and reusable
              templates, and turn on desktop notifications and the new-mail chime.
            </Point>
            <Point term="Default mail app">
              Hand your browser's <code>mailto:</code> links to Postbox, so writing to an address
              anywhere opens the composer here.
            </Point>
            <Point term="What you have sent">
              How many messages have gone out today and this month, against what your sending
              provider allows — plus a log of every sign-in and change on the account.
            </Point>
          </Topic>
        </div>

        <div className="flex items-center justify-between gap-3 border-t pt-3">
          <p className="text-muted-foreground text-[12px]">
            Nearly everything here has a key. <Key>?</Key> shows the lot.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => {
              onOpenChange(false);
              onShowShortcuts();
            }}
          >
            <KeyboardIcon /> Keyboard shortcuts
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One folding section.
 *
 * `<details>` rather than a component library: the browser already knows how to
 * open and close this, keyboard and screen reader included, and it stays open
 * when the page is searched with ⌘F.
 */
function Topic({
  title,
  gist,
  open,
  children,
}: {
  title: string;
  gist: string;
  open?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details open={open} className="group border-b last:border-b-0">
      <summary className="hover:bg-accent/40 flex cursor-pointer list-none items-baseline gap-2 rounded-md px-2 py-2.5 transition-colors [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0 translate-y-0.5 transition-transform group-open:rotate-90" />
        <span className="text-[13px] font-medium">{title}</span>
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-[12px] group-open:hidden">
          {gist}
        </span>
      </summary>
      <dl className="space-y-2.5 px-2 pb-3 pl-7.5">{children}</dl>
    </details>
  );
}

/** A labelled fact. The term is what the eye lands on when skimming. */
function Point({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="text-[13px] leading-relaxed [&_code]:font-mono [&_code]:text-[12px]">
      <dt className="inline font-medium">{term}. </dt>
      <dd className="text-muted-foreground inline">{children}</dd>
    </div>
  );
}

/**
 * A key that survives a narrow screen.
 *
 * `Kbd` hides itself on touch devices, which is right for a hint hanging off a
 * button and wrong here: these keys are the subject of the sentence, and a
 * phone with a keyboard attached can still press them.
 */
function Key({ children }: { children: React.ReactNode }) {
  return <Kbd className="max-md:inline-flex">{children}</Kbd>;
}

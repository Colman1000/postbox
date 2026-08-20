import { SHORTCUTS } from "@/hooks/use-hotkeys.ts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Shortcuts are ignored while you are typing, unless they use a modifier.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          {groups.map((group) => (
            <section key={group}>
              <h3 className="text-muted-foreground mb-2 text-[10px] font-medium tracking-wider uppercase">
                {group}
              </h3>
              <ul className="space-y-1.5">
                {SHORTCUTS.filter((s) => s.group === group).map((shortcut) => (
                  <li
                    key={`${group}-${shortcut.label}`}
                    className="flex items-center justify-between gap-4"
                  >
                    <span className="text-[13px]">{shortcut.label}</span>
                    <span className="flex shrink-0 gap-1">
                      {shortcut.keys.map((key) => (
                        <Kbd key={key}>{key}</Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { CalendarClockIcon } from "lucide-react";
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";

/**
 * Snooze presets.
 *
 * Times are computed at click, not at render, so a menu left open overnight
 * still means "tomorrow morning" rather than yesterday's idea of it.
 */
function presets(): { label: string; detail: string; at: () => number }[] {
  const startOf = (date: Date, hour: number) => {
    const copy = new Date(date);
    copy.setHours(hour, 0, 0, 0);
    return copy.getTime();
  };

  return [
    {
      label: "Later today",
      detail: "in 3 hours",
      at: () => Date.now() + 3 * 60 * 60 * 1000,
    },
    {
      label: "Tomorrow",
      detail: "8:00",
      at: () => {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        return startOf(d, 8);
      },
    },
    {
      label: "This weekend",
      detail: "Saturday 8:00",
      at: () => {
        const d = new Date();
        d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
        return startOf(d, 8);
      },
    },
    {
      label: "Next week",
      detail: "Monday 8:00",
      at: () => {
        const d = new Date();
        d.setDate(d.getDate() + ((1 - d.getDay() + 7) % 7 || 7));
        return startOf(d, 8);
      },
    },
  ];
}

export function SnoozeMenu({
  children,
  onSnooze,
}: {
  children: React.ReactNode;
  onSnooze: (until: number) => void;
}) {
  const [custom, setCustom] = useState("");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel>Snooze until</DropdownMenuLabel>
        {presets().map((preset) => (
          <DropdownMenuItem key={preset.label} onSelect={() => onSnooze(preset.at())}>
            <CalendarClockIcon />
            {preset.label}
            <span className="text-muted-foreground ml-auto text-[11px]">{preset.detail}</span>
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />
        <div
          className="flex items-center gap-1.5 p-1.5"
          onKeyDown={(e) => e.stopPropagation()}
        >
          <Input
            type="datetime-local"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            className="h-7 flex-1 text-[11px]"
          />
          <Button
            size="xs"
            disabled={!custom}
            onClick={() => {
              const at = new Date(custom).getTime();
              if (Number.isFinite(at) && at > Date.now()) onSnooze(at);
            }}
          >
            Set
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

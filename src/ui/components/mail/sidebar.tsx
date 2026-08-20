import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArchiveIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  ClockIcon,
  FileTextIcon,
  InboxIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  PencilLineIcon,
  PlusIcon,
  SendIcon,
  SettingsIcon,
  ShieldAlertIcon,
  StarIcon,
  SunIcon,
  TagIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import type { Folder, SessionInfo } from "@shared/types.ts";
import { api } from "@/lib/api.ts";
import { keys, useLabels, useStats } from "@/lib/queries.ts";
import { applyTheme, readTheme, type Theme } from "@/lib/theme.ts";
import { cn } from "@/lib/utils.ts";
import type { MailView } from "./mail-app.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Progress } from "@/components/ui/progress.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip.tsx";

const FOLDERS: { key: Folder; label: string; icon: typeof InboxIcon; hint: string }[] = [
  { key: "inbox", label: "Inbox", icon: InboxIcon, hint: "g i" },
  { key: "sent", label: "Sent", icon: SendIcon, hint: "g s" },
  { key: "drafts", label: "Drafts", icon: FileTextIcon, hint: "g d" },
  { key: "scheduled", label: "Scheduled", icon: ClockIcon, hint: "g e" },
  { key: "archive", label: "Archive", icon: ArchiveIcon, hint: "g a" },
  { key: "spam", label: "Spam", icon: ShieldAlertIcon, hint: "" },
  { key: "trash", label: "Trash", icon: Trash2Icon, hint: "g t" },
];

export function Sidebar({
  open,
  view,
  session,
  onChangeView,
  onCompose,
  onOpenSettings,
  onToggle,
  variant = "rail",
}: {
  open: boolean;
  view: MailView;
  session: SessionInfo;
  onChangeView: (view: MailView) => void;
  onCompose: () => void;
  onOpenSettings: () => void;
  onToggle: () => void;
  /**
   * `rail` is the collapsible desktop column; `sheet` is the same navigation
   * rendered inside a drawer on phones, where collapsing makes no sense and
   * the safe-area inset has to be honoured.
   */
  variant?: "rail" | "sheet";
}) {
  const client = useQueryClient();
  const stats = useStats();
  const labels = useLabels();
  const [theme, setTheme] = useState<Theme>(readTheme);

  function changeTheme(next: Theme) {
    setTheme(next);
    applyTheme(next);
  }

  const quota = stats.data?.quota;
  const usedToday = quota ? Math.round((quota.sentToday / quota.dailyLimit) * 100) : 0;
  const nearLimit = usedToday >= 80;

  return (
    <aside
      className={cn(
        "bg-rail flex shrink-0 flex-col",
        variant === "rail"
          ? ["border-r transition-[width] duration-200", open ? "w-60" : "w-[3.75rem]", "max-md:hidden"]
          : "h-full w-full pt-safe pb-safe",
      )}
    >
      {/* Identity + collapse */}
      <div className="flex h-14 items-center gap-2 px-3">
        <div className="bg-primary text-primary-foreground flex size-7 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold">
          PB
        </div>
        {open && (
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] leading-tight font-semibold">Postbox</p>
            <p className="text-muted-foreground truncate text-[11px] leading-tight">
              {session.domain}
            </p>
          </div>
        )}
        {variant === "rail" && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onToggle}
            className="text-muted-foreground shrink-0"
            aria-label={open ? "Collapse sidebar" : "Expand sidebar"}
          >
            {open ? <ChevronsLeftIcon /> : <ChevronsRightIcon />}
          </Button>
        )}
      </div>

      {/* Compose */}
      <div className="px-3 pb-3">
        <Button
          onClick={onCompose}
          className={cn("w-full gap-2 max-md:h-10", !open && "px-0")}
        >
          <PencilLineIcon />
          {open && (
            <>
              <span>Compose</span>
              <Kbd className="ml-auto bg-primary-foreground/15 text-primary-foreground border-transparent">
                C
              </Kbd>
            </>
          )}
        </Button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        <ul className="space-y-0.5">
          {FOLDERS.map((folder) => {
            const active =
              view.folder === folder.key && !view.starred && !view.label;
            const unread = stats.data?.unread[folder.key] ?? 0;
            const total = stats.data?.counts[folder.key] ?? 0;
            // Inbox and Spam show what is unread; the rest show volume.
            const badge =
              folder.key === "inbox" || folder.key === "spam"
                ? unread
                : folder.key === "drafts" || folder.key === "scheduled"
                  ? total
                  : 0;

            return (
              <li key={folder.key}>
                <NavItem
                  open={open}
                  active={active}
                  icon={<folder.icon />}
                  label={folder.label}
                  hint={folder.hint}
                  badge={badge}
                  emphasise={folder.key === "inbox" && unread > 0}
                  onClick={() => onChangeView({ folder: folder.key })}
                />
              </li>
            );
          })}

          <li>
            <NavItem
              open={open}
              active={!!view.starred}
              icon={<StarIcon />}
              label="Starred"
              badge={stats.data?.starred ?? 0}
              onClick={() => onChangeView({ folder: "inbox", starred: true })}
            />
          </li>
        </ul>

        {open && (labels.data?.length ?? 0) > 0 && (
          <>
            <Separator className="my-3" />
            <p className="text-muted-foreground px-2 pb-1 text-[10px] font-medium tracking-wider uppercase">
              Labels
            </p>
            <ul className="space-y-0.5">
              {labels.data?.map((label) => (
                <li key={label.id}>
                  <NavItem
                    open={open}
                    active={view.label === label.id}
                    icon={<TagIcon />}
                    label={label.name}
                    badge={label.count}
                    onClick={() =>
                      onChangeView({
                        folder: "inbox",
                        label: label.id,
                        labelName: label.name,
                      })
                    }
                  />
                </li>
              ))}
            </ul>
          </>
        )}

        {open && (
          <button
            type="button"
            onClick={onOpenSettings}
            className="text-muted-foreground hover:text-foreground mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors"
          >
            <PlusIcon className="size-3.5" />
            New label
          </button>
        )}
      </nav>

      {/* Sending headroom — the one number that decides whether a send works. */}
      {open && quota && (
        <div className="space-y-2 px-4 pb-3">
          {!session.sendingReady && (
            <div className="bg-muted text-muted-foreground flex items-start gap-2 rounded-md p-2 text-[11px] leading-snug">
              <TriangleAlertIcon className="mt-px size-3.5 shrink-0" />
              <span>
                Sending domain not verified yet. Run{" "}
                <code className="font-mono">just verify</code>.
              </span>
            </div>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <span className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
                    Sends today
                  </span>
                  <span
                    className={cn(
                      "font-mono text-[11px]",
                      nearLimit ? "text-foreground font-semibold" : "text-muted-foreground",
                    )}
                  >
                    {quota.sentToday}/{quota.dailyLimit}
                  </span>
                </div>
                <Progress value={usedToday} className="h-1" />
              </div>
            </TooltipTrigger>
            <TooltipContent side="top">
              {quota.sentThisMonth} of {quota.monthlyLimit} this month · Resend free tier
            </TooltipContent>
          </Tooltip>
        </div>
      )}

      <Separator />

      {/* Account */}
      <div className="p-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors"
            >
              <div className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold uppercase">
                {session.defaultFrom.slice(0, 2)}
              </div>
              {open && (
                <span className="text-muted-foreground min-w-0 flex-1 truncate text-[12px]">
                  {session.defaultFrom}
                </span>
              )}
            </button>
          </DropdownMenuTrigger>

          <DropdownMenuContent side="top" align="start" className="w-56">
            <DropdownMenuLabel>Appearance</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => changeTheme("light")}>
              <SunIcon /> Light {theme === "light" && <span className="ml-auto">·</span>}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => changeTheme("dark")}>
              <MoonIcon /> Dark {theme === "dark" && <span className="ml-auto">·</span>}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => changeTheme("system")}>
              <MonitorIcon /> System {theme === "system" && <span className="ml-auto">·</span>}
            </DropdownMenuItem>

            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onOpenSettings}>
              <SettingsIcon /> Settings
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={async () => {
                await api.logout();
                client.setQueryData(keys.session, { ...session, authenticated: false });
                client.clear();
              }}
            >
              <LogOutIcon /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}

function NavItem({
  open,
  active,
  icon,
  label,
  hint,
  badge,
  emphasise,
  onClick,
}: {
  open: boolean;
  active: boolean;
  icon: React.ReactNode;
  label: string;
  hint?: string;
  badge?: number;
  emphasise?: boolean;
  onClick: () => void;
}) {
  const content = (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-colors",
        // Comfortable to tap on a phone, unchanged on a mouse.
        "max-md:py-2.5 max-md:text-[14px]",
        active
          ? "bg-accent text-accent-foreground font-medium"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        !open && "justify-center px-0",
      )}
    >
      <span className="[&_svg]:size-4 [&_svg]:shrink-0">{icon}</span>
      {open && (
        <>
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
          {hint && !badge ? (
            <Kbd className="opacity-0 transition-opacity group-hover:opacity-100">{hint}</Kbd>
          ) : null}
          {badge ? (
            <Badge
              variant={emphasise ? "default" : "muted"}
              className="min-w-5 justify-center tabular-nums"
            >
              {badge > 999 ? "999+" : badge}
            </Badge>
          ) : null}
        </>
      )}
    </button>
  );

  if (open) return content;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

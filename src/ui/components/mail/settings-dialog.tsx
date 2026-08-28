import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AtSignIcon,
  BellIcon,
  InboxIcon,
  CheckIcon,
  MonitorIcon,
  MoonIcon,
  PencilLineIcon,
  PipetteIcon,
  PlusIcon,
  SunIcon,
  Trash2Icon,
  Volume2Icon,
} from "lucide-react";
import { toast } from "sonner";
import type { SessionInfo } from "@shared/types.ts";
import { useBrand } from "@/hooks/use-brand.ts";
import type { LiveStatus } from "@/hooks/use-new-mail.ts";
import { api, ApiError } from "@/lib/api.ts";
import { BRAND_PRESETS } from "@/lib/brand.ts";
import { deviceSummary, fileSize, fullDate, relativeTime } from "@/lib/format.ts";
import {
  notificationsSupported,
  permission as notificationPermission,
  playChime,
  readPrefs,
  requestPermission,
  writePrefs,
  type NotifyPrefs,
} from "@/lib/notify.ts";
import {
  keys,
  useAudit,
  useEvents,
  useIdentities,
  useLabels,
  useMailboxes,
  useMailboxSuggestions,
  useStats,
  useTemplates,
} from "@/lib/queries.ts";
import { applyTheme, readTheme, type Theme } from "@/lib/theme.ts";
import { cn } from "@/lib/utils.ts";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Progress } from "@/components/ui/progress.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import { AppIconPicker } from "./app-icon-picker.tsx";
import { PushSettings } from "./push-settings.tsx";
import { Row } from "./setting-row.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";

export function SettingsDialog({
  open,
  onOpenChange,
  session,
  live,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: SessionInfo;
  /** Whether the live channel is currently up; shown under Alerts. */
  live: LiveStatus;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl gap-0 p-0 max-md:p-0">
        <DialogHeader className="p-6 pb-4">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Mail for {session.domain}, deployed to stage {session.stage}.
          </DialogDescription>
        </DialogHeader>

        {/* `min-w-0`: the dialog is a grid, so without it this column is sized to
            the tab strip's min-content and the whole dialog grows past the phone. */}
        <Tabs
          defaultValue="identities"
          className="min-w-0 px-6 pb-6 max-md:px-4 max-md:pb-4"
        >
          {/* Eight tabs do not fit a phone. Scrolling the strip keeps them all
              reachable without the dialog itself growing sideways. */}
          <TabsList className="mb-4 max-w-full justify-start overflow-x-auto max-md:w-full">
            <TabsTrigger value="identities">Addresses</TabsTrigger>
            <TabsTrigger value="mailboxes">Mailboxes</TabsTrigger>
            <TabsTrigger value="labels">Labels</TabsTrigger>
            <TabsTrigger value="templates">Templates</TabsTrigger>
            <TabsTrigger value="appearance">Appearance</TabsTrigger>
            <TabsTrigger value="alerts">Alerts</TabsTrigger>
            <TabsTrigger value="access">Access</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>

          <div className="scroll-panel max-h-[26rem] overflow-y-auto max-md:max-h-[60dvh]">
            <TabsContent value="identities">
              <Identities session={session} />
            </TabsContent>
            <TabsContent value="mailboxes">
              <Mailboxes session={session} />
            </TabsContent>
            <TabsContent value="labels">
              <Labels />
            </TabsContent>
            <TabsContent value="templates">
              <Templates />
            </TabsContent>
            <TabsContent value="appearance">
              <Appearance session={session} />
            </TabsContent>
            <TabsContent value="alerts">
              <Alerts live={live} session={session} />
            </TabsContent>
            <TabsContent value="access">
              <Access />
            </TabsContent>
            <TabsContent value="activity">
              <Activity />
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

// ── addresses ────────────────────────────────────────────────────────────────

function Identities({ session }: { session: SessionInfo }) {
  const client = useQueryClient();
  const identities = useIdentities();
  const [local, setLocal] = useState("");
  const [name, setName] = useState("");
  const [signature, setSignature] = useState("");
  const [editing, setEditing] = useState<string | null>(null);

  async function add() {
    try {
      await api.saveIdentity({
        address: `${local.trim()}@${session.domain}`,
        name: name.trim() || undefined,
      });
      setLocal("");
      setName("");
      client.invalidateQueries({ queryKey: keys.identities });
      toast.success("Address added");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not add that address");
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-muted-foreground text-[12px] leading-relaxed">
        Every address on <span className="text-foreground font-medium">{session.domain}</span>{" "}
        already reaches this mailbox — a catch-all rule routes the whole domain here. Adding one
        below just makes it selectable in Compose; there is nothing to configure at the DNS level.
      </p>

      <div className="flex items-end gap-2 max-sm:flex-col max-sm:items-stretch">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="identity-local" className="text-[12px]">
            Address
          </Label>
          <div className="flex items-center">
            <Input
              id="identity-local"
              value={local}
              onChange={(e) => setLocal(e.target.value.replace(/[^a-z0-9._+-]/gi, ""))}
              placeholder="billing"
              className="rounded-r-none"
            />
            <span className="border-input bg-muted text-muted-foreground flex h-9 items-center rounded-r-md border border-l-0 px-2 text-[13px]">
              @{session.domain}
            </span>
          </div>
        </div>
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="identity-name" className="text-[12px]">
            Display name
          </Label>
          <Input
            id="identity-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Optional"
          />
        </div>
        <Button onClick={add} disabled={!local.trim()}>
          <PlusIcon /> Add
        </Button>
      </div>

      <Separator />

      <ul className="space-y-2">
        {identities.data?.map((identity) => (
          <li key={identity.id} className="rounded-lg border p-3">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{identity.address}</p>
                {identity.name && (
                  <p className="text-muted-foreground text-[11px]">{identity.name}</p>
                )}
              </div>
              {identity.isDefault && (
                <span className="text-muted-foreground text-[10px] tracking-wide uppercase">
                  Default
                </span>
              )}
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setEditing(editing === identity.id ? null : identity.id);
                  setSignature(identity.signatureHtml ?? "");
                }}
              >
                Signature
              </Button>
              {!identity.isDefault && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground"
                  onClick={async () => {
                    await api.saveIdentity({ ...identity, isDefault: true });
                    client.invalidateQueries({ queryKey: keys.identities });
                  }}
                  aria-label="Make default"
                >
                  ★
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground"
                onClick={async () => {
                  try {
                    await api.deleteIdentity(identity.id);
                    client.invalidateQueries({ queryKey: keys.identities });
                  } catch (error) {
                    toast.error(
                      error instanceof ApiError ? error.message : "Could not remove that address",
                    );
                  }
                }}
                aria-label="Remove"
              >
                <Trash2Icon />
              </Button>
            </div>

            {editing === identity.id && (
              <div className="mt-3 space-y-2">
                <Textarea
                  value={signature}
                  onChange={(e) => setSignature(e.target.value)}
                  placeholder="Appended to every message sent from this address. Basic HTML is allowed."
                  className="min-h-20 text-[12px]"
                />
                <Button
                  size="sm"
                  onClick={async () => {
                    await api.saveIdentity({ ...identity, signatureHtml: signature });
                    client.invalidateQueries({ queryKey: keys.identities });
                    setEditing(null);
                    toast.success("Signature saved");
                  }}
                >
                  Save signature
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── mailboxes ────────────────────────────────────────────────────────────────

/**
 * Give one address its own place in the sidebar.
 *
 * The form is deliberately the same shape as Addresses above — local part,
 * your domain, an optional name — because it is the same act from the other
 * direction: that one says which addresses you can write *as*, this one says
 * which you want to read *apart*.
 *
 * Nothing is moved when a mailbox is made. The grouping is derived from the
 * address each message arrived at, so a mailbox is complete the instant it
 * exists and removing it costs nothing but the sidebar entry.
 */
function Mailboxes({ session }: { session: SessionInfo }) {
  const client = useQueryClient();
  const mailboxes = useMailboxes();
  const suggestions = useMailboxSuggestions();
  const [local, setLocal] = useState("");
  const [name, setName] = useState("");

  async function add(address: string, displayName?: string) {
    try {
      await api.createMailbox(address, displayName);
      setLocal("");
      setName("");
      client.invalidateQueries({ queryKey: keys.mailboxes });
      client.invalidateQueries({ queryKey: keys.mailboxSuggestions });
      toast.success("Mailbox added");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not add that mailbox");
    }
  }

  // Only offer what is not already there — the list is refetched on add, but
  // this keeps the row from lingering for the moment in between.
  const taken = new Set(mailboxes.data?.map((m) => m.address) ?? []);
  const unused = suggestions.data?.filter((s) => !taken.has(s.address)) ?? [];

  return (
    <div className="space-y-5">
      <p className="text-muted-foreground text-[12px] leading-relaxed">
        A mailbox groups everything sent to one address — <code>billing@</code>,{" "}
        <code>support@</code> — under its own entry in the sidebar. Nothing moves: the mail still
        arrives in your Inbox and is archived, starred and searched exactly as before. This is
        only a second way in, so the busy address does not disappear into the pile.
      </p>

      <div className="flex items-end gap-2 max-sm:flex-col max-sm:items-stretch">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="mailbox-local" className="text-[12px]">
            Address
          </Label>
          <div className="flex items-center">
            <Input
              id="mailbox-local"
              value={local}
              onChange={(e) => setLocal(e.target.value.replace(/[^a-z0-9._+-]/gi, ""))}
              onKeyDown={(e) =>
                e.key === "Enter" &&
                local.trim() &&
                add(`${local.trim()}@${session.domain}`, name.trim() || undefined)
              }
              placeholder="billing"
              className="rounded-r-none"
            />
            <span className="border-input bg-muted text-muted-foreground flex h-9 items-center rounded-r-md border border-l-0 px-2 text-[13px]">
              @{session.domain}
            </span>
          </div>
        </div>
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="mailbox-name" className="text-[12px]">
            Shown as
          </Label>
          <Input
            id="mailbox-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Optional"
          />
        </div>
        <Button
          onClick={() => add(`${local.trim()}@${session.domain}`, name.trim() || undefined)}
          disabled={!local.trim()}
        >
          <PlusIcon /> Add
        </Button>
      </div>

      {/*
        The addresses that are already getting mail, offered rather than
        remembered. "Which of my addresses actually receive anything" is a
        question the database can answer, and asking the user to recall it
        instead is how a feature ends up unused.
      */}
      {unused.length > 0 && (
        <div className="space-y-2">
          <p className="text-muted-foreground text-[11px]">
            Already receiving mail:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {unused.map((suggestion) => (
              <button
                key={suggestion.address}
                type="button"
                onClick={() => add(suggestion.address)}
                className="hover:bg-accent hover:text-foreground text-muted-foreground flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] transition-colors"
              >
                <PlusIcon className="size-3" />
                {suggestion.address}
                <span className="tabular-nums opacity-60">{suggestion.count}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <Separator />

      {(mailboxes.data?.length ?? 0) === 0 ? (
        <p className="text-muted-foreground py-8 text-center text-[12px]">
          No mailboxes yet. Add one above and it appears in the sidebar, already holding every
          message that address has ever received.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {mailboxes.data?.map((mailbox) => (
            <li key={mailbox.id} className="flex items-center gap-2 rounded-lg border px-3 py-2">
              <InboxIcon className="text-muted-foreground size-3.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">
                  {mailbox.name || mailbox.address.split("@")[0]}
                </p>
                <p className="text-muted-foreground truncate text-[11px]">{mailbox.address}</p>
              </div>
              <span className="text-muted-foreground text-[11px] tabular-nums">
                {mailbox.unread > 0 ? `${mailbox.unread} unread · ` : ""}
                {mailbox.count}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground"
                onClick={async () => {
                  await api.deleteMailbox(mailbox.id);
                  client.invalidateQueries({ queryKey: keys.mailboxes });
                  client.invalidateQueries({ queryKey: keys.mailboxSuggestions });
                }}
                aria-label={`Remove ${mailbox.address}`}
              >
                <Trash2Icon />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── labels ───────────────────────────────────────────────────────────────────

function Labels() {
  const client = useQueryClient();
  const labels = useLabels();
  const [name, setName] = useState("");

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && name.trim() && create()}
          placeholder="Label name"
        />
        <Button onClick={create} disabled={!name.trim()}>
          <PlusIcon /> Create
        </Button>
      </div>

      {(labels.data?.length ?? 0) === 0 ? (
        <p className="text-muted-foreground py-8 text-center text-[12px]">
          No labels yet. Labels apply to whole conversations and show up in the sidebar.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {labels.data?.map((label) => (
            <li key={label.id} className="flex items-center gap-2 rounded-lg border px-3 py-2">
              <span className="flex-1 truncate text-[13px]">{label.name}</span>
              <span className="text-muted-foreground text-[11px] tabular-nums">
                {label.count}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground"
                onClick={async () => {
                  await api.deleteLabel(label.id);
                  client.invalidateQueries({ queryKey: keys.labels });
                  client.invalidateQueries({ queryKey: ["threads"] });
                }}
                aria-label={`Delete ${label.name}`}
              >
                <Trash2Icon />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  async function create() {
    await api.createLabel(name.trim());
    setName("");
    client.invalidateQueries({ queryKey: keys.labels });
  }
}

// ── templates ────────────────────────────────────────────────────────────────

function Templates() {
  const client = useQueryClient();
  const templates = useTemplates();
  const [draft, setDraft] = useState({ name: "", subject: "", body: "" });

  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-lg border p-3">
        <Input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="Template name"
        />
        <Input
          value={draft.subject}
          onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
          placeholder="Default subject (optional)"
        />
        <Textarea
          value={draft.body}
          onChange={(e) => setDraft({ ...draft, body: e.target.value })}
          placeholder="Body — Markdown works here too."
          className="min-h-24 text-[12px]"
        />
        <Button
          size="sm"
          disabled={!draft.name.trim()}
          onClick={async () => {
            await api.saveTemplate(draft);
            setDraft({ name: "", subject: "", body: "" });
            client.invalidateQueries({ queryKey: keys.templates });
            toast.success("Template saved");
          }}
        >
          <PlusIcon /> Save template
        </Button>
      </div>

      <ul className="space-y-1.5">
        {templates.data?.map((template) => (
          <li key={template.id} className="flex items-start gap-2 rounded-lg border px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium">{template.name}</p>
              <p className="text-muted-foreground truncate text-[11px]">
                {template.subject || template.body.slice(0, 80)}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              onClick={async () => {
                await api.deleteTemplate(template.id);
                client.invalidateQueries({ queryKey: keys.templates });
              }}
              aria-label={`Delete ${template.name}`}
            >
              <Trash2Icon />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── appearance ───────────────────────────────────────────────────────────────

const THEMES: { value: Theme; label: string; icon: typeof SunIcon }[] = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "system", label: "System", icon: MonitorIcon },
];

/** How long a colour has to stand before it counts as chosen. */
const SETTLE_MS = 600;

/** The greyscale the interface is built from, shown as a swatch. */
const MONOCHROME_SWATCH = "linear-gradient(135deg, oklch(0.97 0 0) 50%, oklch(0.3 0 0) 50%)";

/**
 * How the app looks.
 *
 * Theme is per-device — which screen you are reading on decides that, not
 * which mailbox — so it stays in this browser. The brand colour is the
 * mailbox's, and is saved with it, because a colour that only one laptop knows
 * about is not a brand.
 */
function Appearance({ session }: { session: SessionInfo }) {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const { brand, preview, choose } = useBrand();

  /*
   * Paint every colour; save the one that is settled on.
   *
   * A colour input fires on every pixel of a drag, and trying six swatches to
   * see which one you like is one decision rather than six — but each save is
   * a write to the mailbox and a row in the access log, which is a log you
   * read to spot the unusual. Nothing here is worth burying a sign-in under.
   */
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const unsaved = useRef<string | null | undefined>(undefined);

  const commit = useCallback(() => {
    clearTimeout(timer.current);
    if (unsaved.current === undefined) return;
    const value = unsaved.current;
    unsaved.current = undefined;
    void choose(value);
  }, [choose]);

  // Closing the dialog is settling on it too, so a pending pick goes out now
  // rather than being dropped on the way out.
  useEffect(() => commit, [commit]);

  function pick(hex: string | null) {
    preview(hex);
    unsaved.current = hex;
    clearTimeout(timer.current);
    timer.current = setTimeout(commit, SETTLE_MS);
  }

  const custom = brand !== null && !BRAND_PRESETS.some((preset) => preset.hex === brand);

  return (
    <div className="space-y-6">
      <section className="space-y-2.5">
        <div>
          <p className="text-[13px] font-medium">Theme</p>
          <p className="text-muted-foreground text-[12px] leading-relaxed">
            Kept in this browser, since it answers to the room you are in.
          </p>
        </div>
        <div className="flex gap-2 max-sm:flex-col">
          {THEMES.map((option) => (
            <Button
              key={option.value}
              variant={theme === option.value ? "default" : "outline"}
              size="sm"
              className="flex-1"
              aria-pressed={theme === option.value}
              onClick={() => {
                setTheme(option.value);
                applyTheme(option.value);
              }}
            >
              <option.icon /> {option.label}
            </Button>
          ))}
        </div>
      </section>

      <Separator />

      <section className="space-y-2.5">
        <div>
          <p className="text-[13px] font-medium">Brand colour</p>
          <p className="text-muted-foreground text-[12px] leading-relaxed">
            The one colour in an otherwise grey interface: Compose, unread
            counts, the selected conversation, the focus ring. Postbox takes the
            hue and the saturation and picks the brightness itself, so a colour
            that is legible in daylight is still legible at night. Saved with
            the mailbox, so it follows you to another browser.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Swatch
            label="Monochrome"
            background={MONOCHROME_SWATCH}
            selected={brand === null}
            onSelect={() => pick(null)}
          />

          {BRAND_PRESETS.map((preset) => (
            <Swatch
              key={preset.hex}
              label={preset.name}
              background={preset.hex}
              selected={brand === preset.hex}
              onSelect={() => pick(preset.hex)}
            />
          ))}

          {/*
            The native picker, because a brand colour usually already exists
            somewhere as a hex and the eyedropper is the browser's to give.
          */}
          <label
            title="Custom colour"
            className={cn(
              "relative flex size-8 cursor-pointer items-center justify-center rounded-full border",
              custom
                ? "outline-foreground outline-2 outline-offset-2"
                : "bg-muted hover:bg-accent",
            )}
            style={custom ? { background: brand! } : undefined}
          >
            <PipetteIcon
              className={cn("size-3.5", custom ? "text-white" : "text-muted-foreground")}
            />
            <input
              type="color"
              value={brand ?? "#2563eb"}
              onChange={(event) => pick(event.target.value)}
              aria-label="Custom brand colour"
              className="absolute inset-0 cursor-pointer opacity-0"
            />
          </label>
        </div>
      </section>

      <Separator />

      <AppIconPicker domain={session.domain} />

      <Separator />

      <div className="space-y-3 rounded-lg border p-3">
        <p className="text-muted-foreground text-[10px] tracking-wider uppercase">
          Preview
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm">
            <PencilLineIcon /> Compose
          </Button>
          <span className="bg-accent text-accent-foreground flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] font-medium">
            Inbox
            <Badge className="min-w-5 justify-center tabular-nums">12</Badge>
          </span>
          <Progress value={62} className="h-1 w-24" />
        </div>
      </div>
    </div>
  );
}

function Swatch({
  label,
  background,
  selected,
  onSelect,
}: {
  label: string;
  background: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={selected}
      onClick={onSelect}
      style={{ background }}
      className={cn(
        "flex size-8 items-center justify-center rounded-full border transition-transform",
        selected ? "outline-foreground outline-2 outline-offset-2" : "hover:scale-110",
      )}
    >
      {/* White with its own shadow, so the tick survives both a pale swatch and
          a dark one — including the two-tone monochrome one. */}
      {selected && (
        <CheckIcon className="size-4 text-white drop-shadow-[0_1px_1.5px_rgba(0,0,0,0.55)]" />
      )}
    </button>
  );
}

// ── alerts ───────────────────────────────────────────────────────────────────

/**
 * How this browser announces mail that arrives while the app is open.
 *
 * Both settings are per-device, and stored that way: notification permission
 * is granted per-origin per-device by the browser itself, and whether a sound
 * is welcome depends on the room you are in, not on the mailbox.
 */
function Alerts({ live, session }: { live: LiveStatus; session: SessionInfo }) {
  const [prefs, setPrefs] = useState<NotifyPrefs>(() => readPrefs());
  const [granted, setGranted] = useState<NotificationPermission>(() =>
    notificationPermission(),
  );

  const supported = notificationsSupported();
  const blocked = granted === "denied";

  function update(patch: Partial<NotifyPrefs>) {
    setPrefs((current) => writePrefs({ ...current, ...patch }));
  }

  async function toggleDesktop(on: boolean) {
    if (!on) return update({ desktop: false });

    // Chrome only shows the prompt from a gesture, which is exactly what this
    // switch is — so the request belongs here and nowhere else.
    const result = await requestPermission();
    setGranted(result);
    update({ desktop: result === "granted" });
    if (result === "denied") {
      toast.error("Your browser is blocking notifications for this site", {
        description: "Allow them in the site settings, then switch this back on.",
      });
    }
  }

  return (
    <div className="space-y-5">
      <div className="text-muted-foreground space-y-2 text-[12px] leading-relaxed">
        <p className="flex items-center gap-2">
          <span
            className={cn(
              "size-1.5 rounded-full",
              live === "open"
                ? "bg-emerald-500"
                : live === "connecting"
                  ? "bg-amber-500"
                  : "bg-muted-foreground/50",
            )}
          />
          {live === "open"
            ? "Connected — new mail appears the moment it arrives."
            : live === "connecting"
              ? "Connecting to the live channel…"
              : "Live channel is down; checking every 15 seconds instead."}
        </p>
        <p>
          New messages appear in the list on their own, and the unread count
          shows in the tab title — so a background tab is enough to tell you
          something arrived.
        </p>
      </div>

      <PushSettings vapidKey={session.vapidKey} />

      <Separator />

      <Row
        icon={<BellIcon className="size-4" />}
        title="Desktop notifications"
        description={
          !supported
            ? "This browser does not support notifications."
            : blocked
              ? "Blocked by the browser. Allow notifications for this site to switch it on."
              : "Shown only while Postbox is in the background — never while you are looking at it."
        }
        checked={prefs.desktop && granted === "granted"}
        disabled={!supported || blocked}
        onChange={toggleDesktop}
      />

      <Row
        icon={<Volume2Icon className="size-4" />}
        title="Sound"
        description="A short chime when something lands."
        checked={prefs.sound}
        disabled={false}
        onChange={(on) => {
          update({ sound: on });
          if (on) playChime();
        }}
      />

      <Separator />

      {/*
        Registering has to happen from a click: browsers ignore a protocol
        handler requested on page load, which is the correct instinct.
      */}
      <div className="flex items-start gap-3 rounded-lg border p-3">
        <span className="text-muted-foreground mt-0.5">
          <AtSignIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium">Default mail app</p>
          <p className="text-muted-foreground mt-0.5 text-[12px] leading-relaxed">
            Hand this browser's <code className="text-[11px]">mailto:</code> links to Postbox,
            so writing to an address anywhere opens the composer here. Links inside your own
            mail already do.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            try {
              navigator.registerProtocolHandler(
                "mailto",
                `${location.origin}/?mailto=%s`,
              );
              toast.success("Asked your browser to use Postbox for mailto: links", {
                description: "Confirm it in the prompt or in your browser's settings.",
              });
            } catch (error) {
              toast.error("This browser would not take the request", {
                description: error instanceof Error ? error.message : undefined,
              });
            }
          }}
        >
          Use Postbox
        </Button>
      </div>

      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          if (prefs.sound) playChime();
          toast("This is what a new message looks like", { description: "Somebody" });
        }}
      >
        Preview an alert
      </Button>
    </div>
  );
}

// ── access log ───────────────────────────────────────────────────────────────

/** Sign-ins get the strongest treatment; a refused one strongest of all. */
const ACTION_LABEL: Record<string, string> = {
  "sign-in": "Signed in",
  "sign-in-failed": "Wrong password",
  "sign-in-blocked": "Locked out",
  "sign-out": "Signed out",
  change: "Changed",
};

/**
 * Who was here, and what they did.
 *
 * The mailbox has one password, so the honest unit of "who" is the sign-in —
 * hence the session tag on each row. What you are looking for is a row whose
 * address or device is not yours.
 */
function Access() {
  const audit = useAudit();
  const rows = audit.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-[12px] leading-relaxed">
        Every sign-in, every refused password and every change made through the
        app, newest first. Kept for 90 days, then deleted. Reading mail is not
        recorded, and neither is what any message said.
      </p>

      {rows.length === 0 ? (
        <p className="text-muted-foreground py-8 text-center text-[12px]">
          {audit.isLoading
            ? "Reading the log…"
            : "Nothing recorded yet. Your next sign-in will show up here."}
        </p>
      ) : (
        <ul className="space-y-1">
          {rows.map((row) => {
            const failed = row.action === "sign-in-failed" || row.action === "sign-in-blocked";
            return (
              <li
                key={row.id}
                className={cn(
                  "flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-md px-2 py-1.5 text-[12px]",
                  failed && "bg-destructive/10",
                )}
              >
                <span
                  className={cn(
                    "w-28 shrink-0 font-medium",
                    failed && "text-destructive",
                  )}
                >
                  {ACTION_LABEL[row.action] ?? row.action}
                </span>

                <span className="text-muted-foreground min-w-0 flex-1 truncate">
                  {row.detail ?? "—"}
                </span>

                <span className="text-muted-foreground shrink-0 tabular-nums">
                  {row.ip ?? "no address"}
                  {row.country ? ` · ${row.country}` : ""}
                </span>

                <span className="text-muted-foreground shrink-0">
                  {deviceSummary(row.userAgent)}
                </span>

                {row.sessionId && (
                  <span
                    className="text-muted-foreground/70 shrink-0 font-mono text-[10px]"
                    title="Sign-in this action belonged to"
                  >
                    {row.sessionId}
                  </span>
                )}

                <time
                  dateTime={new Date(row.createdAt).toISOString()}
                  title={fullDate(row.createdAt)}
                  className="text-muted-foreground shrink-0 text-[11px]"
                >
                  {relativeTime(row.createdAt)}
                </time>
              </li>
            );
          })}
        </ul>
      )}

      <LoadMore
        hasMore={audit.hasNextPage}
        isLoading={audit.isFetchingNextPage}
        onLoadMore={() => void audit.fetchNextPage()}
      />
    </div>
  );
}

/**
 * The end of a paged list.
 *
 * A button rather than a bare sentinel, because it is also where "fetching"
 * gets said, and because a list that only ever grows when you scroll at it
 * gives a reader no way to ask. The observer just means they rarely have to.
 */
function LoadMore({
  hasMore,
  isLoading,
  onLoadMore,
}: {
  hasMore: boolean;
  isLoading: boolean;
  onLoadMore: () => void;
}) {
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !isLoading) onLoadMore();
      },
      // No root: the panel scrolls inside the viewport, so clipping by the
      // panel is already what decides whether this is on screen.
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, isLoading, onLoadMore]);

  if (!hasMore) return null;

  return (
    <div ref={sentinel} className="flex justify-center pt-1">
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground"
        disabled={isLoading}
        onClick={onLoadMore}
      >
        {isLoading ? "Loading…" : "Show older"}
      </Button>
    </div>
  );
}

// ── activity ─────────────────────────────────────────────────────────────────

function Activity() {
  const events = useEvents();
  const stats = useStats();
  const rows = events.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Messages" value={String(stats.data?.storage.messages ?? 0)} />
        <Stat
          label="Attachments"
          value={fileSize(stats.data?.storage.attachmentBytes ?? 0)}
        />
        <Stat
          label="Sent this month"
          value={`${stats.data?.quota.sentThisMonth ?? 0} / ${stats.data?.quota.monthlyLimit ?? 0}`}
        />
      </div>

      <Separator />

      <ul className="space-y-1">
        {rows.map((event) => (
          <li key={event.id} className="flex items-baseline gap-3 py-1 text-[12px]">
            <span className="w-24 shrink-0 font-mono text-[11px]">{event.type}</span>
            <span className="text-muted-foreground min-w-0 flex-1 truncate">
              {event.detail}
            </span>
            <span className="text-muted-foreground shrink-0 text-[11px]">
              {relativeTime(event.createdAt)}
            </span>
          </li>
        ))}
        {rows.length === 0 && (
          <li className="text-muted-foreground py-8 text-center text-[12px]">
            {events.isLoading ? "Reading the log…" : "Nothing has happened yet."}
          </li>
        )}
      </ul>

      <LoadMore
        hasMore={events.hasNextPage}
        isLoading={events.isFetchingNextPage}
        onLoadMore={() => void events.fetchNextPage()}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-muted-foreground text-[10px] tracking-wider uppercase">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

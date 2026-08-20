import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import type { SessionInfo } from "@shared/types.ts";
import { api, ApiError } from "@/lib/api.ts";
import { fileSize, relativeTime } from "@/lib/format.ts";
import {
  keys,
  useEvents,
  useIdentities,
  useLabels,
  useStats,
  useTemplates,
} from "@/lib/queries.ts";
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
import { Separator } from "@/components/ui/separator.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";

export function SettingsDialog({
  open,
  onOpenChange,
  session,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: SessionInfo;
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

        <Tabs defaultValue="identities" className="px-6 pb-6 max-md:px-4 max-md:pb-4">
          <TabsList className="mb-4 max-md:w-full">
            <TabsTrigger value="identities">Addresses</TabsTrigger>
            <TabsTrigger value="labels">Labels</TabsTrigger>
            <TabsTrigger value="templates">Templates</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>

          <div className="scroll-panel max-h-[26rem] overflow-y-auto max-md:max-h-[60dvh]">
            <TabsContent value="identities">
              <Identities session={session} />
            </TabsContent>
            <TabsContent value="labels">
              <Labels />
            </TabsContent>
            <TabsContent value="templates">
              <Templates />
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

// ── activity ─────────────────────────────────────────────────────────────────

function Activity() {
  const events = useEvents();
  const stats = useStats();

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
        {events.data?.map((event) => (
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
        {(events.data?.length ?? 0) === 0 && (
          <li className="text-muted-foreground py-8 text-center text-[12px]">
            Nothing has happened yet.
          </li>
        )}
      </ul>
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

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckIcon, ImageIcon, LoaderCircleIcon, TypeIcon, UploadIcon } from "lucide-react";
import { toast } from "sonner";
import type { AppIconKind, AppIconSetting } from "@shared/types.ts";
import { api, ApiError } from "@/lib/api.ts";
import {
  iconIsStale,
  renderColour,
  renderCustom,
  renderMonogram,
  type RenderedIcon,
} from "@/lib/app-icon.ts";
import { readBrand } from "@/lib/brand.ts";
import { keys, useSettings } from "@/lib/queries.ts";
import { cn } from "@/lib/utils.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";

/**
 * The icon Postbox wears on a home screen.
 *
 * This exists because the thing self-hosters install is *their* mailbox, on
 * their domain — and an app on a phone is identified by its icon long before
 * anybody reads its name. Four ways to have one, in ascending order of effort,
 * and the first requires nothing at all.
 *
 * Every option is rendered in this browser and uploaded as a finished PNG; see
 * lib/app-icon.ts for why the Worker cannot do it. The exception is the
 * default, which is a static asset and so is chosen by deleting rather than by
 * uploading.
 */

const OPTIONS: { kind: AppIconKind; label: string; hint: string }[] = [
  { kind: "default", label: "Postbox", hint: "The envelope, in monochrome." },
  { kind: "colour", label: "Brand colour", hint: "The same envelope, on your colour." },
  { kind: "monogram", label: "Monogram", hint: "One or two letters." },
  { kind: "custom", label: "Upload", hint: "A square PNG, JPEG or SVG." },
];

export function AppIconPicker({ domain }: { domain: string }) {
  const client = useQueryClient();
  const settings = useSettings();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<AppIconKind | null>(null);

  const setting = (settings.data?.appIcon as AppIconSetting | undefined) ?? null;
  const kind = setting?.kind ?? "default";
  const brand = readBrand();

  // The domain's own first letter is the monogram anybody would have picked.
  const [monogram, setMonogram] = useState(() => setting?.monogram ?? domain.slice(0, 1).toUpperCase());

  /**
   * The preview, and the URL a home screen will fetch.
   *
   * `updatedAt` is in the query string for the same reason the manifest puts
   * it there: the path never changes, so without it the browser goes on
   * showing the icon it cached before the change.
   */
  const preview =
    kind === "default"
      ? "/icons/postbox-512.png"
      : `/icons/app.png?v=${setting?.updatedAt ?? 0}`;

  const stale = iconIsStale(setting, brand);

  async function store(rendered: RenderedIcon, meta: AppIconSetting) {
    const saved = await api.saveAppIcon(rendered, meta);
    client.setQueryData(keys.settings, (current: Record<string, unknown> | undefined) => ({
      ...current,
      appIcon: saved,
    }));
  }

  async function choose(next: AppIconKind, file?: File) {
    setBusy(next);
    try {
      if (next === "default") {
        const saved = await api.resetAppIcon();
        client.setQueryData(keys.settings, (current: Record<string, unknown> | undefined) => ({
          ...current,
          appIcon: saved,
        }));
      } else if (next === "colour") {
        await store(await renderColour(brand), { kind: "colour", colour: brand });
      } else if (next === "monogram") {
        const letters = monogram.trim() || domain.slice(0, 1).toUpperCase();
        setMonogram(letters);
        await store(await renderMonogram(letters, brand), {
          kind: "monogram",
          monogram: letters,
          colour: brand,
        });
      } else if (file) {
        await store(await renderCustom(file, brand), {
          kind: "custom",
          filename: file.name,
        });
      }

      toast.success("App icon updated", {
        description: "Already-installed devices pick it up within a few minutes.",
      });
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "That icon could not be saved",
        {
          description:
            error instanceof ApiError
              ? error.hint
              : error instanceof Error
                ? error.message
                : undefined,
        },
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-3">
      <div>
        <p className="text-[13px] font-medium">App icon</p>
        <p className="text-muted-foreground text-[12px] leading-relaxed">
          What Postbox looks like on a home screen once it is installed. Saved with the
          mailbox, so every device that installs it gets the same one.
        </p>
      </div>

      <div className="flex items-start gap-4">
        {/* The real file, at the real URL — not a mock-up of one. */}
        <img
          src={preview}
          alt=""
          width={64}
          height={64}
          className="size-16 shrink-0 rounded-[14px] border object-cover"
        />

        <div className="grid min-w-0 flex-1 grid-cols-2 gap-2">
          {OPTIONS.map((option) => (
            <button
              key={option.kind}
              type="button"
              aria-pressed={kind === option.kind}
              disabled={busy !== null}
              onClick={() =>
                option.kind === "custom" ? fileInput.current?.click() : choose(option.kind)
              }
              className={cn(
                "flex items-start gap-2 rounded-lg border p-2 text-left transition-colors",
                kind === option.kind ? "border-foreground/40 bg-accent" : "hover:bg-accent/50",
                busy !== null && "opacity-60",
              )}
            >
              <span className="text-muted-foreground mt-0.5">
                {busy === option.kind ? (
                  <LoaderCircleIcon className="size-3.5 animate-spin" />
                ) : kind === option.kind ? (
                  <CheckIcon className="size-3.5" />
                ) : option.kind === "monogram" ? (
                  <TypeIcon className="size-3.5" />
                ) : option.kind === "custom" ? (
                  <UploadIcon className="size-3.5" />
                ) : (
                  <ImageIcon className="size-3.5" />
                )}
              </span>
              <span className="min-w-0">
                <span className="block text-[12px] font-medium">{option.label}</span>
                <span className="text-muted-foreground block text-[11px] leading-snug">
                  {option.hint}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>

      {/*
        Shown only when the monogram is the live choice, because typing into a
        field that is not driving anything is the kind of thing that gets
        filled in and then wondered about.
      */}
      {kind === "monogram" && (
        <div className="flex items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="monogram" className="text-[12px]">
              Letters
            </Label>
            <Input
              id="monogram"
              value={monogram}
              maxLength={2}
              onChange={(event) => setMonogram(event.target.value.toUpperCase())}
              className="w-20 text-center"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null || monogram.trim() === (setting?.monogram ?? "")}
            onClick={() => choose("monogram")}
          >
            Redraw
          </Button>
        </div>
      )}

      {/*
        A PNG cannot follow a colour it was baked with, so rather than quietly
        leaving a home screen in last month's blue, say so and offer the one
        action that fixes it.
      */}
      {stale && (
        <div className="flex items-center gap-3 rounded-lg border border-dashed p-3">
          <p className="text-muted-foreground min-w-0 flex-1 text-[12px] leading-relaxed">
            The brand colour changed after this icon was drawn.
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => choose(kind)}
          >
            Redraw
          </Button>
        </div>
      )}

      <AppName domain={domain} />

      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/svg+xml,image/webp"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared so choosing the same file twice still fires a change.
          event.target.value = "";
          if (file) void choose("custom", file);
        }}
      />
    </section>
  );
}

/**
 * The label under the icon.
 *
 * A home screen truncates hard — roughly a dozen characters on iOS — so the
 * default is the domain rather than "Postbox", which would be indistinguishable
 * from a second install of the same app. Saved on blur rather than on every
 * keystroke: each write is a row in the access log, and that is a log worth
 * keeping readable.
 */
function AppName({ domain }: { domain: string }) {
  const client = useQueryClient();
  const settings = useSettings();
  const saved = (settings.data?.appName as string | undefined) ?? "";
  const [value, setValue] = useState(saved);
  const [known, setKnown] = useState(saved);

  // Adopt whatever the mailbox says once it arrives, unless it is being edited.
  if (saved !== known && value === known) {
    setKnown(saved);
    setValue(saved);
  }

  async function commit() {
    const next = value.trim();
    if (next === saved.trim()) return;
    client.setQueryData(keys.settings, (current: Record<string, unknown> | undefined) => ({
      ...current,
      appName: next,
    }));
    setKnown(next);
    try {
      await api.saveSettings({ appName: next });
    } catch {
      toast.error("The home-screen name did not save");
    }
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor="app-name" className="text-[12px]">
        Home-screen name
      </Label>
      <Input
        id="app-name"
        value={value}
        maxLength={24}
        placeholder={domain}
        onChange={(event) => setValue(event.target.value)}
        onBlur={commit}
        className="max-w-56"
      />
      <p className="text-muted-foreground text-[11px] leading-relaxed">
        Shown under the icon. Left empty, it is {domain}.
      </p>
    </div>
  );
}

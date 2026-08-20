import { useEffect, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import type { Address } from "@shared/types.ts";
import { useContacts } from "@/lib/queries.ts";
import { displayName } from "@/lib/format.ts";
import { cn } from "@/lib/utils.ts";

const EMAIL_RE = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;

/**
 * Recipient field.
 *
 * Behaves the way people already expect: type, then comma / Tab / Enter turns
 * it into a chip; Backspace on an empty field removes the last one; paste
 * accepts a whole comma- or newline-separated list at once. Suggestions come
 * from the address book the Worker builds from real correspondence.
 */
export function RecipientInput({
  label,
  value,
  onChange,
  autoFocus,
  placeholder,
}: {
  label: string;
  value: Address[];
  onChange: (next: Address[]) => void;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const suggestions = useContacts(draft.trim());
  const chosen = new Set(value.map((v) => v.address.toLowerCase()));
  const options = (suggestions.data ?? [])
    .filter((c) => !chosen.has(c.address.toLowerCase()))
    .slice(0, 6);

  useEffect(() => setHighlight(0), [draft]);

  useEffect(() => {
    function onClickAway(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickAway);
    return () => document.removeEventListener("mousedown", onClickAway);
  }, []);

  function commit(raw: string, name?: string) {
    const address = raw.trim().replace(/^<|>$/g, "").toLowerCase();
    if (!EMAIL_RE.test(address)) return false;
    if (chosen.has(address)) {
      setDraft("");
      return true;
    }
    onChange([...value, name ? { address, name } : { address }]);
    setDraft("");
    return true;
  }

  /** Everything up to the last separator is complete; the tail is still being typed. */
  function splitTrailing(text: string): [string, string] {
    const lastSeparator = Math.max(text.lastIndexOf(","), text.lastIndexOf(";"));
    return [text.slice(0, lastSeparator), text.slice(lastSeparator + 1)];
  }

  function commitMany(text: string) {
    const parts = text.split(/[,;\n]+/).map((p) => p.trim()).filter(Boolean);
    const added: Address[] = [];
    for (const part of parts) {
      const match = part.match(/<([^>]+)>/);
      const address = (match ? match[1] : part).trim().toLowerCase();
      if (EMAIL_RE.test(address) && !chosen.has(address)) {
        added.push({ address });
        chosen.add(address);
      }
    }
    if (added.length > 0) onChange([...value, ...added]);
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-start gap-2 border-b px-3 py-1.5">
        <span className="text-muted-foreground w-9 shrink-0 pt-1.5 text-[12px]">{label}</span>

        <div className="flex min-h-8 flex-1 flex-wrap items-center gap-1">
          {value.map((address) => (
            <span
              key={address.address}
              className="bg-muted group flex h-6 items-center gap-1 rounded-md pr-1 pl-2 text-[12px]"
            >
              <span className="max-w-[16rem] truncate">
                {address.name ? displayName(address) : address.address}
              </span>
              <button
                type="button"
                onClick={() => onChange(value.filter((v) => v.address !== address.address))}
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${address.address}`}
              >
                <XIcon className="size-3" />
              </button>
            </span>
          ))}

          <input
            ref={inputRef}
            autoFocus={autoFocus}
            value={draft}
            placeholder={value.length === 0 ? placeholder : undefined}
            onChange={(e) => {
              const next = e.target.value;
              // Separators can arrive without a keystroke — pasted text,
              // autofill, IME commit — so the value itself is the trigger
              // rather than the keydown.
              if (/[,;]/.test(next)) {
                const [committed, remainder] = splitTrailing(next);
                commitMany(committed);
                setDraft(remainder);
              } else {
                setDraft(next);
              }
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onPaste={(e) => {
              const text = e.clipboardData.getData("text");
              if (/[,;\n]/.test(text)) {
                e.preventDefault();
                commitMany(text);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
                const picked = open && options[highlight];
                if (picked && draft.trim()) {
                  e.preventDefault();
                  commit(picked.address, picked.name ?? undefined);
                  return;
                }
                if (draft.trim()) {
                  if (commit(draft)) e.preventDefault();
                }
                return;
              }
              if (e.key === "Backspace" && draft === "" && value.length > 0) {
                onChange(value.slice(0, -1));
                return;
              }
              if (e.key === "ArrowDown" && options.length > 0) {
                e.preventDefault();
                setOpen(true);
                setHighlight((h) => (h + 1) % options.length);
                return;
              }
              if (e.key === "ArrowUp" && options.length > 0) {
                e.preventDefault();
                setHighlight((h) => (h - 1 + options.length) % options.length);
                return;
              }
              if (e.key === "Escape" && open) {
                // Close the suggestion list without also closing the composer.
                e.stopPropagation();
                setOpen(false);
              }
            }}
            onBlur={() => {
              // Do not silently drop a half-typed valid address.
              if (draft.trim()) commit(draft);
            }}
            className="min-w-[8rem] flex-1 bg-transparent py-1 text-[13px] outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      {open && options.length > 0 && (
        <ul className="bg-popover absolute z-20 mt-1 w-full overflow-hidden rounded-lg border p-1 shadow-lg">
          {options.map((contact, index) => (
            <li key={contact.address}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(contact.address, contact.name ?? undefined);
                }}
                onMouseEnter={() => setHighlight(index)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]",
                  index === highlight && "bg-accent text-accent-foreground",
                )}
              >
                <span className="truncate font-medium">
                  {contact.name ?? displayName({ address: contact.address })}
                </span>
                <span className="text-muted-foreground truncate text-[11px]">
                  {contact.address}
                </span>
                <span className="text-muted-foreground ml-auto shrink-0 text-[10px] tabular-nums">
                  {contact.messageCount}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

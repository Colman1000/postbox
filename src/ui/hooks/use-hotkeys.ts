import { useEffect, useRef } from "react";

/**
 * Global keyboard shortcuts.
 *
 * Two rules keep this from fighting the rest of the app:
 *   - typing in a field never triggers a shortcut, unless it carries a modifier
 *   - sequences ("g" then "i") are supported, with a 900 ms window
 *
 * Handlers are kept in a ref so callers can pass fresh closures every render
 * without re-binding the listener.
 */

export type HotkeyMap = Record<string, (event: KeyboardEvent) => void>;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable ||
    target.getAttribute("role") === "textbox"
  );
}

function describe(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.metaKey) parts.push("mod");
  else if (event.ctrlKey) parts.push("mod");
  if (event.shiftKey) parts.push("shift");
  if (event.altKey) parts.push("alt");

  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  parts.push(key);
  return parts.join("+");
}

export function useHotkeys(map: HotkeyMap, enabled = true) {
  const mapRef = useRef(map);
  mapRef.current = map;

  const sequence = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    if (!enabled) return;

    function onKeyDown(event: KeyboardEvent) {
      const combo = describe(event);
      const hasModifier = event.metaKey || event.ctrlKey || event.altKey;

      // Escape always works, even mid-typing — it is the universal way out.
      if (isTypingTarget(event.target) && !hasModifier && event.key !== "Escape") {
        sequence.current = null;
        return;
      }

      // Sequence continuation, e.g. "g i".
      const pending = sequence.current;
      if (pending && Date.now() - pending.at < 900) {
        const handler = mapRef.current[`${pending.key} ${combo}`];
        sequence.current = null;
        if (handler) {
          event.preventDefault();
          handler(event);
          return;
        }
      }

      // Start a sequence if any binding uses this key as a prefix.
      if (
        !hasModifier &&
        Object.keys(mapRef.current).some((k) => k.startsWith(`${combo} `))
      ) {
        sequence.current = { key: combo, at: Date.now() };
        return;
      }

      const handler = mapRef.current[combo];
      if (handler) {
        event.preventDefault();
        handler(event);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}

/** Rendered in the shortcuts sheet and the command palette. */
export const SHORTCUTS: { keys: string[]; label: string; group: string }[] = [
  { keys: ["c"], label: "Compose", group: "Actions" },
  { keys: ["r"], label: "Reply", group: "Actions" },
  { keys: ["a"], label: "Reply all", group: "Actions" },
  { keys: ["f"], label: "Forward", group: "Actions" },
  { keys: ["e"], label: "Archive", group: "Actions" },
  { keys: ["#"], label: "Move to trash", group: "Actions" },
  { keys: ["s"], label: "Star / unstar", group: "Actions" },
  { keys: ["u"], label: "Mark unread", group: "Actions" },
  { keys: ["b"], label: "Snooze", group: "Actions" },
  { keys: ["!"], label: "Report spam", group: "Actions" },
  { keys: ["j"], label: "Next conversation", group: "Navigation" },
  { keys: ["k"], label: "Previous conversation", group: "Navigation" },
  { keys: ["Enter"], label: "Open conversation", group: "Navigation" },
  { keys: ["Esc"], label: "Back to the list", group: "Navigation" },
  { keys: ["g", "i"], label: "Go to Inbox", group: "Navigation" },
  { keys: ["g", "s"], label: "Go to Sent", group: "Navigation" },
  { keys: ["g", "d"], label: "Go to Drafts", group: "Navigation" },
  { keys: ["g", "a"], label: "Go to Archive", group: "Navigation" },
  { keys: ["g", "t"], label: "Go to Trash", group: "Navigation" },
  { keys: ["/"], label: "Search", group: "Navigation" },
  { keys: ["⌘", "K"], label: "Command palette", group: "Navigation" },
  { keys: ["⌘", "Enter"], label: "Send", group: "Compose" },
  { keys: ["⌘", "⇧", "Enter"], label: "Schedule send", group: "Compose" },
  { keys: ["Esc"], label: "Close composer", group: "Compose" },
  { keys: ["⌘", "B"], label: "Bold", group: "Formatting" },
  { keys: ["⌘", "I"], label: "Italic", group: "Formatting" },
  { keys: ["⌘", "U"], label: "Underline", group: "Formatting" },
  { keys: ["⌘", "K"], label: "Add a link", group: "Formatting" },
  { keys: ["⌘", "⇧", "M"], label: "Edit as Markdown", group: "Formatting" },
  { keys: ["-", "Space"], label: "Bulleted list", group: "Formatting" },
  { keys: ["1", ".", "Space"], label: "Numbered list", group: "Formatting" },
  { keys: ["[", "]", "Space"], label: "Checklist", group: "Formatting" },
  { keys: ["#", "Space"], label: "Heading", group: "Formatting" },
  { keys: [">", "Space"], label: "Quote", group: "Formatting" },
  { keys: ["?"], label: "This list", group: "Help" },
  { keys: ["⌘", "/"], label: "This list", group: "Help" },
];

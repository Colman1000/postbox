/**
 * `#rrggbb`, lowercased — or null for anything else.
 *
 * Shared because both sides need it and neither can trust the other: the UI
 * writes this value into a CSS custom property, and the Worker writes it into
 * the manifest as `theme_color`. It arrives from the database in both cases,
 * so "looks like a colour" is not good enough — only the two hex forms get
 * through, and everything else becomes the absence of a brand colour.
 */
export function normalizeHex(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim().toLowerCase();
  const short = /^#([0-9a-f]{3})$/.exec(value);
  if (short) return `#${[...short[1]].map((digit) => digit + digit).join("")}`;
  return /^#[0-9a-f]{6}$/.test(value) ? value : null;
}

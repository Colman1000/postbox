/**
 * The brand colour.
 *
 * Postbox is monochrome by construction — see the note at the top of
 * index.css — and this is the one deliberate hole in it. What gets stored is a
 * hue and a saturation, not a shade: the interface keeps its own lightness, so
 * whatever you pick still reads at 11px against both backgrounds. Two blues an
 * eyedropper apart therefore land in the same place, which is the trade.
 *
 * The value lives in the mailbox's settings, so the colour follows you to a
 * new browser, and is mirrored here in localStorage because it has to be on
 * the root element before the first paint — a brand colour that arrives a
 * round-trip late is a flash of the wrong one.
 */

const STORAGE_KEY = "postbox:brand";

export interface BrandPreset {
  name: string;
  hex: string;
}

/** Enough range to find your own in; short enough to choose from at a glance. */
export const BRAND_PRESETS: BrandPreset[] = [
  { name: "Cobalt", hex: "#2563eb" },
  { name: "Indigo", hex: "#4f46e5" },
  { name: "Violet", hex: "#7c3aed" },
  { name: "Magenta", hex: "#db2777" },
  { name: "Crimson", hex: "#dc2626" },
  { name: "Amber", hex: "#d97706" },
  { name: "Forest", hex: "#16a34a" },
  { name: "Teal", hex: "#0d9488" },
];

/**
 * `#rrggbb`, lowercased — or null for anything else.
 *
 * This value is written into a CSS custom property and it arrives from the
 * database, so "looks like a colour" is not good enough: only the two hex
 * forms get through.
 */
export function normalizeHex(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim().toLowerCase();
  const short = /^#([0-9a-f]{3})$/.exec(value);
  if (short) return `#${[...short[1]].map((digit) => digit + digit).join("")}`;
  return /^#[0-9a-f]{6}$/.test(value) ? value : null;
}

export function readBrand(): string | null {
  try {
    return normalizeHex(localStorage.getItem(STORAGE_KEY));
  } catch {
    /* private mode */
    return null;
  }
}

/**
 * Put the colour on the document, or take it off again.
 *
 * Returns what was actually applied, so a caller that passed something the
 * interface refused ends up holding the same value the page is showing.
 */
export function applyBrand(hex: unknown): string | null {
  const value = normalizeHex(hex);
  const root = document.documentElement;

  if (value) {
    root.style.setProperty("--brand", value);
    root.dataset.brand = "";
  } else {
    root.style.removeProperty("--brand");
    delete root.dataset.brand;
  }

  try {
    if (value) localStorage.setItem(STORAGE_KEY, value);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private mode */
  }

  return value;
}

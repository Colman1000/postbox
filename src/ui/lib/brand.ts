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

import { normalizeHex } from "@shared/colour.ts";

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
 * Defined in `@shared` because the Worker validates the same value on its way
 * into the manifest's `theme_color`, and two copies of a validator is one copy
 * too many. Re-exported here so this stays the one place the UI imports
 * anything about the brand colour from.
 */
export { normalizeHex } from "@shared/colour.ts";

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

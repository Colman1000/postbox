import { APP_ICON_SIZE, MAX_APP_ICON_BYTES, type AppIconSetting } from "@shared/types.ts";
import { normalizeHex } from "@shared/colour.ts";

/**
 * Drawing the home-screen icon.
 *
 * This is the browser's job rather than the Worker's, and not by preference: a
 * canvas can scale an uploaded logo and render a letter in a real typeface,
 * and a Worker has no image library and a CPU budget measured in
 * milliseconds. So every choice below is rendered here, at the moment it is
 * made, and what reaches the server is a finished 512-pixel PNG it only has to
 * check and store.
 *
 * Two variants come out of every choice, because Android crops one of them:
 *
 *   any        drawn as-is, so it rounds its own corners
 *   maskable   full bleed, with the content inside the central circle that
 *              survives whatever shape the launcher crops to
 *
 * The icon Postbox ships is neither of these — it is a static asset, drawn at
 * build time by `scripts/make-icons.mjs` — so choosing "Default" deletes
 * rather than uploads.
 */

const SIZE = APP_ICON_SIZE;
/** Corner radius, as a fraction of the edge. Matches the shipped icon's 8/32. */
const RADIUS = 0.25;
/**
 * How much of a maskable tile the content may use.
 *
 * The guaranteed-visible region is the central 80% circle; 78% of the edge
 * keeps a square logo's corners inside it with a little room to spare.
 */
const SAFE = 0.78;

const INK_LIGHT = "#fafafa";
const INK_DARK = "#0a0a0a";
const DEFAULT_TILE = "#0a0a0a";

/**
 * Which ink reads on this tile.
 *
 * Relative luminance rather than a lightness cut-off, because the brand
 * palette runs from amber to indigo and those two disagree about which is the
 * bright one everywhere except here.
 *
 * The threshold is not a taste call. WCAG contrast is
 * `(lighter + 0.05) / (darker + 0.05)`, so black and white are equally legible
 * on a tile at `sqrt(1.05 * 0.05) - 0.05`, and whichever side of that the tile
 * falls on has the better of the two. Amber is the case that proves it matters:
 * it looks dark enough for white ink and is not — black clears 6:1 there where
 * white manages barely 3:1.
 */
const INK_CROSSOVER = Math.sqrt(1.05 * 0.05) - 0.05;

export function inkFor(background: string | null): string {
  const hex = normalizeHex(background) ?? DEFAULT_TILE;
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > INK_CROSSOVER ? INK_DARK : INK_LIGHT;
}

function canvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const element = document.createElement("canvas");
  element.width = SIZE;
  element.height = SIZE;
  const context = element.getContext("2d");
  if (!context) throw new Error("This browser would not give us a canvas to draw on.");
  return [element, context];
}

/** The tile, rounded for `any` and square for `maskable`. */
function fillTile(
  context: CanvasRenderingContext2D,
  colour: string,
  purpose: "any" | "maskable",
): void {
  context.fillStyle = colour;
  context.beginPath();
  if (purpose === "any" && typeof context.roundRect === "function") {
    context.roundRect(0, 0, SIZE, SIZE, SIZE * RADIUS);
  } else {
    context.rect(0, 0, SIZE, SIZE);
  }
  context.fill();
}

function toPng(element: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    element.toBlob((blob) => {
      if (!blob) reject(new Error("The icon could not be encoded."));
      else if (blob.size > MAX_APP_ICON_BYTES) {
        reject(
          new Error(
            `That image is still ${Math.round(blob.size / 1024)} KB once resized, ` +
              `over the ${MAX_APP_ICON_BYTES / 1024} KB limit. Try a simpler image.`,
          ),
        );
      } else resolve(blob);
    }, "image/png");
  });
}

// ── the envelope, from the same source as the favicon ───────────────────────

/**
 * `public/favicon.svg` with its two colours substituted.
 *
 * Rasterising the SVG is what keeps this mark identical to the favicon and to
 * the shipped PNGs without a third copy of the geometry: change the SVG and
 * every one of them follows.
 */
function envelopeSvg(tile: string, ink: string, inset: number): string {
  const scale = inset;
  const offset = (32 - 32 * scale) / 2;
  // `width` and `height` as well as `viewBox`: an SVG with only a viewBox has
  // no intrinsic size, and a browser that reports one as 0x0 draws nothing.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 32 32">
  <rect width="32" height="32" fill="${tile}"/>
  <g transform="translate(${offset} ${offset}) scale(${scale})">
    <path d="M7 11.5A2.5 2.5 0 0 1 9.5 9h13a2.5 2.5 0 0 1 2.5 2.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 7 20.5v-9Z"
          fill="none" stroke="${ink}" stroke-width="2" stroke-linejoin="round"/>
    <path d="m7.8 11 7.3 5.4a1.5 1.5 0 0 0 1.8 0L24.2 11"
          fill="none" stroke="${ink}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("That image could not be read."));
    image.src = source;
  });
}

async function loadSvg(markup: string): Promise<HTMLImageElement> {
  // A data URL rather than a blob URL: Safari will not decode an SVG from a
  // blob URL into a canvas without tainting it, and a tainted canvas cannot be
  // read back — which is the entire point of drawing it.
  return loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`);
}

// ── the four ways to have an icon ───────────────────────────────────────────

export interface RenderedIcon {
  any: Blob;
  maskable: Blob;
}

/** The Postbox envelope, on a colour of your choosing. */
export async function renderColour(brand: string | null): Promise<RenderedIcon> {
  const tile = normalizeHex(brand) ?? DEFAULT_TILE;
  const ink = inkFor(tile);

  const draw = async (purpose: "any" | "maskable") => {
    const [element, context] = canvas();
    // The mark already sits well inside the shipped tile, so a maskable
    // variant only has to pull it in a little further.
    const image = await loadSvg(envelopeSvg(tile, ink, purpose === "maskable" ? SAFE : 1));
    fillTile(context, tile, purpose);
    context.save();
    if (purpose === "any" && typeof context.roundRect === "function") {
      context.beginPath();
      context.roundRect(0, 0, SIZE, SIZE, SIZE * RADIUS);
      context.clip();
    }
    context.drawImage(image, 0, 0, SIZE, SIZE);
    context.restore();
    return toPng(element);
  };

  return { any: await draw("any"), maskable: await draw("maskable") };
}

/**
 * One or two letters, in the interface's own typeface.
 *
 * Sized against the measured width rather than a fixed point size: "W" and "I"
 * are not the same shape, and a monogram that overflows its tile looks like a
 * bug rather than a choice.
 */
export async function renderMonogram(
  letters: string,
  brand: string | null,
): Promise<RenderedIcon> {
  const text = letters.trim().slice(0, 2).toUpperCase() || "M";
  const tile = normalizeHex(brand) ?? DEFAULT_TILE;
  const ink = inkFor(tile);

  const draw = (purpose: "any" | "maskable") => {
    const [element, context] = canvas();
    fillTile(context, tile, purpose);

    const budget = SIZE * (purpose === "maskable" ? SAFE : 0.82);
    context.fillStyle = ink;
    context.textAlign = "center";
    context.textBaseline = "middle";

    // Start from a size that suits a single wide letter, then shrink until the
    // measurement actually fits.
    let fontSize = Math.round(budget * (text.length === 1 ? 0.86 : 0.58));
    const font = (size: number) =>
      `600 ${size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

    context.font = font(fontSize);
    while (context.measureText(text).width > budget && fontSize > 16) {
      fontSize -= 8;
      context.font = font(fontSize);
    }

    // Optical centring: `middle` sits on the em box, which leaves capitals
    // looking slightly high. Nudging by the difference between the em centre
    // and the cap centre puts them where the eye expects.
    const metrics = context.measureText(text);
    const capHeight =
      (metrics.actualBoundingBoxAscent ?? fontSize * 0.7) +
      (metrics.actualBoundingBoxDescent ?? 0);
    const nudge = (metrics.actualBoundingBoxAscent ?? fontSize * 0.7) - capHeight / 2;

    context.fillText(text, SIZE / 2, SIZE / 2 + nudge);
    return toPng(element);
  };

  return { any: await draw("any"), maskable: await draw("maskable") };
}

/**
 * Read an uploaded image, whatever it turns out to be.
 *
 * Bitmaps go through an object URL, which is the cheap path. SVGs need
 * handling: a great many logos are exported with a `viewBox` and no `width`,
 * which leaves them with no intrinsic size and makes `drawImage` a no-op. One
 * is given to them if it is missing.
 */
async function loadUpload(file: File): Promise<HTMLImageElement> {
  if (file.type === "image/svg+xml") {
    const markup = await file.text();
    return loadSvg(
      /<svg[^>]*\swidth\s*=/.test(markup)
        ? markup
        : markup.replace(/<svg\b/, `<svg width="${SIZE}" height="${SIZE}"`),
    );
  }

  const source = URL.createObjectURL(file);
  try {
    return await loadImage(source);
  } finally {
    URL.revokeObjectURL(source);
  }
}

/**
 * Somebody's own logo.
 *
 * Scaled to cover rather than to fit, so a slightly non-square image fills the
 * tile instead of sitting in a letterbox. The maskable variant does the
 * opposite — the whole image, shrunk into the safe circle — because cropping
 * a logo twice, once here and once by the launcher, is how a wordmark loses
 * its last letter.
 */
export async function renderCustom(file: File, brand: string | null): Promise<RenderedIcon> {
  if (!file.type.startsWith("image/")) {
    throw new Error("That is not an image.");
  }

  const image = await loadUpload(file);
  if (!image.width || !image.height) {
    throw new Error("That image reports no size, so it cannot be scaled.");
  }

  const tile = normalizeHex(brand) ?? DEFAULT_TILE;

  const cover = () => {
    const [element, context] = canvas();
    // A transparent PNG still needs something behind it once it is a tile.
    fillTile(context, tile, "any");
    context.save();
    if (typeof context.roundRect === "function") {
      context.beginPath();
      context.roundRect(0, 0, SIZE, SIZE, SIZE * RADIUS);
      context.clip();
    }
    const scale = Math.max(SIZE / image.width, SIZE / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    context.drawImage(image, (SIZE - width) / 2, (SIZE - height) / 2, width, height);
    context.restore();
    return toPng(element);
  };

  const contain = () => {
    const [element, context] = canvas();
    fillTile(context, tile, "maskable");
    const scale = Math.min((SIZE * SAFE) / image.width, (SIZE * SAFE) / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    context.drawImage(image, (SIZE - width) / 2, (SIZE - height) / 2, width, height);
    return toPng(element);
  };

  return { any: await cover(), maskable: await contain() };
}

/**
 * Whether a rendered choice still matches the brand colour it was drawn on.
 *
 * Changing the brand colour cannot repaint a PNG, so Settings offers to redraw
 * rather than silently leaving a home screen in last week's colour.
 */
export function iconIsStale(setting: AppIconSetting | null, brand: string | null): boolean {
  if (!setting || setting.kind === "default" || setting.kind === "custom") return false;
  return (normalizeHex(setting.colour) ?? null) !== (normalizeHex(brand) ?? null);
}

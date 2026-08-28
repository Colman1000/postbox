/**
 * The default app icon, drawn rather than shipped.
 *
 * A home-screen icon has to be a PNG — iOS will not take an SVG for
 * `apple-touch-icon`, and a maskable icon has to be raster to be masked — but
 * committing four opaque binaries and hoping they still match the favicon is
 * how a mark drifts. So the mark lives here as geometry, in the same 32-unit
 * space as `public/favicon.svg`, and `just icons` renders it.
 *
 * Rendering is a signed-distance field sampled 4x and boxed down, which is a
 * page of arithmetic instead of a dependency. It runs on a laptop at build
 * time, never in a Worker: the free plan's CPU budget per request is measured
 * in milliseconds and this is measured in seconds.
 *
 *   node scripts/make-icons.mjs
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/** Ink and paper, matching favicon.svg exactly. */
const PAPER = [0x0a, 0x0a, 0x0a];
const INK = [0xfa, 0xfa, 0xfa];

/** Everything below is expressed in the favicon's 32x32 space. */
const BOX = 32;
/** Corner radius of the tile, for the variants that round their own corners. */
const TILE_RADIUS = 8;
/** Half the stroke the envelope is drawn with. */
const STROKE = 1;

const SUPERSAMPLE = 4;

// ── signed distance fields ───────────────────────────────────────────────────

/** Negative inside. `h*` are half-extents, `r` the corner radius. */
function sdRoundBox(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - hx + r;
  const qy = Math.abs(py - cy) - hy + r;
  return (
    Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r
  );
}

/** Unsigned distance to a segment; a stroke is this minus its half-width. */
function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const len = bax * bax + bay * bay;
  const h = len === 0 ? 0 : Math.max(0, Math.min(1, (pax * bax + pay * bay) / len));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

/**
 * The envelope: a rounded rectangle drawn as an outline, and the flap as two
 * strokes meeting just below the middle. Round joins and caps come free —
 * a segment's distance field is already a capsule.
 */
function insideMark(x, y, scale) {
  const cx = BOX / 2;
  const cy = BOX / 2;

  // Body: x 7..25, y 9..23 in favicon.svg.
  const body = Math.abs(sdRoundBox(x, y, cx, cy, 9 * scale, 7 * scale, 2.5 * scale));
  if (body <= STROKE * scale) return true;

  // Flap: from each top corner down to the centre of the body.
  const ax = cx - 8.2 * scale;
  const ay = cy - 5 * scale;
  const bx = cx;
  const by = cy + 0.85 * scale;
  const dx = cx + 8.2 * scale;

  return (
    sdSegment(x, y, ax, ay, bx, by) <= STROKE * scale ||
    sdSegment(x, y, dx, ay, bx, by) <= STROKE * scale
  );
}

// ── rasteriser ───────────────────────────────────────────────────────────────

/**
 * @param size    output edge in pixels
 * @param radius  tile corner radius in the 32-unit space; 0 for a full bleed
 * @param scale   how much of the tile the mark fills; < 1 pulls it into the
 *                safe circle a maskable icon is cropped to
 */
function render(size, radius, scale = 1, monochrome = false) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = BOX / (size * SUPERSAMPLE);
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = (px * SUPERSAMPLE + sx + 0.5) * step;
          const y = (py * SUPERSAMPLE + sy + 0.5) * step;

          const onMark = insideMark(x, y, scale);

          // A badge is the glyph alone: Android recolours it to whatever suits
          // the status bar and throws away everything but the alpha channel,
          // so a tile behind it would come back as a solid block.
          if (monochrome) {
            if (!onMark) continue;
            r += INK[0];
            g += INK[1];
            b += INK[2];
            a += 255;
            continue;
          }

          const onTile =
            radius === 0
              ? true
              : sdRoundBox(x, y, BOX / 2, BOX / 2, BOX / 2, BOX / 2, radius) <= 0;
          if (!onTile) continue;

          // Premultiplied, so the tile's own edge antialiases against nothing
          // rather than against black.
          const colour = onMark ? INK : PAPER;
          r += colour[0];
          g += colour[1];
          b += colour[2];
          a += 255;
        }
      }

      const offset = (py * size + px) * 4;
      if (a === 0) continue;
      pixels[offset] = Math.round(r / (a / 255));
      pixels[offset + 1] = Math.round(g / (a / 255));
      pixels[offset + 2] = Math.round(b / (a / 255));
      pixels[offset + 3] = Math.round(a / samples);
    }
  }

  return pixels;
}

// ── PNG container ────────────────────────────────────────────────────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(pixels, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // truecolour with alpha
  // compression, filter, interlace — all the only value PNG defines.

  // One filter byte per scanline. Nothing here has gradients worth predicting,
  // so "none" compresses as well as anything and keeps this readable.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const from = y * size * 4;
    pixels.copy(raw, y * (size * 4 + 1) + 1, from, from + size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── the four files ───────────────────────────────────────────────────────────

/**
 * Why each one exists:
 *
 *   192 / 512   the manifest's `any` icons. Rounded, transparent outside the
 *               tile, because Android and the desktop install prompt draw them
 *               as-is.
 *   maskable    full bleed, mark pulled into the central 80% that Android
 *               guarantees survives whatever shape it crops to.
 *   apple       square and opaque. iOS applies its own squircle, and an icon
 *               that arrives pre-rounded gets rounded twice.
 *   badge       the little glyph Android puts in the status bar next to a
 *               notification. Alpha only — the colour is the platform's.
 */
const VARIANTS = [
  { file: "postbox-192.png", size: 192, radius: TILE_RADIUS, scale: 1 },
  { file: "postbox-512.png", size: 512, radius: TILE_RADIUS, scale: 1 },
  { file: "postbox-maskable-512.png", size: 512, radius: 0, scale: 0.78 },
  { file: "postbox-apple-180.png", size: 180, radius: 0, scale: 1 },
  { file: "badge.png", size: 96, radius: 0, scale: 1.05, monochrome: true },
];

const outDir = path.resolve(import.meta.dirname, "..", "public", "icons");
fs.mkdirSync(outDir, { recursive: true });

for (const variant of VARIANTS) {
  const png = encodePng(
    render(variant.size, variant.radius, variant.scale, variant.monochrome ?? false),
    variant.size,
  );
  fs.writeFileSync(path.join(outDir, variant.file), png);
  console.log(`  ${variant.file.padEnd(28)} ${String(png.length).padStart(6)} bytes`);
}

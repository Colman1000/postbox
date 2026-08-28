import { Hono } from "hono";
import { normalizeHex } from "../../shared/colour.ts";
import {
  APP_ICON_SIZE,
  MAX_APP_ICON_BYTES,
  type AppIconSetting,
} from "../../shared/types.ts";
import { toBytes } from "../lib/blob.ts";
import type { Env, Vars } from "../env.ts";
import type { App } from "./context.ts";

/**
 * The home-screen identity: a manifest, and the icon it points at.
 *
 * All of this is public, and has to be. A manifest is fetched by the browser
 * without credentials, and the icon is fetched by the operating system — often
 * long after the tab that installed it is gone, sometimes by a process that
 * has never held a cookie. What it discloses is the mailbox's domain, which is
 * in the URL that was typed to get here.
 *
 * The bytes are only ever served from here when somebody has chosen their own
 * icon. The one Postbox ships is a static asset (`public/icons/`, drawn by
 * `scripts/make-icons.mjs`), and static assets on Workers are free and
 * unmetered — so the default costs nothing to serve and only a customised
 * mailbox pays a request for it.
 */

/** Both variants the manifest declares. See migrations/0003_push.sql. */
type Purpose = "any" | "maskable";

const DEFAULT_ICONS: Record<Purpose, string> = {
  any: "/icons/postbox-512.png",
  maskable: "/icons/postbox-maskable-512.png",
};

/**
 * The small one, listed alongside the 512 in the default case.
 *
 * Chrome's installability check wants a 192 as well as a 512, and a launcher
 * that has both scales neither. A chosen icon has no 192 — the picker renders
 * one size — so this is only ever offered for the icon Postbox ships, which is
 * also the only case where showing a second file cannot show the wrong brand.
 */
const DEFAULT_ICON_SMALL = "/icons/postbox-192.png";

/** Where iOS looks, and what it accepts: PNG, square, no manifest involved. */
const DEFAULT_APPLE_ICON = "/icons/postbox-apple-180.png";

async function readSetting<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{
    value: string;
  }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

async function storedIcon(
  db: D1Database,
  purpose: Purpose,
): Promise<{ bytes: Uint8Array; mimeType: string; updatedAt: number } | null> {
  const row = await db
    .prepare("SELECT bytes, mime_type, updated_at FROM app_icons WHERE purpose = ?")
    .bind(purpose)
    .first<{ bytes: unknown; mime_type: string; updated_at: number }>();
  if (!row) return null;

  const bytes = toBytes(row.bytes);
  if (bytes.length === 0) return null;
  return { bytes, mimeType: row.mime_type, updatedAt: row.updated_at };
}

/**
 * Serve a chosen icon, or hand the request on to the one we ship.
 *
 * The fallback is an internal fetch of the static asset rather than a
 * redirect: iOS follows a redirect for `apple-touch-icon` inconsistently, and
 * a home screen showing a screenshot of the login page instead of an icon is
 * the exact failure this whole route exists to prevent.
 */
async function serveIcon(env: Env, purpose: Purpose, fallback: string, request: Request) {
  const icon = await storedIcon(env.DB, purpose);

  if (!icon) {
    const url = new URL(request.url);
    url.pathname = fallback;
    url.search = "";
    return env.ASSETS.fetch(new Request(url, { headers: request.headers }));
  }

  // Weak revalidation on the timestamp: the manifest carries the same value as
  // a cache buster, but `apple-touch-icon` is fetched from a fixed path with
  // no query to bust, so the ETag is what lets a changed icon actually land.
  const etag = `"icon-${purpose}-${icon.updatedAt}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  return new Response(icon.bytes, {
    headers: {
      "Content-Type": icon.mimeType,
      "Content-Length": String(icon.bytes.length),
      ETag: etag,
      "Cache-Control": "public, max-age=3600, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// ── public: the manifest and the icons it names ─────────────────────────────

export const icon = new Hono<{ Bindings: Env; Variables: Vars }>();

icon.get("/manifest.webmanifest", async (c) => {
  const [setting, brand, name] = await Promise.all([
    readSetting<AppIconSetting>(c.env.DB, "appIcon"),
    readSetting<string>(c.env.DB, "brand"),
    readSetting<string>(c.env.DB, "appName"),
  ]);

  const custom = setting && setting.kind !== "default";
  // Only ever appended to our own routes, and only from a number we wrote.
  const version = custom ? `?v=${setting.updatedAt ?? 0}` : "";

  const label = (name ?? "").trim() || c.env.MAIL_DOMAIN;
  // The tile behind a translucent splash screen, and the colour iOS paints
  // behind the app while it launches. Ink unless a brand colour was chosen.
  const themeColour = normalizeHex(brand) ?? "#0a0a0a";

  return c.json(
    {
      id: "/",
      name: `${label} — Postbox`,
      // What actually fits under a home-screen icon.
      short_name: label.slice(0, 24),
      description: `Mail for ${c.env.MAIL_DOMAIN}.`,
      start_url: "/",
      scope: "/",
      display: "standalone",
      orientation: "any",
      background_color: "#0a0a0a",
      theme_color: themeColour,
      categories: ["productivity", "communication"],
      icons: [
        ...(custom
          ? []
          : [{ src: DEFAULT_ICON_SMALL, sizes: "192x192", type: "image/png", purpose: "any" }]),
        {
          src: custom ? `/icons/app.png${version}` : DEFAULT_ICONS.any,
          sizes: `${APP_ICON_SIZE}x${APP_ICON_SIZE}`,
          type: "image/png",
          purpose: "any",
        },
        {
          src: custom ? `/icons/app-maskable.png${version}` : DEFAULT_ICONS.maskable,
          sizes: `${APP_ICON_SIZE}x${APP_ICON_SIZE}`,
          type: "image/png",
          purpose: "maskable",
        },
      ],
    },
    200,
    {
      "Content-Type": "application/manifest+json; charset=utf-8",
      // Short, because this is what a device re-reads to notice a new icon.
      "Cache-Control": "public, max-age=300",
    },
  );
});

icon.get("/icons/app.png", (c) =>
  serveIcon(c.env, "any", DEFAULT_ICONS.any, c.req.raw),
);

icon.get("/icons/app-maskable.png", (c) =>
  serveIcon(c.env, "maskable", DEFAULT_ICONS.maskable, c.req.raw),
);

/**
 * iOS asks for this path by name, whether or not the page links to it, and
 * takes no notice of the manifest's icons when adding to the Home Screen.
 */
icon.get("/apple-touch-icon.png", (c) =>
  serveIcon(c.env, "any", DEFAULT_APPLE_ICON, c.req.raw),
);

// ── authenticated: choosing one ─────────────────────────────────────────────

export const iconAdmin = new Hono<App>();

/** `\x89PNG\r\n\x1a\n` — and then IHDR, which carries the dimensions. */
function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((byte, i) => bytes[i] !== byte)) return null;

  // IHDR is the first chunk by definition: 8 bytes of signature, 4 of length,
  // 4 of type, then width and height.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * Store a chosen icon.
 *
 * Both variants arrive already rendered at the right size, because the browser
 * is the only side of this that can render anything: a canvas scales an
 * uploaded logo and draws a monogram in a real typeface, and a Worker with no
 * image library and a millisecond CPU budget can do neither. What the server
 * does is check that what arrived is what was promised — the alternative is
 * serving whatever bytes were posted as `image/png` to every device that
 * installs the app.
 */
iconAdmin.post("/icon", async (c) => {
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: "Expected a multipart upload." }, 400);

  let meta: AppIconSetting;
  try {
    meta = JSON.parse(String(form.get("meta") ?? "")) as AppIconSetting;
  } catch {
    return c.json({ error: "The icon description was missing or malformed." }, 400);
  }
  if (!["colour", "monogram", "custom"].includes(meta.kind)) {
    return c.json({ error: "Unknown icon kind." }, 400);
  }

  const now = Date.now();
  const statements: D1PreparedStatement[] = [];

  for (const purpose of ["any", "maskable"] as const) {
    const part = form.get(purpose);
    if (!(part instanceof File)) {
      return c.json({ error: `The ${purpose} icon was missing.` }, 400);
    }
    if (part.size > MAX_APP_ICON_BYTES) {
      return c.json(
        {
          error: "That icon is too large to store.",
          hint: `${Math.round(part.size / 1024)} KB, against a ${MAX_APP_ICON_BYTES / 1024} KB cap.`,
        },
        413,
      );
    }

    // Bound as an ArrayBuffer, which is what D1 takes for a BLOB — the same
    // shape the attachment upload path uses.
    const content = await part.arrayBuffer();
    const size = pngDimensions(new Uint8Array(content));
    if (!size) return c.json({ error: "Icons have to be PNG." }, 415);
    if (size.width !== APP_ICON_SIZE || size.height !== APP_ICON_SIZE) {
      return c.json(
        {
          error: "Icons have to be square and exactly the expected size.",
          hint: `Got ${size.width}x${size.height}, expected ${APP_ICON_SIZE}x${APP_ICON_SIZE}.`,
        },
        400,
      );
    }

    statements.push(
      c.env.DB.prepare(
        `INSERT INTO app_icons (purpose, mime_type, bytes, updated_at)
         VALUES (?, 'image/png', ?, ?)
         ON CONFLICT (purpose) DO UPDATE SET
           bytes = excluded.bytes, mime_type = excluded.mime_type,
           updated_at = excluded.updated_at`,
      ).bind(purpose, content, now),
    );
  }

  const setting: AppIconSetting = { ...meta, updatedAt: now };
  statements.push(
    c.env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('appIcon', ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(JSON.stringify(setting), now),
  );

  await c.env.DB.batch(statements);

  c.set("auditDetail", `changed the app icon to ${meta.kind}`);
  return c.json(setting);
});

/** Back to the icon Postbox ships, and back to serving it for free. */
iconAdmin.delete("/icon", async (c) => {
  const now = Date.now();
  const setting: AppIconSetting = { kind: "default", updatedAt: now };

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM app_icons"),
    c.env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('appIcon', ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(JSON.stringify(setting), now),
  ]);

  c.set("auditDetail", "reset the app icon");
  return c.json(setting);
});

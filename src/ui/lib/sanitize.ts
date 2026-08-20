import DOMPurify from "dompurify";

/**
 * Rendering someone else's HTML.
 *
 * Two separate problems, handled separately:
 *
 *   Safety   — DOMPurify strips scripts, event handlers and anything that
 *              could reach the app's own origin. Links are forced to open in a
 *              new tab with `noopener`, so a message can never navigate the
 *              mailbox itself.
 *
 *   Privacy  — remote images are tracking pixels as often as they are content.
 *              They are held back by default and swapped in only when the
 *              reader asks, per message.
 */

let configured = false;

function configure() {
  if (configured) return;
  configured = true;

  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
    }
  });
}

const ALLOWED_SCHEMES = /^(https?|mailto|tel|cid):/i;

export interface SanitizeResult {
  html: string;
  /** How many remote images were withheld, so the UI can say so precisely. */
  blockedImages: number;
}

export function sanitizeEmailHtml(
  input: string,
  options: {
    showImages: boolean;
    /** Content-ID → local attachment URL, for images embedded in the message. */
    inlineImages?: Map<string, string>;
  },
): SanitizeResult {
  configure();

  const clean = DOMPurify.sanitize(input, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "base", "link", "meta"],
    FORBID_ATTR: ["srcset", "ping", "formaction"],
    ALLOW_DATA_ATTR: false,
    RETURN_DOM_FRAGMENT: false,
    RETURN_DOM: false,
  });

  // Post-process in a detached document so nothing loads while we work.
  const doc = new DOMParser().parseFromString(`<body>${clean}</body>`, "text/html");
  let blockedImages = 0;

  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const src = img.getAttribute("src") ?? "";
    if (!src || !ALLOWED_SCHEMES.test(src)) {
      img.remove();
      continue;
    }
    // `cid:` points at a part of this very message; resolve it to the stored
    // attachment so embedded images work without any remote fetch at all.
    if (/^cid:/i.test(src)) {
      const local = options.inlineImages?.get(src.slice(4).replace(/^<|>$/g, ""));
      if (local) img.setAttribute("src", local);
      else img.remove();
      continue;
    }

    const isRemote = /^https?:/i.test(src);
    if (isRemote && !options.showImages) {
      // Swapped for a placeholder element rather than a src-less <img>, which
      // browsers draw as a broken-image glyph — indistinguishable from a bug.
      // Re-sanitising with showImages restores the original markup.
      const placeholder = doc.createElement("span");
      placeholder.className = "blocked-image";
      placeholder.textContent = img.getAttribute("alt") || "Image";
      img.replaceWith(placeholder);
      blockedImages++;
    }
  }

  // Strip fixed pixel widths that would otherwise force a horizontal scrollbar.
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>("[width], [style]"))) {
    const width = el.getAttribute("width");
    if (width && Number(width) > 680) el.removeAttribute("width");
    const style = el.getAttribute("style");
    if (style && /width\s*:\s*\d{3,}px/i.test(style)) {
      el.setAttribute("style", style.replace(/width\s*:\s*\d{3,}px/gi, "max-width:100%"));
    }
  }

  return { html: doc.body.innerHTML, blockedImages };
}

/** Plain-text bodies still need escaping, plus autolinking to be useful. */
export function renderPlainText(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const linked = escaped.replace(
    /\bhttps?:\/\/[^\s<]+/g,
    (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>`,
  );

  // A div rather than <pre>: plain-text mail is prose, and the pre styling in
  // .mail-body is meant for code blocks inside HTML mail.
  return `<div class="mail-plain">${linked}</div>`;
}

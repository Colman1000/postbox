import { marked } from "marked";
import { MARKDOWN_OPTIONS, stripTags, toPlainText } from "./plaintext.ts";

/**
 * Turns the Markdown you typed into a message.
 *
 * The shape of the HTML is a deliverability decision, not a taste one. Mail
 * that arrives wrapped in a full `<html>` document with a centred fixed-width
 * container, a page background and a boxed-off footer is *campaign* markup:
 * it is what every marketing tool emits and nothing a person's mail client
 * emits. Filters read that structure, and a one-to-one message wearing a
 * newsletter's clothes is scored as one.
 *
 * So this emits what Gmail, Apple Mail and Outlook actually put on the wire —
 * a bare fragment, one wrapper `div` carrying the font, and styling only where
 * a block element would otherwise be unreadable. No document, no container, no
 * page background, no web fonts, no media queries.
 *
 * Everything is inline: mail clients strip `<style>` blocks and understand
 * roughly 1998-era CSS, which is also why there is no flexbox here.
 */

/** The stack a native client would use. Nothing loaded over the network. */
const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * Minimal per-block styling, applied to marked's output.
 *
 * Only blocks that render badly unstyled are touched — a quote needs its rule,
 * code needs a mono face — and each rule is the smallest one that does the job.
 * Paragraphs, links and emphasis are left completely alone, because the
 * client's defaults for those are already what a human's mail looks like.
 */
const BLOCK_STYLES: Array<[RegExp, string]> = [
  [/<blockquote>/g, '<blockquote style="margin:0 0 0 8px;padding-left:12px;border-left:2px solid #ccc;color:#555">'],
  [/<pre><code(\s[^>]*)?>/g, '<pre style="margin:12px 0;padding:10px;background:#f5f5f5;border-radius:4px;overflow:auto"><code style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px">'],
  [/<code>/g, '<code style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px">'],
  [/<table>/g, '<table style="border-collapse:collapse" cellpadding="6">'],
  [/<(th|td)>/g, '<$1 style="border:1px solid #ddd;text-align:left">'],
  [/<hr>/g, '<hr style="border:0;border-top:1px solid #ddd;margin:16px 0">'],
  [/<img /g, '<img style="max-width:100%;height:auto" '],
];

function styleBlocks(html: string): string {
  let out = html;
  for (const [pattern, replacement] of BLOCK_STYLES) out = out.replace(pattern, replacement);
  return out;
}

export function renderBody(
  markdown: string,
  signatureHtml?: string | null,
): { html: string; text: string } {
  const body = styleBlocks(marked.parse(markdown, { ...MARKDOWN_OPTIONS, async: false }) as string).trim();

  // `-- ` on its own line is the signature delimiter every mail client has
  // understood since RFC 3676, and what makes a client collapse the signature
  // instead of quoting it back on reply. A bordered grey panel does neither.
  const signature = signatureHtml
    ? `\n<div style="color:#666">-- <br>\n${signatureHtml}\n</div>`
    : "";

  const html =
    `<div dir="auto" style="font-family:${FONT};font-size:15px;line-height:1.5;color:#000">\n` +
    `${body}${signature}\n</div>`;

  const signatureText = signatureHtml ? stripTags(signatureHtml) : "";
  const text = [toPlainText(markdown), signatureText ? `-- \n${signatureText}` : ""]
    .filter(Boolean)
    .join("\n\n");

  return { html, text };
}

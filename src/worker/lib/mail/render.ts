import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true });

/**
 * Turns the Markdown you typed into something a mail client will render.
 *
 * Mail clients strip `<style>` blocks and understand roughly 1998-era CSS, so
 * every rule here is inline and conservative. No web fonts, no flexbox, no
 * dark-mode media query — those are the things that break in Outlook.
 */
export function renderBody(
  markdown: string,
  signatureHtml?: string | null,
): { html: string; text: string } {
  const rendered = marked.parse(markdown, { async: false }) as string;
  const signature = signatureHtml
    ? `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e4e4e7;color:#71717a;font-size:13px">${signatureHtml}</div>`
    : "";

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#ffffff">
<div style="max-width:640px;margin:0 auto;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#18181b">
${rendered}${signature}
</div>
</body></html>`;

  return { html, text: markdown.trim() };
}

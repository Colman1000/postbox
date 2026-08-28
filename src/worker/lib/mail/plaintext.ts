import { marked, type Token, type Tokens } from "marked";

/**
 * The same options the HTML side parses with.
 *
 * Passed explicitly rather than read from `marked`'s global defaults, because
 * the two parts of a message have to be lexed identically and a global that
 * only gets set when some *other* module happens to be imported first is not a
 * guarantee of that.
 */
export const MARKDOWN_OPTIONS = { gfm: true, breaks: true } as const;

/**
 * Markdown → plain text, for the `text/plain` alternative.
 *
 * Every message goes out as `multipart/alternative`, and the two parts are
 * supposed to say the same thing. Shipping the raw Markdown as the text part
 * meant they did not: the HTML said *emphasis* while the text said
 * `**emphasis**`, and a link that read "the docs" in one part read
 * `[the docs](https://…)` in the other.
 *
 * Filters read both. A text part that is visibly machine-generated markup
 * beside a rendered HTML part is the shape of a template, not of a person
 * typing — and a message with no usable text part at all scores worse still
 * (SpamAssassin's MIME_HTML_ONLY). So this renders real prose: emphasis
 * markers dropped, links written the way people write them in plain mail,
 * lists and quotes kept as the conventions that predate HTML mail.
 */

/** Traditional mail width. Long enough to read, short enough to quote. */
const WRAP_AT = 76;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Greedy wrap. Never splits a word, so a long URL overflows the line rather
 * than being broken in half — a broken URL is worse than a long one, because
 * clients linkify by line.
 */
function wrap(text: string, width: number, indent = ""): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    if (line === "") line = indent + word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = indent + word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** Prefix every line of a block, for blockquotes and nested list items. */
function prefixLines(block: string, first: string, rest: string): string {
  const lines = block.split("\n");
  return lines
    .map((line, i) => {
      const prefix = i === 0 ? first : rest;
      return line ? prefix + line : prefix.trimEnd();
    })
    .join("\n");
}

/** Inline tokens → a single run of text, with no markup left in it. */
function inline(tokens: Token[] | undefined, fallback = ""): string {
  if (!tokens || tokens.length === 0) return decodeEntities(fallback);

  let out = "";
  for (const token of tokens) {
    switch (token.type) {
      case "text":
      case "escape": {
        const t = token as Tokens.Text;
        out += t.tokens ? inline(t.tokens, t.text) : decodeEntities(t.text ?? "");
        break;
      }
      case "strong":
      case "em":
      case "del": {
        const t = token as Tokens.Strong;
        out += inline(t.tokens, t.text);
        break;
      }
      case "codespan":
        out += decodeEntities((token as Tokens.Codespan).text ?? "");
        break;
      case "br":
        out += "\n";
        break;
      case "link": {
        const t = token as Tokens.Link;
        const label = inline(t.tokens, t.text).trim();
        const href = decodeEntities(t.href ?? "");
        // `text <url>` is how plain mail has always carried a link, and the
        // angle brackets are what tells a text client where the URL ends.
        // When the label already *is* the URL, printing it twice is noise.
        if (!href) out += label;
        else if (!label || label === href || label === href.replace(/^mailto:/, "")) out += href.replace(/^mailto:/, "");
        else out += `${label} <${href}>`;
        break;
      }
      case "image": {
        const t = token as Tokens.Image;
        const alt = decodeEntities(t.text ?? "").trim();
        out += alt ? `[image: ${alt}]` : "[image]";
        break;
      }
      case "html":
        out += stripTags((token as Tokens.HTML).text ?? "");
        break;
      default: {
        const t = token as { tokens?: Token[]; text?: string; raw?: string };
        out += t.tokens ? inline(t.tokens, t.text ?? "") : decodeEntities(t.text ?? t.raw ?? "");
      }
    }
  }
  return out;
}

/** Block tokens → text blocks, already wrapped. */
function block(tokens: Token[], depth = 0): string[] {
  const blocks: string[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case "space":
        break;

      case "heading": {
        const t = token as Tokens.Heading;
        const text = inline(t.tokens, t.text).trim();
        if (text) blocks.push(wrap(text, WRAP_AT).join("\n"));
        break;
      }

      case "paragraph": {
        const t = token as Tokens.Paragraph;
        const text = inline(t.tokens, t.text);
        // A hard break inside a paragraph is a line the author chose. Wrap
        // each of those separately so the choice survives.
        const wrapped = text
          .split("\n")
          .map((line) => wrap(line, WRAP_AT).join("\n"))
          .filter((line) => line !== "")
          .join("\n");
        if (wrapped) blocks.push(wrapped);
        break;
      }

      case "text": {
        const t = token as Tokens.Text;
        const text = t.tokens ? inline(t.tokens, t.text) : decodeEntities(t.text ?? "");
        const wrapped = wrap(text, WRAP_AT).join("\n");
        if (wrapped) blocks.push(wrapped);
        break;
      }

      case "code": {
        const t = token as Tokens.Code;
        // Indented rather than fenced: four spaces is the convention a text
        // reader understands, and backticks would just be more markup.
        const body = (t.text ?? "")
          .split("\n")
          .map((line) => (line ? `    ${line}` : ""))
          .join("\n");
        if (body.trim()) blocks.push(body);
        break;
      }

      case "blockquote": {
        const t = token as Tokens.Blockquote;
        const inner = block(t.tokens ?? [], depth + 1).join("\n\n");
        if (inner) blocks.push(prefixLines(inner, "> ", "> "));
        break;
      }

      case "list": {
        const t = token as Tokens.List;
        const items: string[] = [];
        let counter = typeof t.start === "number" && t.start > 0 ? t.start : 1;

        for (const item of t.items ?? []) {
          const marker = t.ordered ? `${counter++}. ` : "- ";
          const pad = " ".repeat(marker.length);
          const checkbox = item.task ? (item.checked ? "[x] " : "[ ] ") : "";
          const inner = block(item.tokens ?? [], depth + 1).join("\n\n");
          const body = checkbox + inner.replace(/^\s+/, "");
          items.push(prefixLines(body, marker, pad));
        }
        if (items.length > 0) blocks.push(items.join(t.loose ? "\n\n" : "\n"));
        break;
      }

      case "table": {
        const t = token as Tokens.Table;
        const header = (t.header ?? []).map((cell) => inline(cell.tokens, cell.text).trim());
        const rows = (t.rows ?? []).map((row) =>
          row.map((cell) => inline(cell.tokens, cell.text).trim()),
        );
        const widths = header.map((cell, i) =>
          Math.max(cell.length, ...rows.map((row) => (row[i] ?? "").length)),
        );
        const line = (cells: string[]) =>
          cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
        blocks.push(
          [line(header), widths.map((w) => "-".repeat(w)).join("  ").trimEnd(), ...rows.map(line)].join(
            "\n",
          ),
        );
        break;
      }

      case "hr":
        blocks.push("---");
        break;

      case "html": {
        const text = stripTags((token as Tokens.HTML).text ?? "").trim();
        if (text) blocks.push(wrap(text, WRAP_AT).join("\n"));
        break;
      }

      case "def":
        break;

      default: {
        const t = token as { tokens?: Token[]; text?: string };
        if (t.tokens) {
          blocks.push(...block(t.tokens, depth));
        } else if (t.text?.trim()) {
          blocks.push(wrap(decodeEntities(t.text), WRAP_AT).join("\n"));
        }
      }
    }
  }

  return blocks.filter((b) => b !== "");
}

/**
 * HTML → text, for the stored signature (which is authored as HTML).
 *
 * Deliberately small: signatures are a name, a line of text and maybe a link.
 * Anything more elaborate degrades to its visible words, which is the right
 * answer for a text part.
 */
export function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
        const text = label.replace(/<[^>]+>/g, "").trim();
        const url = href.replace(/^mailto:/, "");
        return !text || text === url || text === href ? url : `${text} <${href}>`;
      })
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Markdown → the plain-text body of a message. */
export function toPlainText(markdown: string): string {
  if (!markdown.trim()) return "";
  const tokens = marked.lexer(markdown, MARKDOWN_OPTIONS);
  return block(tokens).join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

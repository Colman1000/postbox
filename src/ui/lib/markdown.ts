import DOMPurify from "dompurify";
import { marked } from "marked";

/**
 * Markdown in both directions.
 *
 * The wire format never changes: a draft is Markdown in the database, and the
 * Worker renders that Markdown to mail-safe HTML on send. The rich-text
 * composer is only a different way of typing it — every keystroke in the
 * visual editor is converted straight back to Markdown, so switching to the
 * Markdown view, saving a draft, or opening one written before any of this
 * existed all behave identically.
 *
 * That means the conversion has to round-trip: `markdown → html → markdown`
 * must return what it was given, or a draft would drift every time it is
 * autosaved. The options below match `worker/lib/mail/render.ts` exactly —
 * `breaks: true` in particular, which is what makes a single newline a `<br>`
 * on both sides rather than being silently swallowed in one of them.
 */
const OPTIONS = { async: false, gfm: true, breaks: true } as const;

/** The tag vocabulary the editor speaks. Anything else is pasted noise. */
const ALLOWED_TAGS = [
  "p", "br", "div", "span",
  "strong", "b", "em", "i", "u", "s", "del", "code", "pre",
  "a", "img",
  "ul", "ol", "li", "input",
  "blockquote", "hr",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tr", "th", "td",
];

const ALLOWED_ATTR = ["href", "src", "alt", "title", "type", "checked", "disabled", "colspan", "rowspan"];

/**
 * Markdown → the HTML the editor edits.
 *
 * Leading blank lines survive as an empty paragraph: a reply is seeded with
 * two newlines above the quote precisely so there is somewhere to start
 * typing, and dropping them would drop the caret into the quoted text.
 */
export function markdownToHtml(markdown: string): string {
  const source = markdown ?? "";
  const lead = /^[ \t]*\n/.test(source) ? "<p><br></p>" : "";
  const rendered = marked.parse(source, OPTIONS) as string;
  return lead + sanitizeEditorHtml(rendered);
}

/** Strips anything outside the vocabulary above, in place, without loading it. */
export function sanitizeEditorHtml(html: string): string {
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOW_DATA_ATTR: false });
}

/**
 * Whatever was pasted, expressed in the editor's own vocabulary.
 *
 * Going out through Markdown and back is the point: a paste from Word, Google
 * Docs or another mail client arrives as a thicket of spans and inline styles,
 * and a round trip through Markdown keeps the structure — headings, lists,
 * links, emphasis — while leaving the foreign styling behind.
 */
export function normalizePastedHtml(html: string): string {
  return markdownToHtml(htmlToMarkdown(sanitizeEditorHtml(html)));
}

// ── HTML → Markdown ─────────────────────────────────────────────────────────

const BLOCK_TAGS = new Set([
  "P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6",
  "UL", "OL", "BLOCKQUOTE", "PRE", "HR", "TABLE", "LI",
]);

export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  return (
    serializeBlocks(Array.from(doc.body.childNodes))
      // Zero-width spaces are the editor's way of parking the caret outside a
      // freshly-formatted run; they are scaffolding, not content.
      .replace(/\u200b/g, "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+$/gm, "")
      // Markdown cannot express two blank lines in a row, so neither will we.
      .replace(/\n{4,}/g, "\n\n\n")
      .replace(/\s+$/, "")
  );
}

function serializeBlocks(nodes: Node[]): string {
  const out: string[] = [];
  let run: Node[] = [];

  const flush = () => {
    if (run.length === 0) return;
    const text = trimEdgeBreaks(serializeInline(run));
    if (text) out.push(escapeLineStarts(text));
    run = [];
  };

  for (const node of nodes) {
    if (node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(node.nodeName)) {
      flush();
      const block = serializeBlock(node as HTMLElement);
      if (block !== null) out.push(block);
    } else {
      run.push(node);
    }
  }
  flush();

  return out.join("\n\n");
}

function serializeBlock(el: HTMLElement): string | null {
  switch (el.tagName) {
    case "P":
    case "DIV":
    case "LI": {
      // An empty paragraph is a blank line the writer asked for — kept, so the
      // gap above a quoted reply is still there when the draft comes back.
      return escapeLineStarts(trimEdgeBreaks(serializeInline(Array.from(el.childNodes))));
    }

    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6": {
      const text = oneLine(serializeInline(Array.from(el.childNodes)));
      if (!text) return null;
      return `${"#".repeat(Number(el.tagName[1]))} ${text}`;
    }

    case "UL":
    case "OL":
      return serializeList(el, "");

    case "BLOCKQUOTE": {
      const inner = serializeBlocks(Array.from(el.childNodes));
      if (!inner.trim()) return null;
      return inner
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
    }

    case "PRE": {
      const code = (el.textContent ?? "").replace(/\n+$/, "");
      return `\`\`\`\n${code}\n\`\`\``;
    }

    case "HR":
      return "---";

    case "TABLE":
      return serializeTable(el);

    default:
      return serializeBlocks(Array.from(el.childNodes));
  }
}

function serializeList(list: HTMLElement, indent: string): string {
  const ordered = list.tagName === "OL";
  let index = Number(list.getAttribute("start") ?? "1") || 1;
  const lines: string[] = [];

  for (const item of Array.from(list.children)) {
    if (item.tagName !== "LI") continue;

    const marker = ordered ? `${index++}. ` : "- ";
    const hang = " ".repeat(marker.length);
    const nested: string[] = [];
    const content: Node[] = [];
    let task = "";

    for (const child of Array.from(item.childNodes)) {
      const name = child.nodeName;
      if (name === "UL" || name === "OL") {
        nested.push(serializeList(child as HTMLElement, indent + hang));
      } else if (name === "INPUT") {
        // A checklist item. `checked` is read off the attribute rather than
        // the property so a box the reader clicked is serialised as clicked.
        const box = child as HTMLInputElement;
        task = box.hasAttribute("checked") || box.checked ? "[x] " : "[ ] ";
      } else if (name === "P" || name === "DIV") {
        // Loose lists arrive with each item wrapped in a paragraph.
        content.push(...Array.from(child.childNodes));
        content.push(document.createElement("br"));
      } else {
        content.push(child);
      }
    }

    const text = trimEdgeBreaks(serializeInline(content));
    const body = escapeLineStarts(text).split("\n").join(`\n${indent}${hang}`);
    lines.push(`${indent}${marker}${task}${body}`);
    lines.push(...nested);
  }

  return lines.join("\n");
}

function serializeTable(table: HTMLElement): string {
  const rows = Array.from(table.querySelectorAll("tr")).map((row) =>
    Array.from(row.children).map((cell) =>
      oneLine(serializeInline(Array.from(cell.childNodes))).replace(/\|/g, "\\|"),
    ),
  );
  if (rows.length === 0) return "";

  const width = Math.max(...rows.map((row) => row.length));
  const pad = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`;

  // GFM has no headerless table, so a table that starts with data gets an
  // empty header rather than being dropped.
  const headed = table.querySelector("thead") !== null;
  const header = headed ? rows[0]! : Array.from({ length: width }, () => "");
  const body = headed ? rows.slice(1) : rows;

  return [pad(header), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...body.map(pad)].join("\n");
}

function serializeInline(nodes: Node[]): string {
  return nodes.map(serializeNode).join("");
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeText(node.textContent ?? "");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const el = node as HTMLElement;
  const children = () => serializeInline(Array.from(el.childNodes));

  switch (el.tagName) {
    case "BR":
      return "\n";

    case "STRONG":
    case "B":
      return wrap(children(), "**");

    case "EM":
    case "I":
      return wrap(children(), "*");

    case "S":
    case "DEL":
    case "STRIKE":
      return wrap(children(), "~~");

    case "U":
      // Markdown has no underline, so this is the one place raw HTML is the
      // honest answer — `marked` passes it through to the sent mail unchanged.
      return el.textContent ? `<u>${children()}</u>` : "";

    case "CODE": {
      const text = el.textContent ?? "";
      return text ? `\`${text.replace(/`/g, "\u200b`")}\`` : "";
    }

    case "A": {
      const href = el.getAttribute("href") ?? "";
      const label = (el.textContent ?? "").trim();
      if (!href) return children();
      // A link whose text is its own address needs no brackets at all — GFM
      // autolinks it, and it reads better in the Markdown view. An address
      // keeps its bare form: the `mailto:` is GFM's, not the writer's.
      if (label === href) return href;
      if (`mailto:${label}` === href) return label;
      return `[${oneLine(children()) || label}](${encodeHref(href)})`;
    }

    case "IMG": {
      const src = el.getAttribute("src") ?? "";
      if (!src) return "";
      return `![${el.getAttribute("alt") ?? ""}](${encodeHref(src)})`;
    }

    case "INPUT":
      return "";

    default:
      return children();
  }
}

/**
 * Emphasis cannot open or close against a space — `** bold **` is just
 * asterisks — so any whitespace the selection swept up moves outside the
 * markers rather than being deleted.
 */
function wrap(inner: string, delimiter: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  if (!match || !match[2]) return inner;
  return `${match[1]}${delimiter}${match[2]}${delimiter}${match[3]}`;
}

function encodeHref(href: string): string {
  return /[\s()]/.test(href) ? `<${href}>` : href;
}

function escapeText(text: string): string {
  return text.replace(/([\\`*_[\]<>])/g, "\\$1");
}

/**
 * A line that happens to begin with `-`, `#` or `1.` is prose, not a list —
 * unless the writer used the toolbar, in which case it never reaches here.
 */
function escapeLineStarts(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^(\s*)([-+]|#{1,6}|>|\d+\.)(\s|$)/, "$1\\$2$3"))
    .join("\n");
}

function trimEdgeBreaks(text: string): string {
  return text.replace(/^[\s\u200b]+|[\s\u200b]+$/g, "");
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

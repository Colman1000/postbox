import { useCallback, useEffect, useRef, useState } from "react";
import {
  BoldIcon,
  ChevronDownIcon,
  CodeIcon,
  EllipsisIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ItalicIcon,
  LinkIcon,
  ListChecksIcon,
  ListIcon,
  ListOrderedIcon,
  MinusIcon,
  PilcrowIcon,
  QuoteIcon,
  RemoveFormattingIcon,
  SquareCodeIcon,
  StrikethroughIcon,
  UnderlineIcon,
  UnlinkIcon,
} from "lucide-react";
import { htmlToMarkdown, markdownToHtml, normalizePastedHtml } from "@/lib/markdown.ts";
import { cn } from "@/lib/utils.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Label } from "@/components/ui/label.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";

/**
 * A visual editor over a Markdown document.
 *
 * Most people writing an email have never heard of Markdown and never should:
 * they want a Bold button. So the surface here is `contenteditable`, formatted
 * with the toolbar or the usual ⌘B/⌘I/⌘U, and the document is serialised back
 * to Markdown on every keystroke — the stored draft, the Markdown view and the
 * sent mail are all the same text they always were.
 *
 * The editor is deliberately *uncontrolled*: React sets the HTML when the
 * document changes from the outside (opening a draft, inserting a template)
 * and otherwise never touches it. Re-rendering `innerHTML` from state on every
 * keystroke is what makes home-grown editors eat the caret.
 */

interface Marks {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  code: boolean;
  bullet: boolean;
  numbered: boolean;
  checklist: boolean;
  link: boolean;
  block: string;
}

const NO_MARKS: Marks = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  code: false,
  bullet: false,
  numbered: false,
  checklist: false,
  link: false,
  block: "p",
};

const BLOCK_STYLES = [
  { value: "p", label: "Normal text", icon: PilcrowIcon, sample: "text-[13px]" },
  { value: "h1", label: "Heading 1", icon: Heading1Icon, sample: "text-[17px] font-semibold" },
  { value: "h2", label: "Heading 2", icon: Heading2Icon, sample: "text-[15px] font-semibold" },
  { value: "h3", label: "Heading 3", icon: Heading3Icon, sample: "text-[13px] font-semibold" },
  { value: "blockquote", label: "Quote", icon: QuoteIcon, sample: "text-[13px] italic" },
  { value: "pre", label: "Code block", icon: SquareCodeIcon, sample: "text-[12px] font-mono" },
] as const;

export function RichTextEditor({
  value,
  onChange,
  placeholder,
  autoFocus,
  onSwitchToMarkdown,
  className,
}: {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  onSwitchToMarkdown?: () => void;
  className?: string;
}) {
  const editor = useRef<HTMLDivElement>(null);
  /** The Markdown we last handed upwards, to tell our own edits from foreign ones. */
  const emitted = useRef(value);
  const savedRange = useRef<Range | null>(null);
  const [marks, setMarks] = useState<Marks>(NO_MARKS);
  const [empty, setEmpty] = useState(true);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkDraft, setLinkDraft] = useState({ text: "", href: "" });

  // ── document in, document out ─────────────────────────────────────────────

  const emit = useCallback(() => {
    const el = editor.current;
    if (!el) return;
    const markdown = htmlToMarkdown(el.innerHTML);
    emitted.current = markdown;
    setEmpty(isBlank(el));
    onChange(markdown);
  }, [onChange]);

  useEffect(() => {
    const el = editor.current;
    if (!el) return;
    // Only when the change came from somewhere other than this editor —
    // a template being inserted, or a draft loading.
    if (el.innerHTML !== "" && value === emitted.current) return;
    emitted.current = value;
    el.innerHTML = markdownToHtml(value);
    liven(el);
    setEmpty(isBlank(el));
  }, [value]);

  useEffect(() => {
    const el = editor.current;
    if (!el || !autoFocus) return;
    el.focus({ preventScroll: true });
    caretToStart(el);
  }, [autoFocus]);

  // Toolbar state follows the caret, so the buttons always describe the text
  // you are actually standing in.
  useEffect(() => {
    function onSelectionChange() {
      const el = editor.current;
      const selection = document.getSelection();
      if (!el || !selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer)) return;
      savedRange.current = range.cloneRange();
      setMarks(readMarks(el));
    }
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  // ── commands ──────────────────────────────────────────────────────────────

  const focusEditor = useCallback(() => {
    const el = editor.current;
    if (!el) return;
    const selection = document.getSelection();
    const inside =
      selection &&
      selection.rangeCount > 0 &&
      el.contains(selection.getRangeAt(0).commonAncestorContainer);
    el.focus({ preventScroll: true });
    // A toolbar menu takes focus with it; putting the caret back is what makes
    // the command apply to the text you had selected before you reached for it.
    if (!inside && savedRange.current && selection) {
      selection.removeAllRanges();
      selection.addRange(savedRange.current);
    }
  }, []);

  const run = useCallback(
    (command: string, argument?: string) => {
      const el = editor.current;
      if (!el) return;
      focusEditor();
      // Semantic tags rather than styled spans: `<strong>` survives the trip
      // to Markdown, `<span style="font-weight:bold">` does not.
      document.execCommand("styleWithCSS", false, "false");
      document.execCommand(command, false, argument);
      liven(el);
      emit();
      setMarks(readMarks(el));
    },
    [emit, focusEditor],
  );

  const setBlock = useCallback(
    (tag: string) => {
      const el = editor.current;
      if (!el) return;
      focusEditor();
      // Leave the list first. `formatBlock` inside a list item splits the list
      // and formats nothing, so "make this a heading" has to stop being a list
      // item before it can become a heading.
      const item = currentElement(el)?.closest("li");
      if (item) {
        box(item)?.remove();
        if (document.queryCommandState("insertOrderedList")) {
          document.execCommand("insertOrderedList");
        } else {
          document.execCommand("insertUnorderedList");
        }
      }
      // Leaving a quote is a different operation from entering one: Chrome
      // only lifts a blockquote through outdent, not formatBlock.
      const inQuote = currentElement(el)?.closest("blockquote");
      if (inQuote && tag !== "blockquote") document.execCommand("outdent");
      if (tag === "blockquote" && inQuote) {
        document.execCommand("outdent");
      } else {
        document.execCommand("formatBlock", false, `<${tag}>`);
      }
      liven(el);
      emit();
      setMarks(readMarks(el));
    },
    [emit, focusEditor],
  );

  const toggleList = useCallback(
    (command: "insertUnorderedList" | "insertOrderedList") => {
      const el = editor.current;
      if (!el) return;
      focusEditor();
      leaveHeading(el);
      document.execCommand("styleWithCSS", false, "false");
      document.execCommand(command);
      liven(el);
      emit();
      setMarks(readMarks(el));
    },
    [emit, focusEditor],
  );

  const toggleChecklist = useCallback(() => {
    const el = editor.current;
    if (!el) return;
    focusEditor();
    leaveHeading(el);
    const item = currentElement(el)?.closest("li");
    const list = item?.closest("ul");

    if (list && hasBox(item)) {
      for (const li of Array.from(list.querySelectorAll("li"))) box(li)?.remove();
    } else {
      // Held on to across the command: turning an empty line into a list
      // replaces the block, and the selection can be left pointing at the
      // element that was thrown away. This child moves into the new item and
      // still knows where it lives.
      const carried = list ? null : currentElement(el)?.firstChild;
      if (!list) document.execCommand("insertUnorderedList");
      const target =
        currentElement(el)?.closest("ul") ??
        (carried && el.contains(carried) ? (carried.parentElement?.closest("ul") ?? null) : null);
      for (const li of Array.from(target?.querySelectorAll("li") ?? [])) addBox(li);
    }
    liven(el);
    emit();
    setMarks(readMarks(el));
  }, [emit, focusEditor]);

  // ── links ─────────────────────────────────────────────────────────────────

  const openLink = useCallback(() => {
    const el = editor.current;
    if (!el) return;
    const selection = document.getSelection();
    if (selection && selection.rangeCount > 0 && el.contains(selection.getRangeAt(0).commonAncestorContainer)) {
      savedRange.current = selection.getRangeAt(0).cloneRange();
    }
    const anchor = currentElement(el)?.closest("a");
    setLinkDraft({
      text: anchor?.textContent ?? selection?.toString() ?? "",
      href: anchor?.getAttribute("href") ?? "",
    });
    setLinkOpen(true);
  }, []);

  const applyLink = useCallback(() => {
    const el = editor.current;
    if (!el) return;
    const href = normalizeUrl(linkDraft.href);
    if (!href) return;
    setLinkOpen(false);
    focusEditor();

    const anchor = currentElement(el)?.closest("a");
    const label = linkDraft.text.trim();
    if (anchor) {
      anchor.setAttribute("href", href);
      if (label && label !== anchor.textContent) anchor.textContent = label;
    } else {
      const selection = document.getSelection();
      const selected = selection?.toString() ?? "";
      if (selected && (!label || label === selected)) {
        document.execCommand("createLink", false, href);
      } else {
        document.execCommand(
          "insertHTML",
          false,
          `<a href="${escapeAttribute(href)}">${escapeHtml(label || href)}</a>&#8203;`,
        );
      }
    }
    emit();
    setMarks(readMarks(el));
  }, [linkDraft, emit, focusEditor]);

  // ── typing ────────────────────────────────────────────────────────────────

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const el = editor.current;
      if (!el) return;
      const mod = event.metaKey || event.ctrlKey;

      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openLink();
        return;
      }

      if (event.key === " ") {
        // "- ", "1. ", "# " and friends become the thing they describe. Nobody
        // has to know that is Markdown; it just behaves the way they expect.
        if (applyBlockShortcut(el, toggleList, setBlock, toggleChecklist)) {
          event.preventDefault();
          emit();
          return;
        }
        if (applyAutolink(el)) emit();
        return;
      }

      if (event.key === "Enter") {
        if (applyAutolink(el)) emit();
        const node = currentElement(el);
        const pre = node?.closest("pre");
        if (pre) {
          // Inside a code block Enter is a newline; two in a row means "done".
          if (/\n\s*$/.test(textBeforeCaret(pre))) {
            event.preventDefault();
            exitBlock(pre);
            emit();
          } else {
            event.preventDefault();
            document.execCommand("insertLineBreak");
            emit();
          }
          return;
        }
        const item = node?.closest("li");
        // An empty checklist item still contains its checkbox, so the browser
        // will not exit the list on its own. Dropping the box lets it.
        if (item && hasBox(item) && !(item.textContent ?? "").trim()) box(item)?.remove();
        return;
      }

      if (event.key === "Tab") {
        const item = currentElement(el)?.closest("li");
        if (item) {
          event.preventDefault();
          document.execCommand(event.shiftKey ? "outdent" : "indent");
          liven(el);
          emit();
        }
        return;
      }

      if (event.key === "Backspace") {
        // Backspacing out of a heading or a quote at its first character puts
        // you back in normal text rather than merging into the block above.
        const node = currentElement(el);
        const block = node?.closest("h1, h2, h3, h4, h5, h6, blockquote");
        if (block && atStartOf(block) && (block.textContent ?? "").length > 0) {
          event.preventDefault();
          setBlock("p");
        }
      }
    },
    [emit, openLink, setBlock, toggleChecklist, toggleList],
  );

  const onInput = useCallback(() => {
    const el = editor.current;
    if (!el) return;
    // `**bold**` and `` `code` `` close themselves as you type, for the people
    // who do know Markdown and would otherwise be typing literal asterisks.
    applyInlineShortcut();
    liven(el);
    emit();
    setMarks(readMarks(el));
  }, [emit]);

  const onPaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      const html = event.clipboardData.getData("text/html");
      const text = event.clipboardData.getData("text/plain");
      if (!html && !text) return;
      event.preventDefault();
      focusEditor();
      if (html) {
        // Word, Docs and other mail clients paste a thicket of inline styles.
        // The round trip through Markdown keeps the structure and drops the rest.
        document.execCommand("insertHTML", false, normalizePastedHtml(html));
      } else {
        document.execCommand("insertHTML", false, plainTextToHtml(text));
      }
      emit();
    },
    [emit, focusEditor],
  );

  const current = BLOCK_STYLES.find((style) => style.value === marks.block) ?? BLOCK_STYLES[0];

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {/* Toolbar */}
      <div className="scroll-panel flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b px-2">
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-muted-foreground data-[state=open]:bg-accent shrink-0 gap-1 px-1.5"
                >
                  <current.icon />
                  <span className="max-sm:hidden">{current.label}</span>
                  <ChevronDownIcon className="size-3 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Text style</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" className="w-52">
            {BLOCK_STYLES.map((style) => (
              <DropdownMenuItem
                key={style.value}
                onSelect={() => window.setTimeout(() => setBlock(style.value), 0)}
                className={cn("gap-2", style.value === marks.block && "bg-accent")}
              >
                <style.icon className="text-muted-foreground size-3.5" />
                <span className={style.sample}>{style.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Divider />

        <Tool label="Bold" keys={["⌘", "B"]} active={marks.bold} onClick={() => run("bold")}>
          <BoldIcon />
        </Tool>
        <Tool label="Italic" keys={["⌘", "I"]} active={marks.italic} onClick={() => run("italic")}>
          <ItalicIcon />
        </Tool>
        <Tool
          label="Underline"
          keys={["⌘", "U"]}
          active={marks.underline}
          onClick={() => run("underline")}
        >
          <UnderlineIcon />
        </Tool>

        <Divider />

        <Tool
          label="Bulleted list"
          active={marks.bullet && !marks.checklist}
          onClick={() => toggleList("insertUnorderedList")}
        >
          <ListIcon />
        </Tool>
        <Tool
          label="Numbered list"
          active={marks.numbered}
          onClick={() => toggleList("insertOrderedList")}
        >
          <ListOrderedIcon />
        </Tool>
        <Tool label="Checklist" active={marks.checklist} onClick={toggleChecklist}>
          <ListChecksIcon />
        </Tool>

        <Divider />

        <Popover open={linkOpen} onOpenChange={setLinkOpen}>
          {/* An anchor rather than a trigger: the button already decides when
              the popover opens, and a trigger would toggle it a second time. */}
          <PopoverAnchor asChild>
            {/* A real box, not `display: contents`: Radix measures this element
                to place the popover, and a box-less anchor lands it in the
                corner of the page. */}
            <span className="inline-flex shrink-0">
              <Tool
                label="Link"
                keys={["⌘", "K"]}
                active={marks.link}
                onClick={() => (linkOpen ? setLinkOpen(false) : openLink())}
              >
                <LinkIcon />
              </Tool>
            </span>
          </PopoverAnchor>
          <PopoverContent align="start" className="w-72 p-3">
            <form
              className="grid gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                applyLink();
              }}
            >
              <div className="grid gap-1">
                <Label htmlFor="postbox-link-text" className="text-[11px]">
                  Text
                </Label>
                <Input
                  id="postbox-link-text"
                  value={linkDraft.text}
                  onChange={(event) => setLinkDraft((d) => ({ ...d, text: event.target.value }))}
                  placeholder="Our pricing page"
                  className="h-8 text-[13px]"
                />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="postbox-link-href" className="text-[11px]">
                  Link
                </Label>
                <Input
                  id="postbox-link-href"
                  value={linkDraft.href}
                  autoFocus
                  onChange={(event) => setLinkDraft((d) => ({ ...d, href: event.target.value }))}
                  placeholder="example.com"
                  className="h-8 text-[13px]"
                />
              </div>
              <div className="mt-1 flex items-center gap-1.5">
                <Button type="submit" size="xs" disabled={!linkDraft.href.trim()}>
                  Apply
                </Button>
                {marks.link && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="text-muted-foreground gap-1"
                    onClick={() => {
                      setLinkOpen(false);
                      run("unlink");
                    }}
                  >
                    <UnlinkIcon /> Remove
                  </Button>
                )}
              </div>
            </form>
          </PopoverContent>
        </Popover>

        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground data-[state=open]:bg-accent shrink-0"
                  aria-label="More formatting"
                >
                  <EllipsisIcon />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>More formatting</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onSelect={() => window.setTimeout(() => run("strikeThrough"), 0)}>
              <StrikethroughIcon /> Strikethrough
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => window.setTimeout(() => run("insertHTML", "<code>code</code>&#8203;"), 0)}>
              <CodeIcon /> Inline code
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => window.setTimeout(() => run("insertHorizontalRule"), 0)}>
              <MinusIcon /> Divider
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => window.setTimeout(() => run("removeFormat"), 0)}>
              <RemoveFormattingIcon /> Clear formatting
            </DropdownMenuItem>
            {onSwitchToMarkdown && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onSwitchToMarkdown}>
                  <SquareCodeIcon /> Edit as Markdown
                  <Kbd className="ml-auto">⌘⇧M</Kbd>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Surface */}
      <div
        ref={editor}
        role="textbox"
        aria-multiline="true"
        aria-label="Message body"
        contentEditable
        suppressContentEditableWarning
        spellCheck
        data-empty={empty}
        data-placeholder={placeholder}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onClick={(event) => {
          const target = event.target as HTMLElement;
          if (target.tagName === "INPUT") {
            // Ticking a box has to survive serialisation, and only the
            // attribute does — the property is invisible to `innerHTML`.
            const checkbox = target as HTMLInputElement;
            checkbox.toggleAttribute("checked", checkbox.checked);
            emit();
            return;
          }
          if (target.closest("a")) {
            event.preventDefault();
            openLink();
          }
        }}
        className="mail-body rich-editor scroll-panel min-h-0 flex-1 overflow-y-auto px-4 py-3 text-[13px] outline-none"
      />
    </div>
  );
}

// ── toolbar pieces ──────────────────────────────────────────────────────────

function Tool({
  label,
  keys,
  active,
  onClick,
  children,
}: {
  label: string;
  keys?: string[];
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          aria-pressed={active}
          // Keeps the caret where it is: a toolbar button that steals focus
          // has nothing left to format by the time it runs.
          onMouseDown={(event) => event.preventDefault()}
          onClick={onClick}
          className={cn("text-muted-foreground shrink-0", active && "bg-accent text-foreground")}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="flex items-center gap-1.5">
        {label}
        {keys?.map((key) => (
          <Kbd key={key} className="bg-transparent">
            {key}
          </Kbd>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

function Divider() {
  return <span className="bg-border mx-1 h-4 w-px shrink-0" />;
}

// ── document helpers ────────────────────────────────────────────────────────

/**
 * The element the caret is actually in.
 *
 * A collapsed selection is not always inside a text node: after a command
 * replaces a block, Chrome parks the caret on the editor itself as
 * (container, offset). Taken literally that says "the caret is in the editor",
 * which makes every `closest()` lookup below miss, and a heading or a list
 * goes unrecognised. Resolving the offset to the child it points at is what
 * turns that back into a real position.
 */
function currentElement(root: HTMLElement): HTMLElement | null {
  const selection = document.getSelection();
  let node: Node | null | undefined = selection?.anchorNode;
  if (!node || !root.contains(node)) return null;

  if (node.nodeType === Node.ELEMENT_NODE) {
    const offset = selection?.anchorOffset ?? 0;
    node = node.childNodes[offset] ?? node.childNodes[offset - 1] ?? node;
  }
  return node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
}

function readMarks(root: HTMLElement): Marks {
  const state = (command: string) => {
    try {
      return document.queryCommandState(command);
    } catch {
      return false;
    }
  };

  let block = "p";
  try {
    block = (document.queryCommandValue("formatBlock") || "p").toLowerCase();
  } catch {
    /* Firefox throws on an empty document; "p" is the right answer there. */
  }

  const node = currentElement(root);
  const item = node?.closest("li");
  if (node?.closest("pre")) block = "pre";
  else if (node?.closest("blockquote")) block = "blockquote";
  else if (!BLOCK_STYLES.some((style) => style.value === block)) block = "p";

  return {
    bold: state("bold"),
    italic: state("italic"),
    underline: state("underline"),
    strike: state("strikeThrough"),
    code: Boolean(node?.closest("code")),
    bullet: state("insertUnorderedList"),
    numbered: state("insertOrderedList"),
    checklist: hasBox(item),
    link: Boolean(node?.closest("a")),
    block,
  };
}

function isBlank(root: HTMLElement): boolean {
  return (
    !(root.textContent ?? "").trim() && !root.querySelector("img, hr, table, input, li")
  );
}

/** Checkboxes arrive from Markdown inert; here they are meant to be ticked. */
function liven(root: HTMLElement) {
  for (const node of Array.from(root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))) {
    node.removeAttribute("disabled");
    node.setAttribute("contenteditable", "false");
  }
  // Turning a paragraph into a list can leave the paragraph wrapped around it
  // (`<p><ul>…</ul></p>`), which is not a paragraph and not valid HTML. The
  // list is the block now.
  for (const list of Array.from(root.querySelectorAll("ul, ol"))) {
    const parent = list.parentElement;
    if (!parent || parent === root) continue;
    if (
      /^(P|DIV|H[1-6])$/.test(parent.tagName) &&
      (parent.textContent ?? "") === (list.textContent ?? "")
    ) {
      parent.replaceWith(list);
    }
  }

  // Pressing Enter at the end of a checklist item should give you another
  // checklist item. Only the empty new one that follows a box gets a box of
  // its own — a plain bullet with text in it is a plain bullet, and GFM is
  // happy to mix the two in one list.
  for (const list of Array.from(root.querySelectorAll("ul"))) {
    let after = false;
    for (const item of Array.from(list.children)) {
      if (item.tagName !== "LI") continue;
      if (after && !hasBox(item) && !(item.textContent ?? "").trim()) addBox(item);
      after = hasBox(item);
    }
  }
}

function box(item: Element | null | undefined): HTMLInputElement | null {
  const first = item?.firstElementChild;
  return first instanceof HTMLInputElement && first.type === "checkbox" ? first : null;
}

function hasBox(item: Element | null | undefined): boolean {
  return box(item) !== null;
}

function addBox(item: Element) {
  if (hasBox(item)) return;
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.setAttribute("contenteditable", "false");
  item.insertBefore(checkbox, item.firstChild);
}

/**
 * A heading cannot hold a list: Chrome nests the `<ul>` inside the `<h2>` and
 * leaves a bullet sitting in the middle of your heading. Dropping back to
 * normal text first is what "make this a list" actually means there.
 */
function leaveHeading(root: HTMLElement) {
  if (currentElement(root)?.closest("h1, h2, h3, h4, h5, h6, pre")) {
    document.execCommand("formatBlock", false, "<p>");
  }
}

function caretToStart(root: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(true);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function atStartOf(block: Element): boolean {
  const selection = document.getSelection();
  if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0).cloneRange();
  range.selectNodeContents(block);
  range.setEnd(selection.getRangeAt(0).startContainer, selection.getRangeAt(0).startOffset);
  return range.toString().length === 0;
}

function textBeforeCaret(block: Element): string {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return "";
  const range = selection.getRangeAt(0).cloneRange();
  range.selectNodeContents(block);
  range.setEnd(selection.getRangeAt(0).endContainer, selection.getRangeAt(0).endOffset);
  return range.toString();
}

/** Puts an empty paragraph after a block and the caret in it. */
function exitBlock(block: Element) {
  const paragraph = document.createElement("p");
  paragraph.appendChild(document.createElement("br"));
  block.after(paragraph);
  const range = document.createRange();
  range.setStart(paragraph, 0);
  range.collapse(true);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

// ── as-you-type formatting ──────────────────────────────────────────────────

const INLINE_RULES: { pattern: RegExp; tag: string }[] = [
  { pattern: /\*\*([^*\n]+)\*\*$/, tag: "strong" },
  { pattern: /__([^_\n]+)__$/, tag: "strong" },
  { pattern: /~~([^~\n]+)~~$/, tag: "del" },
  { pattern: /`([^`\n]+)`$/, tag: "code" },
  { pattern: /\*([^*\n]+)\*$/, tag: "em" },
  { pattern: /_([^_\n]+)_$/, tag: "em" },
];

function applyInlineShortcut(): boolean {
  const selection = document.getSelection();
  const node = selection?.anchorNode;
  if (!selection || !selection.isCollapsed || !node || node.nodeType !== Node.TEXT_NODE) return false;

  const text = node as Text;
  const before = text.data.slice(0, selection.anchorOffset);

  for (const rule of INLINE_RULES) {
    const match = rule.pattern.exec(before);
    if (!match || !match[1].trim()) continue;
    const start = before.length - match[0].length;
    // `snake_case` and `2*3*4` are not emphasis, so a delimiter that opens
    // mid-word is left alone.
    if (/[\w*_~`]/.test(before[start - 1] ?? "")) continue;

    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, selection.anchorOffset);
    selection.removeAllRanges();
    selection.addRange(range);
    // The zero-width space is where the caret lands: outside the new tag, so
    // what you type next is not also bold. It never reaches the Markdown.
    document.execCommand(
      "insertHTML",
      false,
      `<${rule.tag}>${escapeHtml(match[1])}</${rule.tag}>&#8203;`,
    );
    return true;
  }
  return false;
}

const URL_PATTERN = /(?:^|\s)((?:https?:\/\/|www\.)[^\s<>"']+[^\s<>"'.,;:!?)])$/i;

function applyAutolink(root: HTMLElement): boolean {
  const selection = document.getSelection();
  const node = selection?.anchorNode;
  if (!selection || !selection.isCollapsed || !node || node.nodeType !== Node.TEXT_NODE) return false;
  if (currentElement(root)?.closest("a, pre, code")) return false;

  const text = node as Text;
  const before = text.data.slice(0, selection.anchorOffset);
  const match = URL_PATTERN.exec(before);
  if (!match) return false;

  const found = match[1];
  const start = before.length - found.length;
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, selection.anchorOffset);
  selection.removeAllRanges();
  selection.addRange(range);
  document.execCommand(
    "insertHTML",
    false,
    `<a href="${escapeAttribute(normalizeUrl(found))}">${escapeHtml(found)}</a>&#8203;`,
  );
  return true;
}

/**
 * The list, heading and quote shortcuts, applied when the space bar completes
 * one of them at the start of a line.
 */
function applyBlockShortcut(
  root: HTMLElement,
  toggleList: (command: "insertUnorderedList" | "insertOrderedList") => void,
  setBlock: (tag: string) => void,
  toggleChecklist: () => void,
): boolean {
  const selection = document.getSelection();
  if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return false;

  const node = currentElement(root);
  if (!node || node.closest("pre, code")) return false;

  const block = node.closest("p, div, h1, h2, h3, h4, h5, h6, li, blockquote") ?? root;
  const caret = selection.getRangeAt(0);
  const prefix = document.createRange();
  prefix.selectNodeContents(block);
  prefix.setEnd(caret.endContainer, caret.endOffset);
  const marker = prefix.toString();

  const inList = Boolean(node.closest("li"));
  const apply = (action: () => void) => {
    prefix.deleteContents();
    // Deleting the marker can empty the block, and an element with no children
    // at all holds no caret — Chrome quietly applies the next command wherever
    // the caret was before instead. A `<br>` is what an empty line is made of.
    if (!block.firstChild) block.appendChild(document.createElement("br"));
    // Then put the caret back at the head of this block, so the command that
    // follows formats this line and not the last one touched.
    const caretHere = document.createRange();
    caretHere.setStart(block, 0);
    caretHere.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caretHere);
    action();
  };

  if (/^#{1,3}$/.test(marker) && !inList) {
    apply(() => setBlock(`h${marker.length}`));
    return true;
  }
  if (marker === ">" && !inList) {
    apply(() => setBlock("blockquote"));
    return true;
  }
  if (marker === "```" && !inList) {
    apply(() => setBlock("pre"));
    return true;
  }
  if ((marker === "[]" || marker === "[ ]") && !inList) {
    apply(toggleChecklist);
    return true;
  }
  if (/^[-*+]$/.test(marker) && !inList) {
    apply(() => toggleList("insertUnorderedList"));
    return true;
  }
  if (/^\d+[.)]$/.test(marker) && !inList) {
    apply(() => toggleList("insertOrderedList"));
    return true;
  }
  return false;
}

// ── text helpers ────────────────────────────────────────────────────────────

function plainTextToHtml(text: string): string {
  return escapeHtml(text)
    .split(/\r?\n/)
    .join("<br>");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

/**
 * What someone types into a link box is rarely a URL. "example.com" and
 * "someone@example.com" are both perfectly clear intentions.
 */
export function normalizeUrl(input: string): string {
  const value = input.trim();
  if (!value) return "";
  if (/^(https?:|mailto:|tel:)/i.test(value)) return value;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return `mailto:${value}`;
  return `https://${value.replace(/^\/+/, "")}`;
}

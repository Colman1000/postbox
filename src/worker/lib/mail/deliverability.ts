import { marked, type Token, type Tokens } from "marked";
import type { Address, DeliverabilityFinding } from "../../../shared/types.ts";
import { MARKDOWN_OPTIONS, toPlainText } from "./plaintext.ts";

/**
 * The pre-send check.
 *
 * Reputation is most of deliverability and none of it is fixable from here.
 * What *is* fixable from here is the handful of things in a single message
 * that make a filter suspicious on its own terms — a link whose text points
 * somewhere other than its href, an attachment nobody's gateway will pass, a
 * subject in block capitals, ten people in the To field.
 *
 * Every rule below is a specific, checkable property with a specific fix.
 * Nothing here blocks a send: the point is to tell you what a receiver is
 * about to notice, while you can still change it.
 */

/** Link shorteners hide the destination, so filters treat them as evasion. */
const SHORTENERS = new Set([
  "bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "buff.ly", "is.gd",
  "cutt.ly", "rebrand.ly", "shorturl.at", "rb.gy", "lnkd.in", "s.id",
  "t.ly", "tiny.cc", "shorte.st", "adf.ly", "bl.ink", "trib.al",
]);

/**
 * Extensions that mail gateways commonly strip or reject outright, so the
 * message either arrives mutilated or does not arrive.
 */
const BLOCKED_EXTENSIONS = new Set([
  "exe", "scr", "bat", "cmd", "com", "pif", "cpl", "msi", "msp", "jar",
  "js", "jse", "vbs", "vbe", "wsf", "wsh", "ps1", "hta", "lnk", "reg",
  "apk", "iso", "img", "dll", "sys", "chm", "html", "htm", "shtml", "svg",
]);

/** Archives are not blocked, but they raise the score on most gateways. */
const ARCHIVE_EXTENSIONS = new Set(["zip", "rar", "7z", "gz", "tar", "cab", "ace"]);

/**
 * Phrases with a genuine, measured association with unwanted mail. Kept short
 * and boring on purpose — a long list fires on ordinary sentences and trains
 * you to ignore the warning.
 */
const RISKY_PHRASES = [
  "act now", "apply now", "call now", "click here", "click below",
  "limited time", "limited offer", "one time offer", "risk free", "risk-free",
  "no obligation", "no strings attached", "money back", "money-back guarantee",
  "guaranteed", "100% free", "free gift", "free trial", "cash bonus",
  "earn extra cash", "make money fast", "double your", "increase sales",
  "this is not spam", "not a scam", "dear friend", "congratulations you",
  "winner", "you have been selected", "urgent response", "wire transfer",
  "crypto investment", "work from home",
];

/** Scripts that are used to build lookalike domains and words. */
const CONFUSABLE = /[Ѐ-ӿͰ-ϿԀ-ԯ]/;

interface CheckInput {
  from: string;
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  subject: string;
  /** The Markdown the user typed. */
  body: string;
  attachments?: Array<{ filename: string; size?: number }>;
  /** True when this is a reply — a few rules are softer on replies. */
  isReply?: boolean;
}

interface ExtractedLink {
  href: string;
  label: string;
}

/** Pulls links and images out of the Markdown, rather than off a regex. */
function extract(markdown: string): { links: ExtractedLink[]; images: number } {
  const links: ExtractedLink[] = [];
  let images = 0;

  const walk = (tokens: Token[] | undefined) => {
    if (!tokens) return;
    for (const token of tokens) {
      if (token.type === "link") {
        const t = token as Tokens.Link;
        links.push({ href: t.href ?? "", label: (t.text ?? "").trim() });
      } else if (token.type === "image") {
        images += 1;
      }
      const nested = token as { tokens?: Token[]; items?: Token[]; rows?: unknown };
      if (nested.tokens) walk(nested.tokens);
      if (nested.items) walk(nested.items as Token[]);
    }
  };

  walk(marked.lexer(markdown, MARKDOWN_OPTIONS));

  // Bare URLs the lexer did not turn into link tokens (plain `https://…` text
  // is auto-linked by every client, so it counts as a link either way).
  for (const match of markdown.matchAll(/(?<![\]("'<])\bhttps?:\/\/[^\s<>()"']+/gi)) {
    const href = match[0];
    if (!links.some((l) => l.href === href)) links.push({ href, label: href });
  }

  return { links, images };
}

function hostOf(href: string): string | null {
  try {
    return new URL(href).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Share of letters that are uppercase, ignoring everything that is not a letter. */
function shoutiness(text: string): number {
  const letters = text.replace(/[^\p{L}]/gu, "");
  if (letters.length < 8) return 0;
  const upper = letters.replace(/[^\p{Lu}]/gu, "").length;
  return upper / letters.length;
}

export function checkDeliverability(input: CheckInput): DeliverabilityFinding[] {
  const findings: DeliverabilityFinding[] = [];
  const add = (
    level: DeliverabilityFinding["level"],
    code: string,
    message: string,
    fix: string,
  ) => findings.push({ level, code, message, fix });

  const subject = (input.subject ?? "").trim();
  const body = input.body ?? "";
  const plain = toPlainText(body);
  const words = plain.split(/\s+/).filter(Boolean).length;
  const { links, images } = extract(body);
  const recipients = [...(input.to ?? []), ...(input.cc ?? [])];

  // ── subject ───────────────────────────────────────────────────────────────

  if (!subject) {
    add(
      "warn",
      "subject-missing",
      "This message has no subject.",
      "Add one. An empty subject is one of the few things filters penalise on its own, and it is the first thing a recipient decides on.",
    );
  } else {
    if (shoutiness(subject) > 0.6) {
      add(
        "warn",
        "subject-shouting",
        "The subject is mostly capital letters.",
        "Write it in sentence case. Block capitals in a subject line is a long-standing spam heuristic.",
      );
    }
    if (/[!?]{2,}/.test(subject) || (subject.match(/!/g) ?? []).length >= 3) {
      add(
        "warn",
        "subject-punctuation",
        "The subject has repeated exclamation or question marks.",
        "Use one, or none.",
      );
    }
    if (/\$\$|€€|£££|\$\s?\d[\d,]*\s?(free|off|now)|100%\s*free/i.test(subject)) {
      add(
        "warn",
        "subject-money",
        "The subject reads as a money offer.",
        "Rewrite it as what the message is actually about. Currency symbols plus urgency is the highest-scoring subject pattern there is.",
      );
    }
    if (subject.length > 78) {
      add(
        "info",
        "subject-long",
        `The subject is ${subject.length} characters — most clients cut it off around 78.`,
        "Put the point in the first 60 characters.",
      );
    }
    if (CONFUSABLE.test(subject) && /[a-z]/i.test(subject)) {
      add(
        "warn",
        "subject-mixed-script",
        "The subject mixes Latin letters with Cyrillic or Greek ones.",
        "This is the signature of a lookalike-character evasion, and filters score it heavily. Retype the affected words if it was not deliberate.",
      );
    }
  }

  // ── body ──────────────────────────────────────────────────────────────────

  if (words === 0 && links.length === 0 && images === 0) {
    add("warn", "body-empty", "The message body is empty.", "Write something, or the send is not worth making.");
  } else if (words < 5 && links.length > 0 && !input.isReply) {
    // Softened on replies: "here you go, <link>" inside an existing thread is
    // ordinary correspondence, and the thread itself is the context a filter
    // would otherwise find missing.
    add(
      "warn",
      "body-link-only",
      "The message is essentially a bare link.",
      "Say what the link is and why you are sending it. A link with no context is the exact shape of a compromised-account send, and it is filtered like one.",
    );
  }

  if (images > 0 && words < 20) {
    add(
      "warn",
      "body-image-only",
      "The message is mostly image, with very little text.",
      "Add a few sentences. Filters cannot read an image, so an image-only message is scored on the assumption that the text is being hidden.",
    );
  }

  if (shoutiness(plain) > 0.6 && plain.length > 40) {
    add("warn", "body-shouting", "The body is mostly capital letters.", "Write it in sentence case.");
  }

  const matched = RISKY_PHRASES.filter((phrase) => plain.toLowerCase().includes(phrase));
  if (matched.length >= 2) {
    add(
      "warn",
      "body-phrases",
      `The body uses phrasing that scores as promotional: ${matched.slice(0, 3).map((p) => `“${p}”`).join(", ")}.`,
      "Reword them. No single phrase decides anything, but several together do.",
    );
  }

  // ── links ─────────────────────────────────────────────────────────────────

  const shortened = links.filter((l) => {
    const host = hostOf(l.href);
    return host !== null && SHORTENERS.has(host);
  });
  if (shortened.length > 0) {
    add(
      "warn",
      "link-shortener",
      `${shortened.length === 1 ? "A link uses" : `${shortened.length} links use`} a URL shortener (${[...new Set(shortened.map((l) => hostOf(l.href)))].join(", ")}).`,
      "Link the real destination. Shorteners hide where a link goes, which is why filters treat them as evasion rather than convenience.",
    );
  }

  const mismatched = links.filter((l) => {
    const labelHost = hostOf(l.label.startsWith("http") ? l.label : `https://${l.label}`);
    const hrefHost = hostOf(l.href);
    // Only counts when the label is itself domain-shaped — ordinary prose
    // link text pointing anywhere is normal and correct.
    return (
      hrefHost !== null &&
      labelHost !== null &&
      /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(l.label.replace(/^https?:\/\//, "").split("/")[0] ?? "") &&
      labelHost !== hrefHost
    );
  });
  if (mismatched.length > 0) {
    add(
      "warn",
      "link-mismatch",
      `A link reads as “${mismatched[0]!.label}” but points at ${hostOf(mismatched[0]!.href)}.`,
      "Make the text match the destination. Label-versus-href mismatch is the single strongest phishing signal a filter can check without leaving the message.",
    );
  }

  const ipLinks = links.filter((l) => {
    const host = hostOf(l.href);
    return host !== null && /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  });
  if (ipLinks.length > 0) {
    add(
      "warn",
      "link-raw-ip",
      "A link points at a bare IP address instead of a hostname.",
      "Use the hostname. Links to raw IPs are heavily penalised, because legitimate services have names.",
    );
  }

  const insecure = links.filter((l) => l.href.toLowerCase().startsWith("http://"));
  if (insecure.length > 0) {
    add(
      "info",
      "link-insecure",
      `${insecure.length === 1 ? "A link uses" : `${insecure.length} links use`} http:// rather than https://.`,
      "Switch to https. Plain-http links are a small but real negative signal, and some clients warn the reader about them.",
    );
  }

  if (links.length >= 4 && words > 0 && links.length / words > 1 / 20) {
    add(
      "info",
      "link-density",
      `${links.length} links across ${words} words is a high ratio.`,
      "Cut the ones that are not load-bearing, or move them below your signature.",
    );
  }

  // ── attachments ───────────────────────────────────────────────────────────

  for (const attachment of input.attachments ?? []) {
    const extension = attachment.filename.split(".").pop()?.toLowerCase() ?? "";
    if (BLOCKED_EXTENSIONS.has(extension)) {
      add(
        "warn",
        "attachment-blocked",
        `“${attachment.filename}” is a file type most mail gateways strip or reject.`,
        `Send it as a link to shared storage instead. A .${extension} attachment often means the whole message is refused, not just the file.`,
      );
    } else if (ARCHIVE_EXTENSIONS.has(extension)) {
      add(
        "info",
        "attachment-archive",
        `“${attachment.filename}” is an archive.`,
        "Archives raise the score on most gateways because their contents cannot be scanned. A link is safer if the recipient's employer filters hard.",
      );
    }
  }

  const totalBytes = (input.attachments ?? []).reduce((sum, a) => sum + (a.size ?? 0), 0);
  if (totalBytes > 10 * 1024 * 1024) {
    add(
      "info",
      "attachment-large",
      `Attachments total ${(totalBytes / (1024 * 1024)).toFixed(1)} MB.`,
      "Many receivers cap a message at 10–25 MB after base64 encoding adds a third. Over that, it bounces.",
    );
  }

  // ── envelope ──────────────────────────────────────────────────────────────

  if (recipients.length > 10) {
    add(
      "warn",
      "recipients-bulk",
      `${recipients.length} visible recipients makes this a bulk send.`,
      "Move them to BCC, or send individually. Large visible recipient lists are scored as a blast, and one recipient marking it spam affects delivery for all of them.",
    );
  }

  if (/^(no-?reply|do-?not-?reply|bounce|mailer|noreply)@/i.test(input.from)) {
    add(
      "info",
      "from-noreply",
      "This is being sent from a no-reply address.",
      "Send from an address that accepts replies. Replies are the strongest positive reputation signal a young domain can earn, and a no-reply address forfeits every one of them.",
    );
  }

  const duplicated = new Set(
    (input.bcc ?? []).map((a) => a.address).filter((address) => recipients.some((r) => r.address === address)),
  );
  if (duplicated.size > 0) {
    add(
      "info",
      "recipients-duplicate",
      "Someone is in both the visible recipients and BCC.",
      "Remove the duplicate — they will get two copies.",
    );
  }

  return findings;
}

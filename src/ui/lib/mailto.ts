import type { Address } from "@shared/types.ts";
import type { ComposeSeed } from "@/components/mail/composer.tsx";

/**
 * `mailto:` links, turned into a message you are already writing.
 *
 * A mail client that hands its own `mailto:` links back to the operating
 * system is admitting it is not really your mail client. These open the
 * composer instead, with everything the link specified already filled in.
 *
 * The format is RFC 6068: comma-separated addresses in the path, and the rest
 * as query parameters. Header names are case-insensitive there, and the path
 * is percent-encoded, which is why both are normalised here rather than read
 * straight off the URL.
 */
function toAddresses(list: string | null | undefined): Address[] {
  if (!list) return [];
  return list
    .split(",")
    .map((part) => decodeAddress(part))
    .filter((address): address is Address => address !== null);
}

function decodeAddress(raw: string): Address | null {
  let value = raw.trim();
  if (!value) return null;
  try {
    value = decodeURIComponent(value);
  } catch {
    /* leave it as written; a malformed escape is not worth dropping the address for */
  }

  // "Ada Lovelace <ada@example.com>" as well as a bare address.
  const angled = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (angled) {
    const [, name, address] = angled;
    return { address: address.trim(), name: name.replace(/^["']|["']$/g, "").trim() || undefined };
  }
  return { address: value, name: undefined };
}

/**
 * Returns null for anything that is not a usable mailto: link, so callers can
 * fall through to the browser's own handling rather than swallowing the click.
 */
export function parseMailto(href: string): ComposeSeed | null {
  if (!/^mailto:/i.test(href.trim())) return null;

  const rest = href.trim().slice("mailto:".length);
  const [path, query = ""] = rest.split("?");
  const params = new URLSearchParams(query);

  // Header names are case-insensitive: `?Subject=` is as valid as `?subject=`.
  const get = (name: string): string | null => {
    for (const [key, value] of params) {
      if (key.toLowerCase() === name) return value;
    }
    return null;
  };

  const to = [...toAddresses(path), ...toAddresses(get("to"))];
  const cc = toAddresses(get("cc"));
  const bcc = toAddresses(get("bcc"));
  const subject = get("subject") ?? undefined;
  const body = get("body") ?? undefined;

  // A link with nothing in it at all is still a request to write a message.
  return {
    mode: "new",
    to,
    cc: cc.length > 0 ? cc : undefined,
    bcc: bcc.length > 0 ? bcc : undefined,
    subject,
    body,
  };
}

/**
 * Finds the `mailto:` anchor a click landed on, if any.
 *
 * Mail is full of links wrapped around images and spans, so the target of the
 * click is rarely the anchor itself.
 */
export function mailtoFromClick(event: React.MouseEvent): string | null {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey) return null;
  const anchor = (event.target as HTMLElement | null)?.closest?.("a");
  const href = anchor?.getAttribute("href");
  return href && /^mailto:/i.test(href) ? href : null;
}

/**
 * The composer to open when the app itself is launched from a `mailto:` link —
 * either by the browser's protocol handler or by a link somewhere else that
 * points at this app.
 */
export function seedFromLocation(search: string): ComposeSeed | null {
  const params = new URLSearchParams(search);
  const handled = params.get("mailto");
  if (handled) return parseMailto(handled) ?? parseMailto(`mailto:${handled}`);

  const to = params.get("to");
  if (to) {
    return parseMailto(
      `mailto:${to}?${new URLSearchParams(
        Object.fromEntries(
          ["cc", "bcc", "subject", "body"]
            .map((key) => [key, params.get(key)])
            .filter((pair): pair is [string, string] => pair[1] !== null),
        ),
      )}`,
    );
  }
  return null;
}

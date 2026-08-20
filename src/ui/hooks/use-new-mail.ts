import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { MailUpdate } from "@shared/types.ts";
import { ApiError, api } from "@/lib/api.ts";
import { displayName } from "@/lib/format.ts";
import { playChime, readPrefs, showNotification } from "@/lib/notify.ts";
import { keys } from "@/lib/queries.ts";

/**
 * Mail that arrives while the app is open.
 *
 * Cloudflare's free plan has no way to push — no Durable Object, no WebSocket
 * on the receiving side — so this polls. It is a deliberately cheap request
 * (a count and, at most, ten rows) and the interval backs off when the tab is
 * hidden, so a page left open all day costs a rounding error against the free
 * 100k requests. When something does land, the caches the inbox is built from
 * are invalidated, which is what makes the list update on its own.
 *
 * The high-water mark is the server's clock, echoed back on the next request,
 * so a browser whose clock is wrong cannot skip a message or announce one
 * twice. The first poll of a session only establishes that mark: mail that was
 * already sitting in the inbox when you opened the tab is not new.
 */
const VISIBLE_MS = 15_000;
const HIDDEN_MS = 60_000;

export function useNewMail({ onOpenThread }: { onOpenThread: (threadId: string) => void }) {
  const client = useQueryClient();
  const cursor = useRef(0);
  const announced = useRef(0);
  const openRef = useRef(onOpenThread);
  openRef.current = onOpenThread;

  const query = useQuery<MailUpdate>({
    queryKey: keys.updates,
    queryFn: () => api.updates(cursor.current),
    refetchInterval: () => (document.hidden ? HIDDEN_MS : VISIBLE_MS),
    refetchIntervalInBackground: true,
    staleTime: 0,
    gcTime: 0,
    // A poll that fails is not worth retrying — the next one is seconds away.
    retry: false,
  });

  const data = query.data;

  // A tab left open past the session's life would otherwise poll a 401 every
  // fifteen seconds, forever. Re-checking the session flips the app back to
  // the login screen, which stops the polling with it.
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 401) {
      client.invalidateQueries({ queryKey: keys.session });
    }
  }, [query.error, client]);

  useEffect(() => {
    if (!data || data.now === announced.current) return;

    const baseline = cursor.current === 0;
    cursor.current = data.now;
    announced.current = data.now;
    if (baseline || data.arrivals.length === 0) return;

    // The lists, the unread badges and the counts all just became wrong.
    client.invalidateQueries({ queryKey: ["threads"] });
    client.invalidateQueries({ queryKey: keys.stats });

    const prefs = readPrefs();
    if (prefs.sound) playChime();

    // A desktop notification is for when you are not looking. When you are,
    // the toast says the same thing without leaving the page.
    if (document.hidden) {
      if (prefs.desktop) showNotification(data.arrivals, (id) => openRef.current(id));
      return;
    }

    const [first] = data.arrivals;
    if (data.arrivals.length === 1) {
      toast(displayName(first.from), {
        description: first.subject || first.snippet || "(no subject)",
        action: { label: "Open", onClick: () => openRef.current(first.threadId) },
      });
    } else {
      toast(`${data.arrivals.length} new messages`, {
        description: `Latest from ${displayName(first.from)}`,
        action: { label: "Open", onClick: () => openRef.current(first.threadId) },
      });
    }
  }, [data, client]);

  return { unread: data?.unread ?? 0 };
}

/**
 * The unread count, in the one place you can see without switching tabs.
 *
 * Kept to `(3) Postbox` rather than something more descriptive because the tab
 * strip truncates hard — the number has to survive being cut to a few
 * characters, and everything after it is decoration.
 */
export function useMailTitle(unread: number, base = "Postbox"): void {
  useEffect(() => {
    document.title = unread > 0 ? `(${unread}) ${base}` : base;
  }, [unread, base]);

  useEffect(() => () => {
    document.title = base;
  }, [base]);
}

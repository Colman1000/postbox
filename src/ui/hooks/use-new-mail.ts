import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { MailUpdate } from "@shared/types.ts";
import { ApiError, api } from "@/lib/api.ts";
import { displayName } from "@/lib/format.ts";
import { playChime, readPrefs, showNotification, subjectOf } from "@/lib/notify.ts";
import { keys } from "@/lib/queries.ts";
import { useLiveMail, type LiveStatus } from "./use-live-mail.ts";

/**
 * Mail that arrives while the app is open.
 *
 * Two mechanisms, one path. A Durable Object holds a socket open and rings it
 * when something lands, which is what makes new mail appear immediately; the
 * ring carries nothing, so both it and the timer end in the same request to
 * `/api/updates` and the same code below. Polling is not removed when the
 * socket connects, only slowed to a heartbeat — a doorbell nobody answers is
 * worse than a slow poll, and this way a failed socket degrades to exactly the
 * behaviour that came before it.
 *
 * The high-water mark is the server's clock, echoed back on the next request,
 * so a browser whose clock is wrong cannot skip a message or announce one
 * twice. The first poll of a session only establishes that mark: mail that was
 * already sitting in the inbox when you opened the tab is not new.
 */
const VISIBLE_MS = 15_000;
const HIDDEN_MS = 60_000;
/** With the socket up, the poll is only there in case the socket is lying. */
const HEARTBEAT_MS = 5 * 60_000;

export function useNewMail({ onOpenThread }: { onOpenThread: (threadId: string) => void }) {
  const client = useQueryClient();
  const cursor = useRef(0);
  const announced = useRef(0);
  const openRef = useRef(onOpenThread);
  openRef.current = onOpenThread;

  // Ringing simply asks the question the timer would have asked, so there is
  // one place where an arrival turns into a notification.
  const ring = useCallback(() => {
    void client.invalidateQueries({ queryKey: keys.updates });
  }, [client]);

  const live = useLiveMail(ring);
  const connected = live === "open";

  const query = useQuery<MailUpdate>({
    queryKey: keys.updates,
    queryFn: () => api.updates(cursor.current),
    refetchInterval: () =>
      connected ? HEARTBEAT_MS : document.hidden ? HIDDEN_MS : VISIBLE_MS,
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
    // Mail that just arrived is mail that just landed in a mailbox — the
    // sidebar's whole promise is that `billing@` lights up when billing writes.
    client.invalidateQueries({ queryKey: keys.mailboxes });

    const prefs = readPrefs();
    if (prefs.sound) playChime();

    // A desktop notification is for when you are not looking. When you are,
    // the toast says the same thing without leaving the page.
    if (document.hidden) {
      if (prefs.desktop) showNotification(data.arrivals, (id) => openRef.current(id));
      return;
    }

    // The subject leads, because that is what tells you whether to look now —
    // the sender is the supporting line. A message genuinely sent without one
    // still gets a heading rather than an empty first line.
    const [first] = data.arrivals;
    if (data.arrivals.length === 1) {
      toast(subjectOf(first), {
        description: `${displayName(first.from)}${first.snippet ? ` — ${first.snippet}` : ""}`,
        action: { label: "Open", onClick: () => openRef.current(first.threadId) },
      });
    } else {
      toast(`${data.arrivals.length} new messages`, {
        description: data.arrivals
          .slice(0, 3)
          .map((arrival) => `${subjectOf(arrival)} · ${displayName(arrival.from)}`)
          .join("\n"),
        action: { label: "Open", onClick: () => openRef.current(first.threadId) },
      });
    }
  }, [data, client]);

  return { unread: data?.unread ?? 0, live };
}

export type { LiveStatus };

/**
 * The unread count and the mailbox it belongs to, in the one place you can see
 * without switching tabs.
 *
 * Ordered for a tab strip that truncates hard: the count survives being cut to
 * a few characters, the domain is what tells two Postbox tabs apart, and the
 * product name goes last because by then you already know what you are looking
 * at.
 */
export function useMailTitle(unread: number, domain?: string): void {
  useEffect(() => {
    const name = domain ? `${domain} · Postbox` : "Postbox";
    document.title = unread > 0 ? `(${unread}) ${name}` : name;
  }, [unread, domain]);

  useEffect(
    () => () => {
      document.title = "Postbox";
    },
    [],
  );
}

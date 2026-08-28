import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { keys } from "@/lib/queries.ts";
import {
  currentSubscription,
  isInstalled,
  keyHasChanged,
  pushSupport,
  subscribe,
  unsubscribe,
  type PushSupport,
} from "@/lib/push.ts";

/**
 * Whether this device is registered for push, and how to change that.
 *
 * Deliberately about *this device* and nothing else. A subscription belongs to
 * one browser on one machine — it cannot be turned on for a phone from a
 * laptop — so the switch reflects what the browser reports, not what the
 * mailbox has stored. The device list in Settings is the other view of the
 * same thing, and is where a registration you no longer recognise shows up.
 */
export interface PushState {
  support: PushSupport;
  /** True once this browser holds a subscription. Null while finding out. */
  enabled: boolean | null;
  /** An enable or disable in flight; the switch is held still meanwhile. */
  busy: boolean;
  installed: boolean;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
}

export function usePush(vapidKey: string | null): PushState {
  const client = useQueryClient();
  const [support] = useState<PushSupport>(pushSupport);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  // Asking the browser rather than trusting a stored flag: permission can be
  // revoked in site settings and a subscription can be dropped by the push
  // service, and neither of those tells the page it happened.
  useEffect(() => {
    let cancelled = false;
    if (support !== "ready") {
      setEnabled(false);
      return;
    }

    void (async () => {
      const subscription = await currentSubscription();
      const granted = Notification.permission === "granted";

      /*
       * Repair a subscription made against a keypair that no longer exists.
       *
       * Silent by design and safe to be silent: permission is already granted,
       * so re-subscribing prompts for nothing. The alternative is a switch
       * that reads "on" over a device that has quietly stopped being notified,
       * which is the worst of the available states.
       */
      if (subscription && granted && vapidKey && (await keyHasChanged(vapidKey))) {
        try {
          await subscribe(vapidKey);
          if (!cancelled) setEnabled(true);
          void client.invalidateQueries({ queryKey: keys.pushDevices });
          return;
        } catch {
          // Fall through and report what is actually true right now.
        }
      }

      if (!cancelled) setEnabled(subscription !== null && granted);
    })();

    return () => {
      cancelled = true;
    };
  }, [support, vapidKey, client]);

  const enable = useCallback(async () => {
    if (!vapidKey) throw new Error("This deployment has no push keys.");
    setBusy(true);
    try {
      await subscribe(vapidKey);
      setEnabled(true);
      void client.invalidateQueries({ queryKey: keys.pushDevices });
    } finally {
      setBusy(false);
    }
  }, [vapidKey, client]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      await unsubscribe();
      setEnabled(false);
      void client.invalidateQueries({ queryKey: keys.pushDevices });
    } finally {
      setBusy(false);
    }
  }, [client]);

  return { support, enabled, busy, installed: isInstalled(), enable, disable };
}

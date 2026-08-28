import { useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DownloadIcon, ShareIcon, SmartphoneIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api.ts";
import { deviceSummary, relativeTime } from "@/lib/format.ts";
import { canInstall, installHint, promptInstall, subscribeInstall } from "@/lib/install.ts";
import { isApple, PushError } from "@/lib/push.ts";
import { keys, usePushDevices } from "@/lib/queries.ts";
import { usePush } from "@/hooks/use-push.ts";
import { Button } from "@/components/ui/button.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { Row } from "./setting-row.tsx";

/**
 * Mail that reaches you when nothing is open.
 *
 * Everything else under Alerts is about a tab you are already looking at, and
 * is stored in that browser. This is different in kind: it is the one alert
 * that works with the app closed and the phone locked, and it needs a row in
 * the mailbox to do it — so the devices are listed, and any of them can be
 * revoked from here.
 */
export function PushSettings({ vapidKey }: { vapidKey: string | null }) {
  const client = useQueryClient();
  const push = usePush(vapidKey);
  const devices = usePushDevices();
  const [testing, setTesting] = useState(false);

  /*
   * Whether the browser is currently willing to install us.
   *
   * Held outside React — the event that decides it fires before the app
   * mounts. Everywhere that is not Chromium reports false and gets nothing:
   * on iOS the paragraph below is the instruction, and on a desktop that
   * already has Postbox installed there is nothing left to offer.
   */
  const installable = useSyncExternalStore(subscribeInstall, canInstall, () => false);

  async function install() {
    if (await promptInstall()) {
      toast.success("Postbox is on your home screen");
    }
  }

  const configured = vapidKey !== null;

  async function toggle(on: boolean) {
    try {
      if (on) {
        await push.enable();
        toast.success("This device will be told when mail arrives");
      } else {
        await push.disable();
      }
    } catch (error) {
      if (error instanceof PushError || error instanceof ApiError) {
        toast.error(error.message, { description: error.hint });
      } else {
        toast.error("Could not change push notifications", {
          description: error instanceof Error ? error.message : undefined,
        });
      }
    }
  }

  async function test() {
    setTesting(true);
    try {
      const { delivered } = await api.testPush();
      toast.success(
        delivered === 1 ? "Sent to one device" : `Sent to ${delivered} devices`,
        { description: "It can take a few seconds to arrive." },
      );
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "The test notification did not go out",
        { description: error instanceof ApiError ? error.hint : undefined },
      );
    } finally {
      setTesting(false);
    }
  }

  async function revoke(endpoint: string) {
    try {
      await api.unsubscribePush(endpoint);
      await client.invalidateQueries({ queryKey: keys.pushDevices });
      toast.success("That device will stop receiving notifications");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not revoke that device");
    }
  }

  const description = !configured ? (
    <>
      This deployment has no push keys. Run <code className="text-[11px]">just up</code> to
      generate them.
    </>
  ) : push.support === "needs-install" ? (
    <>
      Add Postbox to your Home Screen first — tap{" "}
      <ShareIcon className="inline size-3 align-[-1px]" /> Share, then{" "}
      <strong className="font-medium">Add to Home Screen</strong>, and open it from there.
      Apple only allows notifications for an installed app.
    </>
  ) : push.support === "unsupported" ? (
    "This browser cannot receive push notifications."
  ) : (
    "Announced on this device even when Postbox is closed. Every notification is encrypted to this device, so the push service carries no subject lines."
  );

  const rows = devices.data ?? [];

  return (
    <div className="space-y-5">
      {/*
        Android buries this in the browser's ⋮ menu, and people reasonably
        never look there. The dialog it opens is the browser's own either way.

        Shown whenever Postbox is not already installed, rather than only when
        Chromium has an unspent prompt to hand us: `beforeinstallprompt` fires
        once per origin, so a browser that has already offered — or already
        been declined — leaves us with no event and a person still looking for
        the button. Without the event there is no dialog to open, so the row
        says where the browser keeps its own. The one case it stays quiet is
        iOS in a tab, where the two paragraphs below already say it twice.
      */}
      {!push.installed && (
        <div className="flex items-start gap-3 rounded-lg border p-3">
          <span className="text-muted-foreground mt-0.5">
            <DownloadIcon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium">Add to Home screen</p>
            <p className="text-muted-foreground mt-0.5 text-[12px] leading-relaxed">
              Postbox gets its own icon and its own window, with no browser chrome around
              it. Nothing is downloaded and no app store is involved.
            </p>
            {!installable && push.support !== "needs-install" && (
              <p className="text-muted-foreground mt-1.5 text-[12px] leading-relaxed">
                {installHint()}
              </p>
            )}
          </div>
          {installable && (
            <Button variant="outline" size="sm" onClick={install}>
              Install
            </Button>
          )}
        </div>
      )}

      <Row
        icon={<SmartphoneIcon className="size-4" />}
        title="Push notifications"
        description={description}
        checked={push.enabled === true}
        disabled={!configured || push.support !== "ready" || push.busy || push.enabled === null}
        onChange={toggle}
      />

      {/*
        Only worth saying on a phone in a browser tab, where the switch above is
        disabled and the reason is not something anybody would guess.
      */}
      {configured && push.support === "needs-install" && isApple() && (
        <p className="text-muted-foreground rounded-lg border border-dashed p-3 text-[12px] leading-relaxed">
          Installed, Postbox behaves like any other app on the Home Screen: its own icon, its
          own window, no browser chrome — and notifications. Nothing is downloaded and there is
          no App Store account involved.
        </p>
      )}

      {rows.length > 0 && (
        <>
          <Separator />
          <section className="space-y-2">
            <div>
              <p className="text-[13px] font-medium">Devices</p>
              <p className="text-muted-foreground text-[12px] leading-relaxed">
                Everything registered to receive mail. Signing out revokes the device you
                signed out of; anything here you do not recognise can be revoked now.
              </p>
            </div>
            <ul className="divide-y rounded-lg border">
              {rows.map((device) => (
                <li key={device.endpoint} className="flex items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px]">{deviceSummary(device.userAgent)}</p>
                    <p className="text-muted-foreground text-[11px]">
                      Added {relativeTime(device.createdAt)}
                      {device.lastSuccessAt
                        ? ` · last notified ${relativeTime(device.lastSuccessAt)}`
                        : " · not yet notified"}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Revoke this device"
                    onClick={() => revoke(device.endpoint)}
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      {configured && rows.length > 0 && (
        <Button variant="outline" size="sm" disabled={testing} onClick={test}>
          {testing ? "Sending…" : "Send a test notification"}
        </Button>
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
import { applyBrand, normalizeHex, readBrand } from "@/lib/brand.ts";
import { keys, useSettings } from "@/lib/queries.ts";

/**
 * The brand colour, kept in step between the page, this browser and the
 * mailbox.
 *
 * The mailbox is the value of record: whatever it says wins once it arrives,
 * so signing in on a second machine repaints it rather than offering to. What
 * localStorage holds is a cache the pre-paint script in index.html can read,
 * which is why `applyBrand` writes both.
 *
 * `preview` changes the page and nothing else — the colour input fires on
 * every pixel of a drag, and none of those are a decision. `choose` is the
 * decision, and the only thing that reaches the server.
 */
export function useBrand() {
  const client = useQueryClient();
  const settings = useSettings();
  const [brand, setBrand] = useState<string | null>(readBrand);

  const stored = normalizeHex(settings.data?.brand);

  useEffect(() => {
    if (!settings.isSuccess) return;
    setBrand(applyBrand(stored));
  }, [settings.isSuccess, stored]);

  const preview = useCallback((hex: string | null) => {
    setBrand(applyBrand(hex));
  }, []);

  const choose = useCallback(
    async (hex: string | null) => {
      const value = applyBrand(hex);
      setBrand(value);
      // Written into the cache first, so the effect above does not hand the
      // page back the colour it had a moment ago while the PATCH is in flight.
      client.setQueryData(keys.settings, (current: Record<string, unknown> | undefined) => ({
        ...current,
        brand: value,
      }));
      try {
        await api.saveSettings({ brand: value });
      } catch {
        toast.error("Colour applied here, but the mailbox did not save it", {
          description: "Other browsers will keep the old one until this works.",
        });
      }
    },
    [client],
  );

  return { brand, preview, choose };
}

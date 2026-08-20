import { lazy, type ComponentType } from "react";

/**
 * `React.lazy`, but able to survive a deploy.
 *
 * Chunk filenames carry a content hash, so deploying replaces every one of
 * them. A tab that was open beforehand still holds the old names, and the
 * first split component it opens after the deploy — Settings, say — fetches a
 * file that is no longer there. The import rejects, nothing catches it, and
 * React unmounts the entire app: a white page, from one dialog.
 *
 * Reloading fixes it, because index.html then points at the new names. The
 * session flag is what keeps that from becoming a reload loop when the chunk
 * is missing for some other reason.
 */
const RELOADED = "postbox:chunk-reloaded";

function flag(): string | null {
  try {
    return sessionStorage.getItem(RELOADED);
  } catch {
    return "1"; // No sessionStorage (private mode): never auto-reload.
  }
}

function setFlag(value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(RELOADED);
    else sessionStorage.setItem(RELOADED, value);
  } catch {
    /* best effort */
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors React.lazy's own signature
export function lazyWithReload<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
) {
  return lazy(async () => {
    try {
      const module = await load();
      setFlag(null);
      return module;
    } catch (error) {
      if (flag()) throw error;
      setFlag("1");
      location.reload();
      // The reload takes over; resolving would render against a dead bundle.
      return new Promise<never>(() => {});
    }
  });
}

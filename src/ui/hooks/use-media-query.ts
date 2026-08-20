import { useEffect, useState } from "react";

/**
 * Reactive media query.
 *
 * Used where a layout difference cannot be expressed in CSS alone — for
 * example rendering the sidebar into a drawer rather than a rail, which is a
 * different component tree, not a different class.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(query);
    const listener = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(media.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [query]);

  return matches;
}

/** Tailwind's `md` breakpoint — below this, the app is in phone layout. */
export const useIsMobile = () => !useMediaQuery("(min-width: 768px)");

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils.ts";

/**
 * A two-column split with a draggable divider.
 *
 * Hand-rolled rather than pulled from a library: the whole requirement is
 * "drag a line, remember where it was", and a grid template plus pointer
 * capture covers it in fewer lines than the integration would take.
 */
export function SplitPane({
  storageKey,
  initial = 34,
  min = 24,
  max = 56,
  left,
  right,
  className,
  leftClassName,
  rightClassName,
}: {
  storageKey: string;
  initial?: number;
  min?: number;
  max?: number;
  left: React.ReactNode;
  right: React.ReactNode;
  className?: string;
  /**
   * Applied to the grid cells themselves, not to their contents.
   *
   * Below `lg` only one pane is shown at a time, and hiding an *inner* element
   * still leaves its grid cell occupying a full screen height — which pushes
   * the other pane out of view. The visibility class has to live on the cell.
   */
  leftClassName?: string;
  rightClassName?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [percent, setPercent] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(stored) && stored >= min && stored <= max) return stored;
    } catch {
      /* private mode */
    }
    return initial;
  });
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(Math.round(percent)));
    } catch {
      /* private mode */
    }
  }, [percent, storageKey]);

  const applyFromClientX = useCallback(
    (clientX: number) => {
      const bounds = container.current?.getBoundingClientRect();
      if (!bounds || bounds.width === 0) return;
      const next = ((clientX - bounds.left) / bounds.width) * 100;
      setPercent(Math.min(max, Math.max(min, next)));
    },
    [min, max],
  );

  return (
    <div
      ref={container}
      // Below `lg` the two panes are never shown at once — the caller hides
      // whichever is inactive — so the split collapses to a single column and
      // the visible pane gets the full width instead of a dead gutter.
      className={cn("block min-w-0 lg:grid", className)}
      style={{ gridTemplateColumns: `${percent}% 1px 1fr` }}
    >
      <div className={cn("min-w-0 overflow-hidden max-lg:h-full", leftClassName)}>{left}</div>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (dragging) applyFromClientX(event.clientX);
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          setDragging(false);
        }}
        onDoubleClick={() => setPercent(initial)}
        onKeyDown={(event) => {
          // Keyboard resize, because a mouse-only divider is not an interface.
          if (event.key === "ArrowLeft") setPercent((p) => Math.max(min, p - 2));
          if (event.key === "ArrowRight") setPercent((p) => Math.min(max, p + 2));
        }}
        className={cn(
          "bg-border hover:bg-ring relative cursor-col-resize transition-colors max-lg:hidden",
          dragging && "bg-ring",
          // A 1px target is unhittable; widen the hit area without widening the line.
          "after:absolute after:inset-y-0 after:-left-1.5 after:w-3.5 after:content-['']",
        )}
      />

      <div className={cn("min-w-0 overflow-hidden max-lg:h-full", rightClassName)}>{right}</div>
    </div>
  );
}

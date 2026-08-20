import type * as React from "react";
import { cn } from "@/lib/utils.ts";

/**
 * Keyboard hint. Not a stock shadcn primitive, but this app leans on shortcuts
 * hard enough that they deserve a consistent, quiet visual treatment.
 */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "bg-muted text-muted-foreground border-border pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center rounded border px-1.5 font-mono text-[10px] font-medium",
        // A shortcut hint on a touch device is a promise the hardware cannot keep.
        "max-md:hidden",
        className,
      )}
      {...props}
    />
  );
}

export { Kbd };

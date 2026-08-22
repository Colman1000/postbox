import * as ProgressPrimitive from "@radix-ui/react-progress";
import type * as React from "react";
import { cn } from "@/lib/utils.ts";

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      // Passed on as well as used below: without it Radix reports the bar as
      // indeterminate, so the fill moves but a screen reader is told nothing
      // is known about how far along it is.
      value={value}
      className={cn("bg-muted relative h-1 w-full overflow-hidden rounded-full", className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className="bg-primary h-full w-full flex-1 transition-transform"
        style={{ transform: `translateX(-${100 - (value ?? 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress };

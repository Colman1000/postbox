import * as SwitchPrimitive from "@radix-ui/react-switch";
import type * as React from "react";
import { cn } from "@/lib/utils.ts";

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none",
        "data-[state=checked]:bg-primary data-[state=unchecked]:bg-input focus-visible:ring-[3px] focus-visible:ring-ring/40",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "bg-background pointer-events-none block size-4 rounded-full ring-0 transition-transform",
          "data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };

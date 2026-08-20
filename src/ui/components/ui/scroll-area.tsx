import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import type * as React from "react";
import { cn } from "@/lib/utils.ts";

function ScrollArea({
  className,
  children,
  viewportRef,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  viewportRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <ScrollAreaPrimitive.Root className={cn("relative", className)} {...props}>
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        className="size-full rounded-[inherit] outline-none [&>div]:!block"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.ScrollAreaScrollbar
        orientation="vertical"
        className="flex w-2 touch-none p-px transition-colors select-none"
      >
        <ScrollAreaPrimitive.ScrollAreaThumb className="bg-border relative flex-1 rounded-full" />
      </ScrollAreaPrimitive.ScrollAreaScrollbar>
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

export { ScrollArea };

import { Command as CommandPrimitive } from "cmdk";
import { SearchIcon } from "lucide-react";
import type * as React from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog.tsx";
import { cn } from "@/lib/utils.ts";

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      className={cn(
        "bg-popover text-popover-foreground flex size-full flex-col overflow-hidden rounded-lg",
        className,
      )}
      {...props}
    />
  );
}

function CommandDialog({
  title = "Command palette",
  description = "Search for a command to run",
  children,
  className,
  shouldFilter,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title?: string;
  description?: string;
  className?: string;
  /** Off while the palette is showing server-side search results. */
  shouldFilter?: boolean;
}) {
  return (
    <Dialog {...props}>
      <DialogContent
        showClose={false}
        className={cn("overflow-hidden p-0 sm:max-w-2xl", className)}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        <Command
          shouldFilter={shouldFilter}
          className={cn(
            "[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide",
            "[&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:size-4 [&_[cmdk-item]]:px-3 [&_[cmdk-item]]:py-2.5 [&_[cmdk-item]_svg]:size-4",
          )}
        >
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex h-12 items-center gap-2 border-b px-4" cmdk-input-wrapper="">
      <SearchIcon className="size-4 shrink-0 opacity-50" />
      <CommandPrimitive.Input
        className={cn(
          "placeholder:text-muted-foreground flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      className={cn("max-h-96 scroll-py-1 overflow-x-hidden overflow-y-auto p-1", className)}
      {...props}
    />
  );
}

function CommandEmpty(props: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      className="text-muted-foreground py-8 text-center text-sm"
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return <CommandPrimitive.Group className={cn("overflow-hidden", className)} {...props} />;
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return <CommandPrimitive.Separator className={cn("bg-border -mx-1 h-px", className)} {...props} />;
}

function CommandItem({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground relative flex cursor-default items-center gap-2.5 rounded-md px-3 py-2 text-sm outline-none select-none",
        "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn("text-muted-foreground ml-auto font-mono text-[10px] tracking-widest", className)}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
};

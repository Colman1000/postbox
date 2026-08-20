import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * Toasts, themed to match. Deliberately bottom-left: the bottom-right corner
 * is where Compose lives.
 */
function Toaster(props: ToasterProps) {
  return (
    <Sonner
      position="bottom-left"
      offset={16}
      // Clear of the home indicator, and of the compose button on the right.
      mobileOffset={{ bottom: "calc(1rem + env(safe-area-inset-bottom))", left: "0.75rem", right: "5.5rem" }}
      toastOptions={{
        classNames: {
          toast:
            "group flex items-center gap-3 rounded-lg border bg-popover text-popover-foreground shadow-lg p-3 text-sm w-full",
          description: "text-muted-foreground text-xs",
          actionButton:
            "bg-primary text-primary-foreground rounded-md px-2.5 h-7 text-xs font-medium shrink-0",
          cancelButton: "bg-muted text-muted-foreground rounded-md px-2.5 h-7 text-xs shrink-0",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };

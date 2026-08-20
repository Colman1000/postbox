import { useEffect } from "react";
import { LoaderCircleIcon } from "lucide-react";
import { useSession } from "@/lib/queries.ts";
import { applyTheme, readTheme } from "@/lib/theme.ts";
import { LoginScreen } from "@/components/mail/login-screen.tsx";
import { MailApp } from "@/components/mail/mail-app.tsx";
import { Toaster } from "@/components/ui/sonner.tsx";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";

export default function App() {
  const session = useSession();

  // Keep "system" theme live if the OS setting changes while the app is open.
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      if (readTheme() === "system") applyTheme("system");
    };
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  if (session.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoaderCircleIcon className="text-muted-foreground size-5 animate-spin" />
      </div>
    );
  }

  if (session.isError || !session.data) {
    return (
      <div className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="text-base font-semibold">Postbox is unreachable</h1>
        <p className="text-muted-foreground text-sm">
          The API did not respond. If you just deployed, give it a few seconds and reload.
        </p>
      </div>
    );
  }

  return (
    <TooltipProvider>
      {session.data.authenticated ? (
        <MailApp session={session.data} />
      ) : (
        <LoginScreen domain={session.data.domain} />
      )}
      <Toaster />
    </TooltipProvider>
  );
}

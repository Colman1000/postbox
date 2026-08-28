import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App.tsx";
import { ErrorBoundary } from "./components/error-boundary.tsx";
// Registers the `beforeinstallprompt` listener on the way past. It has to be
// in place before the browser fires it, which is well before Settings exists.
import "./lib/install.ts";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      retry: (failureCount, error) =>
        // A 401 means "sign in", not "try harder".
        !(error instanceof Error && "status" in error && (error as { status: number }).status === 401) &&
        failureCount < 2,
    },
  },
});

/**
 * Register the service worker on the way in.
 *
 * It carries no cache and does nothing at all until a push arrives, so it can
 * be registered unconditionally: there is no behaviour to opt into, only a
 * receiver to have in place before the first notification is sent. Doing it
 * here rather than behind the switch in Settings matters on iOS, where the
 * registration has to survive the app being closed for a week.
 *
 * A failure is not worth reporting. The rest of the app is unaffected, and
 * Settings will say push is unavailable if it comes to that.
 */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </QueryClientProvider>
  </StrictMode>,
);

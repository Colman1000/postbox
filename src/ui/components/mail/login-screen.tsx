import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LoaderCircleIcon, LockIcon } from "lucide-react";
import { api, ApiError } from "@/lib/api.ts";
import { keys } from "@/lib/queries.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";

/**
 * The only unauthenticated screen.
 *
 * The password was generated at deploy time and printed once; if the reader
 * lost it, the fastest recovery is `just secrets`, so the screen says exactly
 * that rather than making them go looking.
 */
export function LoginScreen({ domain }: { domain: string }) {
  const client = useQueryClient();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      await client.invalidateQueries({ queryKey: keys.session });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not sign in.");
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-[22rem]">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="bg-primary text-primary-foreground flex size-11 items-center justify-center rounded-xl">
            <LockIcon className="size-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Postbox</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Mail for <span className="text-foreground font-medium">{domain}</span>
            </p>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="password" className="sr-only">
              Password
            </Label>
            <Input
              id="password"
              type="password"
              autoFocus
              autoComplete="current-password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-10 text-center tracking-wide"
              aria-invalid={!!error}
            />
          </div>

          {error && (
            <p role="alert" className="text-destructive-foreground bg-destructive rounded-md px-3 py-2 text-center text-xs">
              {error}
            </p>
          )}

          <Button type="submit" className="h-10 w-full" disabled={busy || !password}>
            {busy && <LoaderCircleIcon className="animate-spin" />}
            {busy ? "Signing in" : "Sign in"}
          </Button>
        </form>

        <p className="text-muted-foreground mt-6 text-center text-xs leading-relaxed">
          Lost the password? Run{" "}
          <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">just secrets</code>{" "}
          where you deployed from.
        </p>
      </div>
    </div>
  );
}

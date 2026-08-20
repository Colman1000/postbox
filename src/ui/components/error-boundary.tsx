import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";

/**
 * The difference between a bug and a blank page.
 *
 * React unmounts the whole tree when a render throws and nothing catches it,
 * so without this a single failing dialog takes the mailbox with it and leaves
 * nothing on screen to explain why. Here the failure stays where it happened,
 * says what broke, and offers the one action that usually helps.
 */
interface Props {
  children: ReactNode;
  /** Shown instead of the full-page treatment, for boundaries around a part. */
  compact?: boolean;
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[postbox] render failed", error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const what = this.props.label ?? "This part of the app";

    if (this.props.compact) {
      return (
        <div className="bg-popover fixed bottom-4 left-1/2 z-50 w-[min(28rem,calc(100%-2rem))] -translate-x-1/2 rounded-lg border p-4 shadow-2xl">
          <p className="text-[13px] font-medium">{what} stopped working.</p>
          <p className="text-muted-foreground mt-1 text-[12px]">{error.message}</p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={this.reset}>
              Try again
            </Button>
            <Button size="sm" variant="ghost" onClick={() => location.reload()}>
              Reload
            </Button>
          </div>
        </div>
      );
    }

    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="text-base font-semibold">Postbox hit an error</h1>
        <p className="text-muted-foreground text-sm">{error.message}</p>
        <Button onClick={() => location.reload()}>Reload</Button>
      </div>
    );
  }
}

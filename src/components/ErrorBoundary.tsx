import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportClientError } from "@/lib/monitoring";

type Props = { children: ReactNode };
type State = { hasError: boolean; error?: Error };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // A page file that no longer exists means a new version was deployed while this tab was open.
    // Reloading once picks up the new version; the timestamp stops it looping if the cause is something else.
    if (/dynamically imported module|importing a module script|not a valid javascript mime type/i.test(error?.message || "")) {
      try {
        const last = Number(sessionStorage.getItem("page-reload-at") || 0);
        if (Date.now() - last > 10000) {
          sessionStorage.setItem("page-reload-at", String(Date.now()));
          window.location.reload();
          return;
        }
      } catch {
        // Fall through to the normal error screen.
      }
    }
    console.error("[ErrorBoundary]", error, info);
    reportClientError(error, { componentStack: info.componentStack || undefined });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-surface-muted px-6 text-center">
          <h1 className="text-2xl font-semibold text-navy">Something went wrong</h1>
          <p className="max-w-md text-sm text-ink-light">
            An unexpected error occurred. Try reloading the page — if it keeps happening, let your
            administrator know what you were doing when it happened.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="rounded-lg bg-navy px-4 py-2 text-sm font-medium text-white hover:bg-navy-700"
          >
            Reload page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

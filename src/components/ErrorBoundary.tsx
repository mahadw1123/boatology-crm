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

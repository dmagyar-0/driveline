// Top-level error boundary. Without one, a single throw during render —
// anywhere in a panel or drawer — unmounts the entire React tree and the
// instrument goes black with nothing but a console line to explain it.
// This boundary swaps the tree for a crash card naming the error, with a
// reload action (the saved workspace layout survives a reload; loaded
// files don't, and the card says so).
//
// A class component on purpose: React still has no hook equivalent of
// `getDerivedStateFromError`.

import { Component, type ErrorInfo, type ReactNode } from "react";
import s from "./AppErrorBoundary.module.css";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // React only logs boundary-caught errors in dev builds; keep a
    // production breadcrumb so a reported crash card has console context.
    console.error("driveline render crash:", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    const message = this.state.error.message || String(this.state.error);
    return (
      <div className={s.crash} role="alert" data-testid="app-error-boundary">
        <div className={s.card}>
          <h1 className={s.title}>Driveline hit a render error</h1>
          <p className={s.message} data-testid="app-error-message">
            {message}
          </p>
          <p className={s.hint}>
            Reloading restores the saved workspace layout. Files that were
            loaded this session will need to be opened again.
          </p>
          <button
            type="button"
            className={s.reload}
            onClick={() => window.location.reload()}
            data-testid="app-error-reload"
          >
            Reload Driveline
          </button>
        </div>
      </div>
    );
  }
}

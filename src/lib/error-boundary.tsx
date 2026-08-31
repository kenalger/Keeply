import { Component, type ErrorInfo, type ReactNode } from 'react';

import { toErrorCode, toUserMessage } from './errors';
import { FallbackScreen } from './fallback-screen';
import { log } from './log';

/**
 * The app-level React error boundary.
 *
 * Wraps the tab tree, below `ThemeProvider`, so a render crash inside any
 * screen becomes a calm themed message with a Reload action instead of a white
 * screen or a red box in front of a user.
 *
 * "Reload" here means: drop the boundary's error state and re-mount the
 * subtree. Data lives in SQLite, so re-mounting loses nothing but transient UI
 * state. It never reloads the JS bundle and it never touches the network.
 */

interface Props {
  children: ReactNode;
  /**
   * Called before the subtree re-mounts, so callers can clear whatever
   * transient state might have caused the crash.
   */
  onReset?: () => void;
}

interface State {
  error: Error | null;
  /** Bumped on reset so the subtree is re-created rather than re-used. */
  generation: number;
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null, generation: 0 };

  static getDerivedStateFromError(error: Error): Pick<State, 'error'> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The redacting logger is the only thing that ever sees the error object.
    log.error('render crash caught by AppErrorBoundary', error, {
      code: toErrorCode(error),
      // `componentStack` is component names only — no user data — but it still
      // goes through the logger's scrubber.
      componentStack: (info.componentStack ?? '').split('\n').slice(0, 4).join(' ← '),
    });
  }

  private handleReset = (): void => {
    this.props.onReset?.();
    this.setState((previous) => ({ error: null, generation: previous.generation + 1 }));
  };

  render(): ReactNode {
    const { error, generation } = this.state;

    if (error) {
      const message = toUserMessage(error);
      return (
        <FallbackScreen
          tone="danger"
          title={message.title}
          body={message.body}
          footnote="Nothing was deleted. Everything you have saved is still on this device."
          actionLabel="Reload Keeply"
          onAction={this.handleReset}
        />
      );
    }

    // `key` forces a fresh mount of the subtree on every reload.
    return <ErrorBoundarySubtree key={generation}>{this.props.children}</ErrorBoundarySubtree>;
  }
}

function ErrorBoundarySubtree({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

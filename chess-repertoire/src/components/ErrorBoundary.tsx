import React, { Component, ErrorInfo, ReactNode } from 'react';
import { logger } from '../utils/errorLogger';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    logger.error(
      'render',
      `Component crashed: ${error.message}`,
      errorInfo.componentStack ?? error.stack
    );
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="flex items-center justify-center h-full p-4">
          <div className="bg-bg-surface border border-accent-red/30 rounded-lg p-4 max-w-md text-center">
            <div className="text-accent-red text-sm font-semibold mb-2">
              Something went wrong
            </div>
            <div className="text-text-muted text-xs mb-3">
              {this.state.error?.message || 'An unexpected error occurred.'}
            </div>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="btn-primary text-xs"
            >
              Try Again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

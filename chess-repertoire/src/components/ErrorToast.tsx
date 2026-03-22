import React from 'react';
import { AlertTriangle, X, Info, XCircle, ChevronDown } from 'lucide-react';
import { useErrorContext, type ErrorSeverity } from '../context/ErrorContext';

// ─── Severity styles ─────────────────────────────────────────────────

const SEVERITY_STYLES: Record<
  ErrorSeverity,
  { bg: string; border: string; text: string; icon: React.ReactNode }
> = {
  info: {
    bg: 'bg-accent-teal/10',
    border: 'border-accent-teal/30',
    text: 'text-accent-teal',
    icon: <Info size={14} />,
  },
  warning: {
    bg: 'bg-accent-amber/10',
    border: 'border-accent-amber/30',
    text: 'text-accent-amber',
    icon: <AlertTriangle size={14} />,
  },
  error: {
    bg: 'bg-accent-red/10',
    border: 'border-accent-red/30',
    text: 'text-accent-red',
    icon: <XCircle size={14} />,
  },
};

// ─── Component ───────────────────────────────────────────────────────

export const ErrorToast: React.FC = () => {
  const { state, dismissToast, togglePanel } = useErrorContext();
  const { toast, entries } = state;

  const errorCount = entries.filter((e) => e.severity !== 'info').length;

  if (!toast && errorCount === 0) return null;

  // When no active toast, show a small badge that opens the log panel.
  if (!toast) {
    return (
      <button
        onClick={togglePanel}
        className="fixed bottom-3 right-3 z-40 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-bg-surface border border-border-subtle shadow-md text-xs text-text-secondary hover:text-text-primary hover:border-border-active transition-colors"
        title="Open error log"
      >
        <AlertTriangle size={12} className="text-accent-amber" />
        {errorCount}
      </button>
    );
  }

  const style = SEVERITY_STYLES[toast.severity];

  return (
    <div
      className={`fixed bottom-3 right-3 z-50 max-w-sm w-full animate-fade-in ${style.bg} ${style.border} border rounded-lg shadow-lg`}
    >
      <div className="flex items-start gap-2 px-3 py-2.5">
        {/* Icon */}
        <span className={`mt-0.5 flex-shrink-0 ${style.text}`}>{style.icon}</span>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className={`text-xs font-semibold ${style.text} uppercase tracking-wide mb-0.5`}>
            {toast.category}
          </div>
          <div className="text-sm text-text-primary leading-snug">
            {toast.message}
          </div>
          {toast.details && (
            <div className="text-[11px] text-text-muted mt-1 font-mono truncate" title={toast.details}>
              {toast.details}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {errorCount > 1 && (
            <button
              onClick={togglePanel}
              className="p-1 rounded hover:bg-black/5 transition-colors"
              title="View all errors"
            >
              <ChevronDown size={14} className="text-text-muted" />
            </button>
          )}
          <button
            onClick={dismissToast}
            className="p-1 rounded hover:bg-black/5 transition-colors"
            title="Dismiss"
          >
            <X size={14} className="text-text-muted" />
          </button>
        </div>
      </div>
    </div>
  );
};

import React, { useState } from 'react';
import { X, Trash2, AlertTriangle, XCircle, Info, Filter } from 'lucide-react';
import { useErrorContext, type LogEntry, type ErrorSeverity, type ErrorCategory } from '../context/ErrorContext';

// ─── Helpers ─────────────────────────────────────────────────────────

const SEVERITY_ICON: Record<ErrorSeverity, React.ReactNode> = {
  info: <Info size={12} className="text-accent-teal" />,
  warning: <AlertTriangle size={12} className="text-accent-amber" />,
  error: <XCircle size={12} className="text-accent-red" />,
};

const SEVERITY_DOT: Record<ErrorSeverity, string> = {
  info: 'bg-accent-teal',
  warning: 'bg-accent-amber',
  error: 'bg-accent-red',
};

const CATEGORY_LABELS: Record<ErrorCategory, string> = {
  engine: 'Engine',
  storage: 'Storage',
  import: 'Import',
  export: 'Export',
  render: 'Render',
  general: 'General',
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ─── Component ───────────────────────────────────────────────────────

export const ErrorLogPanel: React.FC = () => {
  const { state, closePanel, clearLog } = useErrorContext();
  const [categoryFilter, setCategoryFilter] = useState<ErrorCategory | 'all'>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (!state.panelOpen) return null;

  const filtered =
    categoryFilter === 'all'
      ? state.entries
      : state.entries.filter((e) => e.category === categoryFilter);

  // Most recent first.
  const sorted = [...filtered].reverse();

  // Categories present in the log (for filter chips).
  const activeCategories = Array.from(new Set(state.entries.map((e) => e.category)));

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 backdrop-blur-sm z-40"
        onClick={closePanel}
      />

      {/* Panel */}
      <div className="fixed bottom-0 right-0 z-50 w-full max-w-lg h-[60vh] bg-bg-surface border-l border-t border-border-subtle rounded-tl-xl shadow-2xl flex flex-col animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} className="text-accent-amber" />
            <span className="font-mono text-sm text-text-primary font-semibold">
              Error Log
            </span>
            <span className="text-[10px] text-text-muted bg-bg-hover rounded-full px-2 py-0.5">
              {state.entries.length}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={clearLog}
              className="btn-icon p-1.5"
              title="Clear log"
            >
              <Trash2 size={14} />
            </button>
            <button
              onClick={closePanel}
              className="btn-icon p-1.5"
              title="Close"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Category filter chips */}
        {activeCategories.length > 1 && (
          <div className="flex items-center gap-1.5 px-4 py-2 border-b border-border-subtle overflow-x-auto">
            <Filter size={12} className="text-text-muted flex-shrink-0" />
            <button
              onClick={() => setCategoryFilter('all')}
              className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                categoryFilter === 'all'
                  ? 'bg-accent-teal/10 border-accent-teal/30 text-accent-teal'
                  : 'border-border-subtle text-text-muted hover:text-text-secondary'
              }`}
            >
              All
            </button>
            {activeCategories.map((cat) => (
              <button
                key={cat}
                onClick={() => setCategoryFilter(cat)}
                className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                  categoryFilter === cat
                    ? 'bg-accent-teal/10 border-accent-teal/30 text-accent-teal'
                    : 'border-border-subtle text-text-muted hover:text-text-secondary'
                }`}
              >
                {CATEGORY_LABELS[cat]}
              </button>
            ))}
          </div>
        )}

        {/* Entries */}
        <div className="flex-1 overflow-auto">
          {sorted.length === 0 ? (
            <div className="flex items-center justify-center h-full text-text-muted text-sm">
              No log entries yet.
            </div>
          ) : (
            <div className="divide-y divide-border-subtle">
              {sorted.map((entry) => (
                <LogRow
                  key={entry.id}
                  entry={entry}
                  expanded={expandedId === entry.id}
                  onToggle={() =>
                    setExpandedId(expandedId === entry.id ? null : entry.id)
                  }
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
};

// ─── Log row ─────────────────────────────────────────────────────────

const LogRow: React.FC<{
  entry: LogEntry;
  expanded: boolean;
  onToggle: () => void;
}> = ({ entry, expanded, onToggle }) => {
  return (
    <div
      className="px-4 py-2.5 hover:bg-bg-hover/50 cursor-pointer transition-colors"
      onClick={onToggle}
    >
      <div className="flex items-start gap-2">
        {/* Severity icon */}
        <span className="mt-0.5 flex-shrink-0">{SEVERITY_ICON[entry.severity]}</span>

        {/* Body */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span
              className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${SEVERITY_DOT[entry.severity]}`}
            />
            <span className="text-[10px] font-mono text-text-muted uppercase tracking-wide">
              {CATEGORY_LABELS[entry.category]}
            </span>
            <span className="text-[10px] text-text-muted ml-auto flex-shrink-0">
              {formatTime(entry.timestamp)}
            </span>
          </div>
          <div className="text-sm text-text-primary leading-snug">{entry.message}</div>

          {/* Expanded details */}
          {expanded && entry.details && (
            <pre className="mt-2 text-[11px] font-mono text-text-muted bg-bg-primary border border-border-subtle rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
              {entry.details}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
};

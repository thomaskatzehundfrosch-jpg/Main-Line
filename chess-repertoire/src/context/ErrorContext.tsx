import React, { createContext, useContext, useReducer, useEffect, useCallback, ReactNode } from 'react';
import {
  subscribe,
  getLog,
  clearLog as clearLogEntries,
  type LogEntry,
  type ErrorSeverity,
  type ErrorCategory,
} from '../utils/errorLogger';

// ─── State ────────────────────────────────────────────────────────────

export interface ErrorState {
  /** Full ordered log. */
  entries: LogEntry[];
  /** Currently visible toast (null when nothing to show). */
  toast: LogEntry | null;
  /** Whether the expanded error log panel is open. */
  panelOpen: boolean;
}

// ─── Actions ──────────────────────────────────────────────────────────

type ErrorAction =
  | { type: 'NEW_ENTRY'; entry: LogEntry }
  | { type: 'DISMISS_TOAST' }
  | { type: 'TOGGLE_PANEL' }
  | { type: 'CLOSE_PANEL' }
  | { type: 'CLEAR_LOG' };

// ─── Reducer ──────────────────────────────────────────────────────────

function errorReducer(state: ErrorState, action: ErrorAction): ErrorState {
  switch (action.type) {
    case 'NEW_ENTRY':
      return {
        ...state,
        entries: [...state.entries, action.entry],
        // Only show toast for warnings and errors (not info).
        toast:
          action.entry.severity === 'info' ? state.toast : action.entry,
      };
    case 'DISMISS_TOAST':
      return { ...state, toast: null };
    case 'TOGGLE_PANEL':
      return { ...state, panelOpen: !state.panelOpen };
    case 'CLOSE_PANEL':
      return { ...state, panelOpen: false };
    case 'CLEAR_LOG':
      return { ...state, entries: [], toast: null };
    default:
      return state;
  }
}

// ─── Context ──────────────────────────────────────────────────────────

interface ErrorContextValue {
  state: ErrorState;
  dismissToast: () => void;
  togglePanel: () => void;
  closePanel: () => void;
  clearLog: () => void;
}

const ErrorContext = createContext<ErrorContextValue | null>(null);

export function ErrorProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(errorReducer, {
    entries: getLog(),
    toast: null,
    panelOpen: false,
  });

  // Subscribe to the logger so new entries update React state.
  useEffect(() => {
    const unsub = subscribe((entry) => {
      dispatch({ type: 'NEW_ENTRY', entry });
    });
    return unsub;
  }, []);

  // Auto-dismiss toast after 6 seconds.
  useEffect(() => {
    if (!state.toast) return;
    const timer = setTimeout(() => {
      dispatch({ type: 'DISMISS_TOAST' });
    }, 6000);
    return () => clearTimeout(timer);
  }, [state.toast?.id]);

  const dismissToast = useCallback(() => dispatch({ type: 'DISMISS_TOAST' }), []);
  const togglePanel = useCallback(() => dispatch({ type: 'TOGGLE_PANEL' }), []);
  const closePanel = useCallback(() => dispatch({ type: 'CLOSE_PANEL' }), []);
  const clearLog = useCallback(() => {
    clearLogEntries();
    dispatch({ type: 'CLEAR_LOG' });
  }, []);

  return (
    <ErrorContext.Provider value={{ state, dismissToast, togglePanel, closePanel, clearLog }}>
      {children}
    </ErrorContext.Provider>
  );
}

export function useErrorContext() {
  const ctx = useContext(ErrorContext);
  if (!ctx) throw new Error('useErrorContext must be used within ErrorProvider');
  return ctx;
}

export type { LogEntry, ErrorSeverity, ErrorCategory };

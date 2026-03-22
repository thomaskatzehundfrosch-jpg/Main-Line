/**
 * Centralized error logging service.
 *
 * Collects errors from across the application (engine, storage, import,
 * React boundaries, unhandled rejections) and notifies subscribers so
 * the UI can show toast notifications and an error log panel.
 */

export type ErrorSeverity = 'info' | 'warning' | 'error';

export type ErrorCategory = 'engine' | 'storage' | 'import' | 'export' | 'render' | 'general';

export interface LogEntry {
  id: string;
  timestamp: number;
  severity: ErrorSeverity;
  category: ErrorCategory;
  message: string;
  /** Optional technical details (stack trace, raw error, etc.) */
  details?: string;
}

type Subscriber = (entry: LogEntry) => void;

const MAX_LOG_SIZE = 200;
let idCounter = 0;

/** In-memory error log. */
const log: LogEntry[] = [];

/** Subscriber set — UI components listen here for new entries. */
const subscribers = new Set<Subscriber>();

// ─── Public API ──────────────────────────────────────────────────────

function generateId(): string {
  return `log_${Date.now()}_${++idCounter}`;
}

/**
 * Push a new entry into the log and notify subscribers.
 */
export function logError(
  severity: ErrorSeverity,
  category: ErrorCategory,
  message: string,
  details?: string
): LogEntry {
  const entry: LogEntry = {
    id: generateId(),
    timestamp: Date.now(),
    severity,
    category,
    message,
    details,
  };

  log.push(entry);

  // Trim oldest entries when the buffer is full.
  while (log.length > MAX_LOG_SIZE) {
    log.shift();
  }

  // Also mirror to the browser console so devtools stay useful.
  const consoleMsg = `[${category}] ${message}`;
  if (severity === 'error') {
    console.error(consoleMsg, details ?? '');
  } else if (severity === 'warning') {
    console.warn(consoleMsg, details ?? '');
  } else {
    console.info(consoleMsg, details ?? '');
  }

  // Notify UI subscribers.
  for (const fn of subscribers) {
    try {
      fn(entry);
    } catch {
      // Never let a subscriber crash the logger.
    }
  }

  return entry;
}

/** Convenience wrappers. */
export const logger = {
  info: (category: ErrorCategory, message: string, details?: string) =>
    logError('info', category, message, details),
  warn: (category: ErrorCategory, message: string, details?: string) =>
    logError('warning', category, message, details),
  error: (category: ErrorCategory, message: string, details?: string) =>
    logError('error', category, message, details),
};

/**
 * Subscribe to new log entries.  Returns an unsubscribe function.
 */
export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** Return a shallow copy of the current log. */
export function getLog(): LogEntry[] {
  return [...log];
}

/** Clear all log entries. */
export function clearLog(): void {
  log.length = 0;
}

// ─── localStorage quota helper ───────────────────────────────────────

/**
 * Try to write to localStorage and surface a meaningful message on
 * failure (e.g. QuotaExceededError).
 *
 * Returns true if the write succeeded.
 */
export function safePersist(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err: unknown) {
    const isQuota =
      err instanceof DOMException &&
      (err.name === 'QuotaExceededError' ||
        err.name === 'NS_ERROR_DOM_QUOTA_REACHED');

    if (isQuota) {
      logger.error(
        'storage',
        'Storage quota exceeded — your repertoire data may not be saved. Consider exporting a backup.',
        `Key: ${key}, Size: ${(value.length / 1024).toFixed(1)} KB`
      );
    } else {
      logger.error(
        'storage',
        'Failed to save data to local storage.',
        err instanceof Error ? err.message : String(err)
      );
    }
    return false;
  }
}

// ─── Global handlers ─────────────────────────────────────────────────

let globalHandlersInstalled = false;

/**
 * Install window-level error & unhandledrejection handlers (call once
 * at app startup).
 */
export function installGlobalHandlers(): void {
  if (globalHandlersInstalled) return;
  globalHandlersInstalled = true;

  window.addEventListener('error', (event) => {
    // Avoid logging the same error twice if it was already caught by
    // React's error boundary.
    logger.error(
      'general',
      event.message || 'An unexpected error occurred.',
      event.filename
        ? `${event.filename}:${event.lineno}:${event.colno}`
        : undefined
    );
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : 'Unhandled promise rejection';
    logger.error(
      'general',
      message,
      reason instanceof Error ? reason.stack : undefined
    );
  });
}

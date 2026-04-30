import * as SQLite from 'expo-sqlite';

export type DebugLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type DebugLogEntry = {
  id: number;
  created_at: string;
  level: DebugLogLevel;
  scope: string;
  message: string;
  details?: string | null;
};

type DebugLogInsert = Omit<DebugLogEntry, 'id'>;

const MAX_LOG_ROWS = 1000;
const dbPromise = SQLite.openDatabaseAsync('infchat-debug-log-v1.db');
let schemaPromise: Promise<void> | null = null;
let writeQueue: Promise<unknown> = Promise.resolve();
let isConsoleCaptureInstalled = false;
let isErrorCaptureInstalled = false;

const originalConsole = {
  debug: console.debug.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
  log: console.log.bind(console),
  warn: console.warn.bind(console),
};

type GlobalErrorUtils = {
  getGlobalHandler?: () => (error: unknown, isFatal?: boolean) => void;
  setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
};

type GlobalPromiseRejectionTracking = {
  enable?: (options: {
    allRejections?: boolean;
    onUnhandled?: (id: number, error: unknown) => void;
  }) => void;
};

async function getDb() {
  const db = await dbPromise;
  schemaPromise ??= db.execAsync(`
    CREATE TABLE IF NOT EXISTS debug_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      level TEXT NOT NULL,
      scope TEXT NOT NULL,
      message TEXT NOT NULL,
      details TEXT
    );

    CREATE INDEX IF NOT EXISTS debug_logs_created_idx
      ON debug_logs (created_at DESC, id DESC);
  `);
  await schemaPromise;

  return db;
}

function enqueueDebugWrite<T>(task: () => Promise<T>): Promise<T> {
  const write = writeQueue.then(task, task);
  writeQueue = write.catch((error) => {
    originalConsole.warn('[debug-log] write failed', error);
  });

  return write;
}

export function installDebugLogCapture() {
  installConsoleCapture();
  installGlobalErrorCapture();
  void logDebugEvent('info', 'debug', 'Debug log capture installed');
}

export function logDebugEvent(
  level: DebugLogLevel,
  scope: string,
  message: string,
  details?: unknown,
) {
  const entry: DebugLogInsert = {
    created_at: new Date().toISOString(),
    details: details === undefined ? null : stringifyDebugValue(details),
    level,
    message,
    scope,
  };

  return enqueueDebugWrite(async () => {
    const db = await getDb();
    await db.runAsync(
      `INSERT INTO debug_logs (created_at, level, scope, message, details)
       VALUES (?, ?, ?, ?, ?)`,
      entry.created_at,
      entry.level,
      entry.scope,
      entry.message,
      entry.details ?? null,
    );
    await db.runAsync(
      `DELETE FROM debug_logs
       WHERE id NOT IN (
         SELECT id FROM debug_logs ORDER BY id DESC LIMIT ?
       )`,
      MAX_LOG_ROWS,
    );
  });
}

export async function listDebugLogs(limit = 250): Promise<DebugLogEntry[]> {
  const db = await getDb();
  return db.getAllAsync<DebugLogEntry>(
    `SELECT id, created_at, level, scope, message, details
     FROM debug_logs
     ORDER BY id DESC
     LIMIT ?`,
    limit,
  );
}

export async function clearDebugLogs(): Promise<void> {
  const db = await getDb();
  await enqueueDebugWrite(() => db.runAsync('DELETE FROM debug_logs'));
}

export function formatDebugLogs(logs: DebugLogEntry[]): string {
  return logs
    .map((log) => {
      const details = log.details ? `\n${log.details}` : '';
      return `${log.created_at} ${log.level.toUpperCase()} [${log.scope}] ${log.message}${details}`;
    })
    .join('\n\n');
}

function installConsoleCapture() {
  if (isConsoleCaptureInstalled) {
    return;
  }

  isConsoleCaptureInstalled = true;
  console.debug = (...args: unknown[]) => {
    originalConsole.debug(...args);
    void logDebugEvent('debug', 'console', formatConsoleMessage(args));
  };
  console.info = (...args: unknown[]) => {
    originalConsole.info(...args);
    void logDebugEvent('info', 'console', formatConsoleMessage(args));
  };
  console.log = (...args: unknown[]) => {
    originalConsole.log(...args);
    void logDebugEvent('info', 'console', formatConsoleMessage(args));
  };
  console.warn = (...args: unknown[]) => {
    originalConsole.warn(...args);
    void logDebugEvent('warn', 'console', formatConsoleMessage(args));
  };
  console.error = (...args: unknown[]) => {
    originalConsole.error(...args);
    void logDebugEvent('error', 'console', formatConsoleMessage(args));
  };
}

function installGlobalErrorCapture() {
  if (isErrorCaptureInstalled) {
    return;
  }

  isErrorCaptureInstalled = true;

  const globals = globalThis as typeof globalThis & {
    ErrorUtils?: GlobalErrorUtils;
    PromiseRejectionTracking?: GlobalPromiseRejectionTracking;
  };
  const errorUtils = globals.ErrorUtils;
  const previousHandler = errorUtils?.getGlobalHandler?.();
  errorUtils?.setGlobalHandler?.((error, isFatal) => {
    void logDebugEvent('error', 'runtime', 'Unhandled JS error', {
      error: serializeError(error),
      isFatal: Boolean(isFatal),
    });
    previousHandler?.(error, isFatal);
  });

  const rejectionTracker = globals.PromiseRejectionTracking;
  rejectionTracker?.enable?.({
    allRejections: true,
    onUnhandled: (id, error) => {
      void logDebugEvent('error', 'runtime', 'Unhandled promise rejection', {
        error: serializeError(error),
        id,
      });
    },
  });
}

function formatConsoleMessage(args: unknown[]): string {
  return args.map((arg) => valueToSingleLine(arg)).join(' ');
}

function stringifyDebugValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function valueToSingleLine(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }

  return stringifyDebugValue(value).replace(/\s+/g, ' ').trim();
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return error;
}

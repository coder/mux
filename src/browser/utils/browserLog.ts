export interface BrowserLogEntry {
  timestamp: number;
  level: "error" | "warn" | "info" | "debug";
  message: string;
}

const MAX_ENTRIES = 500;
const entries: BrowserLogEntry[] = [];

type Listener = (entry: BrowserLogEntry) => void;
const listeners = new Set<Listener>();

// Preserve originals so DevTools still works
const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

const LEVEL_MAP = {
  log: "info",
  warn: "warn",
  error: "error",
  debug: "debug",
} as const;

/** Call once at renderer entry (e.g. src/browser/main.tsx), before createRoot. */
export function installBrowserLogCapture(): void {
  for (const method of ["log", "warn", "error", "debug"] as const) {
    console[method] = (...args: unknown[]) => {
      originalConsole[method](...args); // pass through to DevTools

      const message = args
        .map((a) => {
          if (typeof a === "string") return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(" ");

      const entry: BrowserLogEntry = {
        timestamp: Date.now(),
        level: LEVEL_MAP[method],
        message,
      };

      entries.push(entry);
      if (entries.length > MAX_ENTRIES) entries.shift();

      for (const listener of listeners) listener(entry);
    };
  }
}

export function onBrowserLogEntry(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getRecentBrowserLogs(): BrowserLogEntry[] {
  return [...entries];
}

import type { LogLevel } from "./log";

export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  message: string;
  location: string;
}

const MAX_BUFFER_SIZE = 1000;
const buffer: LogEntry[] = [];

type LogListener = (entry: LogEntry) => void;
const listeners = new Set<LogListener>();
const subscriberLevels = new Map<LogListener, LogLevel>();

export function pushLogEntry(entry: LogEntry): void {
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER_SIZE) {
    buffer.shift();
  }

  for (const listener of listeners) {
    listener(entry);
  }
}

export function getRecentLogs(): LogEntry[] {
  return [...buffer];
}

export function clearLogEntries(): void {
  buffer.length = 0;
}

export function onLogEntry(listener: LogListener, requestedLevel?: LogLevel): () => void {
  listeners.add(listener);
  if (requestedLevel) {
    subscriberLevels.set(listener, requestedLevel);
  }

  return () => {
    listeners.delete(listener);
    subscriberLevels.delete(listener);
  };
}

export function hasDebugSubscriber(): boolean {
  for (const level of subscriberLevels.values()) {
    if (level === "debug") {
      return true;
    }
  }

  return false;
}

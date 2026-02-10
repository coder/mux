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

export function onLogEntry(listener: LogListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

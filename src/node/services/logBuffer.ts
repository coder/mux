import { MAX_LOG_ENTRIES } from "@/common/constants/ui";
import type { LogLevel } from "./log";

export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  message: string;
  location: string;
}

export type BufferEvent =
  | { type: "append"; epoch: number; entry: LogEntry }
  | { type: "reset"; epoch: number };

export interface LogFeedSnapshot {
  epoch: number;
  entries: LogEntry[];
}

const buffer: LogEntry[] = [];
let epoch = 0;

type LogListener = (event: BufferEvent) => void;
const listeners = new Set<LogListener>();
const subscriberLevels = new Map<LogListener, LogLevel>();

export function pushLogEntry(entry: LogEntry): void {
  buffer.push(entry);
  if (buffer.length > MAX_LOG_ENTRIES) {
    buffer.shift();
  }

  const appendEvent: BufferEvent = { type: "append", epoch, entry };
  for (const listener of listeners) {
    listener(appendEvent);
  }
}

export function getRecentLogs(): LogEntry[] {
  return [...buffer];
}

export function getEpoch(): number {
  return epoch;
}

export function subscribeLogFeed(
  listener: (event: BufferEvent) => void,
  requestedLevel?: LogLevel
): { snapshot: LogFeedSnapshot; unsubscribe: () => void } {
  listeners.add(listener);
  if (requestedLevel) {
    subscriberLevels.set(listener, requestedLevel);
  }

  return {
    snapshot: { epoch, entries: [...buffer] },
    unsubscribe: () => {
      listeners.delete(listener);
      subscriberLevels.delete(listener);
    },
  };
}

export function clearLogEntries(): void {
  buffer.length = 0;
  epoch += 1;

  const resetEvent: BufferEvent = { type: "reset", epoch };
  for (const listener of listeners) {
    listener(resetEvent);
  }
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

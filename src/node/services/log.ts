/**
 * Unified logging for mux (backend + CLI)
 *
 * Features:
 * - Log levels: error, warn, info, debug (hierarchical)
 * - EPIPE protection for piped output
 * - Caller file:line prefix for debugging
 * - Colored output in TTY
 *
 * Log level selection (in priority order):
 * 1. MUX_LOG_LEVEL env var (error|warn|info|debug)
 * 2. MUX_DEBUG=1 → debug level
 * 3. CLI mode (no Electron) → error level (quiet by default)
 * 4. Desktop mode → info level
 *
 * Use log.setLevel() to override programmatically (e.g., --verbose flag).
 */

import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import { parseBoolEnv } from "@/common/utils/env";
import { getMuxHome, getMuxLogsDir } from "@/common/constants/paths";
import { hasDebugSubscriber, pushLogEntry } from "./logBuffer";

process.once("exit", () => {
  closeLogFile();
});

// Lazy-initialized to avoid circular dependency with config.ts
let _debugObjDir: string | null = null;
function getDebugObjDir(): string {
  _debugObjDir ??= path.join(getMuxHome(), "debug_obj");
  return _debugObjDir;
}

/** Logging types */

export type LogFields = Record<string, unknown>;

export interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  debug_obj: (filename: string, obj: unknown) => void;
  setLevel: (level: LogLevel) => void;
  getLevel: () => LogLevel;
  isDebugMode: () => boolean;
  withFields: (fields: LogFields) => Logger;
}
export type LogLevel = "error" | "warn" | "info" | "debug";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

/**
 * Determine the default log level based on environment
 */
function getDefaultLogLevel(): LogLevel {
  // Explicit env var takes priority
  const envLevel = process.env.MUX_LOG_LEVEL?.toLowerCase();
  if (envLevel && envLevel in LOG_LEVEL_PRIORITY) {
    return envLevel as LogLevel;
  }

  // MUX_DEBUG=1 enables debug level
  if (parseBoolEnv(process.env.MUX_DEBUG)) {
    return "debug";
  }

  // CLI mode (no Electron) defaults to error (quiet)
  // Desktop mode defaults to info
  const isElectron = "electron" in process.versions;
  return isElectron ? "info" : "error";
}

let logFileStream: fs.WriteStream | null = null;
let logFilePath: string | null = null;
let logFileSize = 0;

const MAX_LOG_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_LOG_FILES = 3;

function stripAnsi(text: string): string {
  // Matches standard ANSI escape codes for colors/styles.
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function initLogFile(): void {
  if (logFileStream) {
    return;
  }

  try {
    const logsDir = getMuxLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });

    logFilePath = path.join(logsDir, "mux.log");

    try {
      logFileSize = fs.statSync(logFilePath).size;
    } catch {
      logFileSize = 0;
    }

    logFileStream = fs.createWriteStream(logFilePath, { flags: "a" });
  } catch {
    // Silent failure — never crash the app for logging.
  }
}

function rotateLogFile(): void {
  if (!logFilePath) {
    return;
  }

  try {
    logFileStream?.end();
    logFileStream = null;

    const logsDir = path.dirname(logFilePath);

    // Shift: mux.3.log → deleted, mux.2.log → mux.3.log, etc.
    for (let i = MAX_LOG_FILES; i >= 1; i--) {
      const from = path.join(logsDir, i === 1 ? "mux.log" : `mux.${i - 1}.log`);
      const to = path.join(logsDir, `mux.${i}.log`);
      try {
        fs.renameSync(from, to);
      } catch {
        // file may not exist
      }
    }

    logFileSize = 0;
    logFileStream = fs.createWriteStream(logFilePath, { flags: "a" });
  } catch {
    // Silent failure.
  }
}

function writeToFile(cleanLineWithNewline: string): void {
  initLogFile();
  if (!logFileStream) {
    return;
  }

  try {
    const bytes = Buffer.byteLength(cleanLineWithNewline, "utf-8");
    logFileStream.write(cleanLineWithNewline);
    logFileSize += bytes;

    if (logFileSize >= MAX_LOG_FILE_SIZE) {
      rotateLogFile();
    }
  } catch {
    // Silent failure.
  }
}

export function getLogFilePath(): string {
  return path.join(getMuxLogsDir(), "mux.log");
}

export function clearLogFiles(): void {
  const logsDir = getMuxLogsDir();
  const activeLogPath = path.join(logsDir, "mux.log");

  try {
    fs.mkdirSync(logsDir, { recursive: true });

    // Truncate (or create) the active log file while keeping the existing
    // stream usable. Future writes continue appending from a clean slate.
    const fd = fs.openSync(activeLogPath, "w");
    fs.closeSync(fd);

    // Remove rotated history files as part of a full delete action.
    for (let i = 1; i <= MAX_LOG_FILES; i++) {
      const rotatedPath = path.join(logsDir, `mux.${i}.log`);
      try {
        fs.unlinkSync(rotatedPath);
      } catch {
        // file may not exist
      }
    }

    logFilePath = activeLogPath;
    logFileSize = 0;
  } catch {
    // Silent failure.
  }
}

export function closeLogFile(): void {
  try {
    logFileStream?.end();
  } catch {
    // ignore
  } finally {
    logFileStream = null;
  }
}

let currentLogLevel: LogLevel = getDefaultLogLevel();

/**
 * Check if a message at the given level should be logged
 */
function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] <= LOG_LEVEL_PRIORITY[currentLogLevel];
}

/**
 * Check if debug mode is enabled (for backwards compatibility)
 */
function isDebugMode(): boolean {
  return currentLogLevel === "debug";
}

/**
 * Check if we're running in a TTY (terminal) that supports colors
 */
function supportsColor(): boolean {
  return process.stdout.isTTY ?? false;
}

// Chalk can be unexpectedly hoisted or partially mocked in certain test runners.
// Guard each style helper to avoid runtime TypeErrors (e.g., dim is not a function).
const chalkDim =
  typeof (chalk as { dim?: (text: string) => string }).dim === "function"
    ? (chalk as { dim: (text: string) => string }).dim
    : (text: string) => text;
const chalkCyan =
  typeof (chalk as { cyan?: (text: string) => string }).cyan === "function"
    ? (chalk as { cyan: (text: string) => string }).cyan
    : (text: string) => text;
const chalkGray =
  typeof (chalk as { gray?: (text: string) => string }).gray === "function"
    ? (chalk as { gray: (text: string) => string }).gray
    : (text: string) => text;
const chalkRed =
  typeof (chalk as { red?: (text: string) => string }).red === "function"
    ? (chalk as { red: (text: string) => string }).red
    : (text: string) => text;
const chalkYellow =
  typeof (chalk as { yellow?: (text: string) => string }).yellow === "function"
    ? (chalk as { yellow: (text: string) => string }).yellow
    : (text: string) => text;

/**
 * Get kitchen time timestamp for logs (12-hour format with milliseconds)
 * Format: 8:23.456PM (hours:minutes.milliseconds)
 */
function getTimestamp(): string {
  const now = new Date();
  let hours = now.getHours();
  const minutes = now.getMinutes();
  const milliseconds = now.getMilliseconds();

  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  hours = hours ? hours : 12; // Convert 0 to 12

  const mm = String(minutes).padStart(2, "0");
  const ms = String(milliseconds).padStart(3, "0"); // 3 digits: 000-999

  return `${hours}:${mm}.${ms}${ampm}`;
}

interface ParsedStackFrame {
  filePath: string;
  lineNum: string;
}

function parseStackFrame(stackLine: string): ParsedStackFrame | null {
  const match = /\((.+):(\d+):\d+\)$/.exec(stackLine) ?? /at (.+):(\d+):\d+$/.exec(stackLine);
  if (!match) {
    return null;
  }

  const [, filePath, lineNum] = match;
  return { filePath, lineNum };
}

function isLoggerStackFrame(stackLine: string, filePath: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, "/");

  if (
    normalizedPath.endsWith("/src/node/services/log.ts") ||
    normalizedPath.endsWith("/src/node/services/log.js")
  ) {
    return true;
  }

  return (
    stackLine.includes("getCallerLocation") ||
    stackLine.includes("safePipeLog") ||
    stackLine.includes("formatLogLine")
  );
}

function formatCallerLocation(filePath: string, lineNum: string): string {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const normalizedCwd = process.cwd().replace(/\\/g, "/");

  if (normalizedPath.startsWith(`${normalizedCwd}/`)) {
    return `${normalizedPath.slice(normalizedCwd.length + 1)}:${lineNum}`;
  }

  const srcIndex = normalizedPath.lastIndexOf("/src/");
  if (srcIndex >= 0) {
    return `${normalizedPath.slice(srcIndex + 1)}:${lineNum}`;
  }

  return `${path.basename(normalizedPath)}:${lineNum}`;
}

/**
 * Get the first non-logger caller frame from the stack trace.
 *
 * We intentionally scan frames instead of using a fixed stack index because
 * wrapper levels can shift over time and otherwise collapse locations to the
 * logger wrapper (e.g. log.ts:488) instead of the real call site.
 */
function getCallerLocation(): string {
  const stackLines = new Error().stack?.split("\n").slice(1) ?? [];

  for (const stackLine of stackLines) {
    const parsedFrame = parseStackFrame(stackLine);
    if (!parsedFrame) {
      continue;
    }

    if (parsedFrame.filePath.startsWith("node:")) {
      continue;
    }

    if (isLoggerStackFrame(stackLine, parsedFrame.filePath)) {
      continue;
    }

    return formatCallerLocation(parsedFrame.filePath, parsedFrame.lineNum);
  }

  return "unknown:0";
}

/**
 * Pipe-safe logging function with styled timestamp and caller location
 * Format: 8:23.456PM src/main.ts:23 <message>
 * @param level - Log level
 * @param args - Arguments to log
 */
function formatLogLine(level: LogLevel): {
  timestamp: string;
  location: string;
  useColor: boolean;
  prefix: string;
} {
  const timestamp = getTimestamp();
  const location = getCallerLocation();
  const useColor = supportsColor();

  // Apply colors based on level (if terminal supports it)
  let prefix: string;
  if (useColor) {
    const coloredTimestamp = chalkDim(timestamp);
    const coloredLocation = chalkCyan(location);

    if (level === "error") {
      prefix = `${coloredTimestamp} ${coloredLocation}`;
    } else if (level === "warn") {
      prefix = `${coloredTimestamp} ${coloredLocation}`;
    } else if (level === "debug") {
      prefix = `${coloredTimestamp} ${chalkGray(location)}`;
    } else {
      // info
      prefix = `${coloredTimestamp} ${coloredLocation}`;
    }
  } else {
    // No colors
    prefix = `${timestamp} ${location}`;
  }

  return { timestamp, location, useColor, prefix };
}

function safePipeLog(level: LogLevel, ...args: unknown[]): void {
  const shouldConsoleLog = shouldLog(level);

  const { timestamp, location, useColor, prefix } = formatLogLine(level);

  try {
    if (shouldConsoleLog) {
      if (level === "error") {
        // Color the entire error message red if supported
        if (useColor) {
          console.error(
            prefix,
            ...args.map((arg) => (typeof arg === "string" ? chalkRed(arg) : arg))
          );
        } else {
          console.error(prefix, ...args);
        }
      } else if (level === "warn") {
        // Color the entire warning message yellow if supported
        if (useColor) {
          console.error(
            prefix,
            ...args.map((arg) => (typeof arg === "string" ? chalkYellow(arg) : arg))
          );
        } else {
          console.error(prefix, ...args);
        }
      } else {
        // info and debug go to stdout
        console.log(prefix, ...args);
      }
    }
  } catch (error) {
    // Silently ignore EPIPE and other console errors
    const errorCode =
      error && typeof error === "object" && "code" in error ? error.code : undefined;
    const errorMessage =
      error && typeof error === "object" && "message" in error
        ? String(error.message)
        : "Unknown error";

    if (errorCode !== "EPIPE") {
      try {
        const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
        stream.write(`${timestamp} ${location} Console error: ${errorMessage}\n`);
      } catch {
        // Even the fallback might fail, just ignore
      }
    }
  }

  // Always persist error/warn/info to buffer+file.
  // Debug entries only persist when console level includes debug
  // or an Output tab subscriber has requested debug level.
  const shouldPersist = level !== "debug" || shouldConsoleLog || hasDebugSubscriber();
  if (!shouldPersist) {
    return;
  }

  // Build a best-effort, pre-formatted single-line message for file/buffer.
  // Note: console output behavior is intentionally unchanged.
  const message = args
    .map((arg) => {
      if (typeof arg === "string") {
        return arg;
      }
      if (arg instanceof Error) {
        return arg.stack ?? arg.message;
      }
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");

  const formattedLine = `${prefix} ${message}`;
  const cleanLine = stripAnsi(formattedLine);

  writeToFile(`${cleanLine}\n`);

  pushLogEntry({
    timestamp: Date.now(),
    level,
    // Send just the log message, not the pre-formatted line (timestamp+location
    // are already separate fields — no need to duplicate them in the message).
    message,
    location,
  });
}

/**
 * Dump an object to a JSON file in the debug_obj directory (only in debug mode)
 * @param filename - Name of the file (can include subdirectories like "workspace_id/file.json")
 * @param obj - Object to serialize and dump
 */
function debugObject(filename: string, obj: unknown): void {
  if (!isDebugMode()) {
    return;
  }

  try {
    // Ensure debug_obj directory exists
    const debugObjDir = getDebugObjDir();
    fs.mkdirSync(debugObjDir, { recursive: true });

    const filePath = path.join(debugObjDir, filename);
    const dirPath = path.dirname(filePath);

    // Ensure subdirectories exist
    fs.mkdirSync(dirPath, { recursive: true });

    // Write the object as pretty-printed JSON
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf-8");

    // Log that we dumped the object
    safePipeLog("debug", `Dumped object to ${filePath}`);
  } catch (error) {
    // Don't crash if we can't write debug files
    safePipeLog("error", `Failed to dump debug object to ${filename}:`, error);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return false;
  }
  if (value instanceof Error) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function normalizeFields(fields?: LogFields): LogFields | undefined {
  return fields && Object.keys(fields).length > 0 ? fields : undefined;
}

function mergeLogFields(base?: LogFields, extra?: LogFields): LogFields | undefined {
  return normalizeFields({ ...(base ?? {}), ...(extra ?? {}) });
}

const baseLogger = {
  debug_obj: debugObject,
  setLevel: (level: LogLevel): void => {
    currentLogLevel = level;
  },
  getLevel: (): LogLevel => currentLogLevel,
  isDebugMode,
};
function appendFieldsToArgs(args: unknown[], fields?: LogFields): unknown[] {
  if (!fields) {
    return args;
  }
  if (args.length === 0) {
    return [fields];
  }
  const lastArg = args[args.length - 1];
  if (isPlainObject(lastArg)) {
    return [...args.slice(0, -1), { ...fields, ...lastArg }];
  }
  return [...args, fields];
}

function createLogger(boundFields?: LogFields): Logger {
  const normalizedFields = normalizeFields(boundFields);
  const logAtLevel =
    (level: LogLevel) =>
    (...args: unknown[]): void => {
      safePipeLog(level, ...appendFieldsToArgs(args, normalizedFields));
    };

  return {
    ...baseLogger,
    info: logAtLevel("info"),
    warn: logAtLevel("warn"),
    error: logAtLevel("error"),
    debug: logAtLevel("debug"),
    withFields: (fields: LogFields): Logger =>
      createLogger(mergeLogFields(normalizedFields, fields)),
  };
}

/**
 * Unified logging interface for mux
 *
 * Log levels (hierarchical - each includes all levels above it):
 * - error: Critical failures only
 * - warn: Warnings + errors
 * - info: Informational + warnings + errors
 * - debug: Everything (verbose)
 *
 * Default levels:
 * - CLI mode: error (quiet by default)
 * - Desktop mode: info
 * - MUX_DEBUG=1: debug
 * - MUX_LOG_LEVEL=<level>: explicit override
 *
 * Use log.withFields({ workspaceId }) to create a sub-logger that
 * automatically includes fields in every log entry.
 */
export const log = createLogger();

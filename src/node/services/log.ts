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
import { getMuxHome } from "@/common/constants/paths";

// Lazy-initialized to avoid circular dependency with config.ts
let _debugObjDir: string | null = null;
function getDebugObjDir(): string {
  _debugObjDir ??= path.join(getMuxHome(), "debug_obj");
  return _debugObjDir;
}

/** Log levels in order of verbosity (lower = less verbose) */
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

/**
 * Get the caller's file path and line number from the stack trace
 * Returns format: "path/to/file.ts:123"
 */
function getCallerLocation(): string {
  const error = new Error();
  const stack = error.stack?.split("\n");

  // Stack trace format:
  // 0: "Error"
  // 1: "    at getCallerLocation (log.ts:X:Y)"
  // 2: "    at safePipeLog (log.ts:X:Y)"
  // 3: "    at log.info (log.ts:X:Y)"  or  "at log.error (log.ts:X:Y)"
  // 4: "    at <actual caller> (file.ts:X:Y)" <- We want this one

  if (stack && stack.length > 4) {
    const callerLine = stack[4];
    // Extract file path and line number from the stack trace
    // Format: "    at FunctionName (path/to/file.ts:123:45)"
    const match = /\((.+):(\d+):\d+\)/.exec(callerLine) ?? /at (.+):(\d+):\d+/.exec(callerLine);

    if (match) {
      const [, filePath, lineNum] = match;
      // Strip the full path to just show relative path from project root
      const relativePath = filePath.replace(/^.*\/mux\//, "");
      return `${relativePath}:${lineNum}`;
    }
  }

  return "unknown:0";
}

/**
 * Pipe-safe logging function with styled timestamp and caller location
 * Format: 8:23.456PM src/main.ts:23 <message>
 * @param level - Log level
 * @param args - Arguments to log
 */
function safePipeLog(level: LogLevel, ...args: unknown[]): void {
  // Check if this level should be logged
  if (!shouldLog(level)) {
    return;
  }

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

  try {
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
 */
export const log = {
  /**
   * Log an informational message to stdout (shown at info+ level)
   */
  info: (...args: unknown[]): void => {
    safePipeLog("info", ...args);
  },

  /**
   * Log a warning message to stderr (shown at warn+ level)
   */
  warn: (...args: unknown[]): void => {
    safePipeLog("warn", ...args);
  },

  /**
   * Log an error message to stderr (always shown)
   */
  error: (...args: unknown[]): void => {
    safePipeLog("error", ...args);
  },

  /**
   * Log a debug message to stdout (shown at debug level only)
   */
  debug: (...args: unknown[]): void => {
    safePipeLog("debug", ...args);
  },

  /**
   * Dump an object to a JSON file for debugging (only at debug level)
   * Files are written to ~/.mux/debug_obj/
   */
  debug_obj: debugObject,

  /**
   * Set the current log level programmatically
   * @example log.setLevel("info") // Enable verbose output
   */
  setLevel: (level: LogLevel): void => {
    currentLogLevel = level;
  },

  /**
   * Get the current log level
   */
  getLevel: (): LogLevel => currentLogLevel,

  /**
   * Check if debug mode is enabled (backwards compatibility)
   */
  isDebugMode,
};

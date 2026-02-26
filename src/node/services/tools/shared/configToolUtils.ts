import path from "node:path";
import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import type { ToolConfiguration } from "@/common/utils/tools/tools";

/**
 * Derive the mux home directory (~/.mux) from the workspace session directory.
 * workspaceSessionDir = <muxHome>/sessions/<workspaceId>
 */
export function getMuxHomeFromWorkspaceSessionDir(
  config: ToolConfiguration,
  toolName: string
): string {
  if (!config.workspaceSessionDir) {
    throw new Error(`${toolName} requires workspaceSessionDir`);
  }
  const sessionsDir = path.dirname(config.workspaceSessionDir);
  return path.dirname(sessionsDir);
}

/**
 * Guard that restricts a tool to the Chat with Mux system workspace.
 * Returns an error result if the workspace doesn't match, or null if allowed.
 */
export function requireMuxHelpWorkspace(
  config: ToolConfiguration,
  toolName: string
): { success: false; error: string } | null {
  if (config.workspaceId !== MUX_HELP_CHAT_WORKSPACE_ID) {
    return {
      success: false,
      error: `${toolName} is only available in the Chat with Mux system workspace`,
    };
  }
  return null;
}

/**
 * Parse a string as a non-negative integer array index.
 * Returns null if the string is not a valid non-negative integer.
 */
const ARRAY_INDEX_PATTERN = /^(0|[1-9]\d*)$/;
export function parseArrayIndex(segment: string): number | null {
  if (!ARRAY_INDEX_PATTERN.test(segment)) {
    return null;
  }
  return Number(segment);
}

/**
 * Type guard for plain objects (excludes arrays and null).
 */
export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Own-property membership check for config path traversal.
 * Ensures traversal never reaches inherited prototype members (e.g. constructor, toString).
 */
export function hasOwnRecordKey(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

/**
 * Deep clone a value using structuredClone with JSON fallback.
 */
export function deepClone<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

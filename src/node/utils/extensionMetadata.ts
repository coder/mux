import { getMuxExtensionMetadataPath } from "@/common/constants/paths";
import type { ThinkingLevel } from "@/common/types/thinking";

/**
 * Extension metadata for a single workspace.
 * Shared between main app (ExtensionMetadataService) and VS Code extension.
 */
export interface ExtensionAgentStatus {
  emoji: string;
  message: string;
  url?: string;
}

export interface ExtensionMetadata {
  recency: number;
  streaming: boolean;
  lastModel: string | null;
  lastThinkingLevel: ThinkingLevel | null;
  agentStatus: ExtensionAgentStatus | null;
  // Persists the latest status_set URL so later status_set calls without a URL
  // can still carry the last deep link even after agentStatus is cleared.
  lastStatusUrl?: string | null;
}

/**
 * File structure for extensionMetadata.json
 */
export interface ExtensionMetadataFile {
  version: 1;
  workspaces: Record<string, ExtensionMetadata>;
}

/**
 * Get the path to the extension metadata file.
 * @param rootDir - Optional root directory (defaults to getMuxHome())
 */
export function getExtensionMetadataPath(rootDir?: string): string {
  return getMuxExtensionMetadataPath(rootDir);
}

/**
 * Coerce an unknown value into a valid ExtensionAgentStatus, or null if invalid.
 * Shared between the sync reader (extensionMetadata.ts) and ExtensionMetadataService.
 */
export function coerceAgentStatus(value: unknown): ExtensionAgentStatus | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.emoji !== "string" || typeof record.message !== "string") {
    return null;
  }

  if (record.url !== undefined && typeof record.url !== "string") {
    return null;
  }

  return {
    emoji: record.emoji,
    message: record.message,
    ...(typeof record.url === "string" ? { url: record.url } : {}),
  };
}

/**
 * Coerce an unknown value into a string URL, or null if not a string.
 */
export function coerceStatusUrl(url: unknown): string | null {
  return typeof url === "string" ? url : null;
}

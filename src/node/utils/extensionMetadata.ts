import { readFileSync, existsSync } from "fs";

import { getMuxExtensionMetadataPath } from "@/common/constants/paths";
import { isThinkingLevel, type ThinkingLevel } from "@/common/types/thinking";
import { log } from "@/node/services/log";

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

/**
 * Read extension metadata from JSON file.
 * Returns a map of workspace ID to metadata.
 * Used by both the main app and VS Code extension (vscode/src/muxConfig.ts).
 */
export function readExtensionMetadata(): Map<string, ExtensionMetadata> {
  const metadataPath = getExtensionMetadataPath();

  if (!existsSync(metadataPath)) {
    return new Map();
  }

  try {
    const content = readFileSync(metadataPath, "utf-8");
    const data = JSON.parse(content) as ExtensionMetadataFile;

    // Validate structure
    if (typeof data !== "object" || data.version !== 1) {
      log.error("Invalid metadata file format");
      return new Map();
    }

    const map = new Map<string, ExtensionMetadata>();
    for (const [workspaceId, metadata] of Object.entries(data.workspaces || {})) {
      const rawThinkingLevel = (metadata as { lastThinkingLevel?: unknown }).lastThinkingLevel;
      const rawAgentStatus = (metadata as { agentStatus?: unknown }).agentStatus;
      const rawLastStatusUrl = (metadata as { lastStatusUrl?: unknown }).lastStatusUrl;
      map.set(workspaceId, {
        recency: metadata.recency,
        streaming: metadata.streaming,
        lastModel: metadata.lastModel ?? null,
        lastThinkingLevel: isThinkingLevel(rawThinkingLevel) ? rawThinkingLevel : null,
        agentStatus: coerceAgentStatus(rawAgentStatus),
        lastStatusUrl: coerceStatusUrl(rawLastStatusUrl),
      });
    }

    return map;
  } catch (error) {
    log.error("Failed to read metadata:", error);
    return new Map();
  }
}

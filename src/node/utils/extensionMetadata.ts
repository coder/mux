import { readFileSync, existsSync } from "fs";

import { getMuxExtensionMetadataPath } from "@/common/constants/paths";
import { isThinkingLevel, type ThinkingLevel } from "@/common/types/thinking";
import { log } from "@/node/services/log";

/**
 * Extension metadata for a single workspace.
 * Shared between main app (ExtensionMetadataService) and VS Code extension.
 */
export interface ExtensionMetadata {
  recency: number;
  streaming: boolean;
  lastModel: string | null;
  lastThinkingLevel: ThinkingLevel | null;
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
 * Read extension metadata from JSON file.
 * Returns a map of workspace ID to metadata.
 * Used by both the main app and VS Code extension.
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
      map.set(workspaceId, {
        recency: metadata.recency,
        streaming: metadata.streaming,
        lastModel: metadata.lastModel ?? null,
        lastThinkingLevel: isThinkingLevel(rawThinkingLevel) ? rawThinkingLevel : null,
      });
    }

    return map;
  } catch (error) {
    log.error("Failed to read metadata:", error);
    return new Map();
  }
}

import { dirname } from "path";
import { mkdir, readFile, access } from "fs/promises";
import { constants } from "fs";
import writeFileAtomic from "write-file-atomic";
import {
  type ExtensionMetadata,
  type ExtensionMetadataFile,
  getExtensionMetadataPath,
} from "@/node/utils/extensionMetadata";
import type { WorkspaceActivitySnapshot } from "@/common/types/workspace";
import { log } from "@/node/services/log";

/**
 * Stateless service for managing workspace metadata used by VS Code extension integration.
 *
 * This service tracks:
 * - recency: Unix timestamp (ms) of last user interaction
 * - streaming: Boolean indicating if workspace has an active stream
 * - lastModel: Last model used in this workspace
 * - lastThinkingLevel: Last thinking/reasoning level used in this workspace
 *
 * File location: ~/.mux/extensionMetadata.json
 *
 * Design:
 * - Stateless: reads from disk on every operation, no in-memory cache
 * - Atomic writes: uses write-file-atomic to prevent corruption
 * - Read-heavy workload: extension reads, main app writes on user interactions
 */

export interface ExtensionWorkspaceMetadata extends ExtensionMetadata {
  workspaceId: string;
  updatedAt: number;
}

export class ExtensionMetadataService {
  private readonly filePath: string;
  private toSnapshot(entry: ExtensionMetadata): WorkspaceActivitySnapshot {
    return {
      recency: entry.recency,
      streaming: entry.streaming,
      lastModel: entry.lastModel ?? null,
      lastThinkingLevel: entry.lastThinkingLevel ?? null,
    };
  }

  constructor(filePath?: string) {
    this.filePath = filePath ?? getExtensionMetadataPath();
  }

  /**
   * Initialize the service by ensuring directory exists and clearing stale streaming flags.
   * Call this once on app startup.
   */
  async initialize(): Promise<void> {
    // Ensure directory exists
    const dir = dirname(this.filePath);
    try {
      await access(dir, constants.F_OK);
    } catch {
      await mkdir(dir, { recursive: true });
    }

    // Clear stale streaming flags (from crashes)
    await this.clearStaleStreaming();
  }

  private async load(): Promise<ExtensionMetadataFile> {
    try {
      await access(this.filePath, constants.F_OK);
    } catch {
      return { version: 1, workspaces: {} };
    }

    try {
      const content = await readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as ExtensionMetadataFile;

      // Validate structure
      if (typeof parsed !== "object" || parsed.version !== 1) {
        log.error("Invalid metadata file, resetting");
        return { version: 1, workspaces: {} };
      }

      return parsed;
    } catch (error) {
      log.error("Failed to load metadata:", error);
      return { version: 1, workspaces: {} };
    }
  }

  private async save(data: ExtensionMetadataFile): Promise<void> {
    try {
      const content = JSON.stringify(data, null, 2);
      await writeFileAtomic(this.filePath, content, "utf-8");
    } catch (error) {
      log.error("Failed to save metadata:", error);
    }
  }

  /**
   * Update the recency timestamp for a workspace.
   * Call this on user messages or other interactions.
   */
  async updateRecency(
    workspaceId: string,
    timestamp: number = Date.now()
  ): Promise<WorkspaceActivitySnapshot> {
    const data = await this.load();

    if (!data.workspaces[workspaceId]) {
      data.workspaces[workspaceId] = {
        recency: timestamp,
        streaming: false,
        lastModel: null,
        lastThinkingLevel: null,
      };
    } else {
      data.workspaces[workspaceId].recency = timestamp;
    }

    await this.save(data);
    const workspace = data.workspaces[workspaceId];
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} metadata missing after update.`);
    }
    return this.toSnapshot(workspace);
  }

  /**
   * Set the streaming status for a workspace.
   * Call this when streams start/end.
   */
  async setStreaming(
    workspaceId: string,
    streaming: boolean,
    model?: string,
    thinkingLevel?: ExtensionMetadata["lastThinkingLevel"]
  ): Promise<WorkspaceActivitySnapshot> {
    const data = await this.load();
    const now = Date.now();

    if (!data.workspaces[workspaceId]) {
      data.workspaces[workspaceId] = {
        recency: now,
        streaming,
        lastModel: model ?? null,
        lastThinkingLevel: thinkingLevel ?? null,
      };
    } else {
      data.workspaces[workspaceId].streaming = streaming;
      if (model) {
        data.workspaces[workspaceId].lastModel = model;
      }
      if (thinkingLevel !== undefined) {
        data.workspaces[workspaceId].lastThinkingLevel = thinkingLevel;
      }
    }

    await this.save(data);
    const workspace = data.workspaces[workspaceId];
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} metadata missing after streaming update.`);
    }
    return this.toSnapshot(workspace);
  }

  /**
   * Get metadata for a single workspace.
   */
  async getMetadata(workspaceId: string): Promise<ExtensionWorkspaceMetadata | null> {
    const data = await this.load();
    const entry = data.workspaces[workspaceId];
    if (!entry) return null;

    return {
      workspaceId,
      updatedAt: entry.recency, // Use recency as updatedAt for backwards compatibility
      ...entry,
    };
  }

  /**
   * Get all workspace metadata, ordered by recency.
   * Used by VS Code extension to sort workspace list.
   */
  async getAllMetadata(): Promise<Map<string, ExtensionWorkspaceMetadata>> {
    const data = await this.load();
    const map = new Map<string, ExtensionWorkspaceMetadata>();

    // Convert to array, sort by recency, then create map
    const entries = Object.entries(data.workspaces);
    entries.sort((a, b) => b[1].recency - a[1].recency);

    for (const [workspaceId, entry] of entries) {
      map.set(workspaceId, {
        workspaceId,
        updatedAt: entry.recency, // Use recency as updatedAt for backwards compatibility
        ...entry,
      });
    }

    return map;
  }

  /**
   * Delete metadata for a workspace.
   * Call this when a workspace is deleted.
   */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    const data = await this.load();

    if (data.workspaces[workspaceId]) {
      delete data.workspaces[workspaceId];
      await this.save(data);
    }
  }

  /**
   * Clear all streaming flags.
   * Call this on app startup to clean up stale streaming states from crashes.
   */
  async clearStaleStreaming(): Promise<void> {
    const data = await this.load();
    let modified = false;

    for (const entry of Object.values(data.workspaces)) {
      if (entry.streaming) {
        entry.streaming = false;
        modified = true;
      }
    }

    if (modified) {
      await this.save(data);
    }
  }

  async getAllSnapshots(): Promise<Map<string, WorkspaceActivitySnapshot>> {
    const data = await this.load();
    const map = new Map<string, WorkspaceActivitySnapshot>();
    for (const [workspaceId, entry] of Object.entries(data.workspaces)) {
      map.set(workspaceId, this.toSnapshot(entry));
    }
    return map;
  }
}

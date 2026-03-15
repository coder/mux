import { dirname } from "path";
import { mkdir, readFile, access } from "fs/promises";
import { constants } from "fs";
import writeFileAtomic from "write-file-atomic";
import {
  coerceAgentStatus,
  coerceExtensionMetadata,
  coerceStatusUrl,
  toWorkspaceActivitySnapshot,
  type ExtensionAgentStatus,
  type ExtensionMetadata,
  type ExtensionMetadataFile,
} from "@/node/utils/extensionMetadata";
import { getMuxExtensionMetadataPath } from "@/common/constants/paths";
import type { WorkspaceActivitySnapshot } from "@/common/types/workspace";
import { log } from "@/node/services/log";

/**
 * Stateless service for managing workspace metadata used by VS Code extension integration.
 *
 * This service tracks:
 * - recency: Unix timestamp (ms) of last user interaction
 * - streaming: Boolean indicating if workspace has an active stream
 * - streamingGeneration: Monotonic stream counter used to detect newer background turns
 * - lastModel: Last model used in this workspace
 * - lastThinkingLevel: Last thinking/reasoning level used in this workspace
 * - agentStatus: Most recent status_set payload (for sidebar progress in background workspaces)
 * - hasTodos: Whether the workspace still had todos when streaming last stopped
 *
 * File location: ~/.mux/extensionMetadata.json
 *
 * Design:
 * - Stateless: reads from disk on every operation, no in-memory cache
 * - Atomic writes: uses write-file-atomic to prevent corruption
 * - Read-heavy workload: extension reads, main app writes on user interactions
 */

export interface ExtensionMetadataStreamingUpdate {
  model?: string;
  thinkingLevel?: ExtensionMetadata["lastThinkingLevel"];
  hasTodos?: boolean;
  generation?: number;
}

export class ExtensionMetadataService {
  private readonly filePath: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  /**
   * Serialize all mutating operations on the shared metadata file.
   * Prevents cross-workspace read-modify-write races since all workspaces
   * share a single extensionMetadata.json file.
   */
  private async withSerializedMutation<T>(fn: () => Promise<T>): Promise<T> {
    let result!: T;
    const run = async () => {
      result = await fn();
    };
    const next = this.mutationQueue.catch(() => undefined).then(run);
    this.mutationQueue = next;
    await next;
    return result;
  }

  private getOrCreateWorkspaceEntry(
    data: ExtensionMetadataFile,
    workspaceId: string,
    recency: number
  ): ExtensionMetadata {
    const normalized = coerceExtensionMetadata(data.workspaces[workspaceId]);
    if (normalized) {
      data.workspaces[workspaceId] = normalized;
      return normalized;
    }

    // Self-heal malformed persisted workspace entries instead of crashing future metadata writes.
    const created: ExtensionMetadata = {
      recency,
      streaming: false,
      lastModel: null,
      lastThinkingLevel: null,
      agentStatus: null,
      lastStatusUrl: null,
    };
    data.workspaces[workspaceId] = created;
    return created;
  }

  private toSnapshot(entry: unknown): WorkspaceActivitySnapshot | null {
    const normalized = coerceExtensionMetadata(entry);
    return normalized ? toWorkspaceActivitySnapshot(normalized) : null;
  }

  private async mutateWorkspaceSnapshot(
    workspaceId: string,
    recency: number,
    mutate: (workspace: ExtensionMetadata) => void
  ): Promise<WorkspaceActivitySnapshot> {
    return this.withSerializedMutation(async () => {
      const data = await this.load();
      const workspace = this.getOrCreateWorkspaceEntry(data, workspaceId, recency);
      mutate(workspace);
      await this.save(data);
      return toWorkspaceActivitySnapshot(workspace);
    });
  }

  constructor(filePath?: string) {
    this.filePath = filePath ?? getMuxExtensionMetadataPath();
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
    return this.mutateWorkspaceSnapshot(workspaceId, timestamp, (workspace) => {
      workspace.recency = timestamp;
    });
  }

  /**
   * Set the streaming status for a workspace.
   * Call this when streams start/end.
   */
  async setStreaming(
    workspaceId: string,
    streaming: boolean,
    update: ExtensionMetadataStreamingUpdate = {}
  ): Promise<WorkspaceActivitySnapshot> {
    return this.mutateWorkspaceSnapshot(workspaceId, Date.now(), (workspace) => {
      workspace.streaming = streaming;
      if (update.generation !== undefined) {
        workspace.streamingGeneration = update.generation;
      }
      if (update.model) {
        workspace.lastModel = update.model;
      }
      if (update.thinkingLevel !== undefined) {
        workspace.lastThinkingLevel = update.thinkingLevel;
      }
      if (update.hasTodos !== undefined) {
        workspace.hasTodos = update.hasTodos;
      }
    });
  }

  /**
   * Update the latest status_set payload for a workspace.
   */
  async setAgentStatus(
    workspaceId: string,
    agentStatus: ExtensionAgentStatus | null
  ): Promise<WorkspaceActivitySnapshot> {
    return this.mutateWorkspaceSnapshot(workspaceId, Date.now(), (workspace) => {
      const previousUrl =
        coerceAgentStatus(workspace.agentStatus)?.url ??
        coerceStatusUrl(workspace.lastStatusUrl) ??
        null;

      if (agentStatus) {
        const carriedUrl = agentStatus.url ?? previousUrl ?? undefined;
        workspace.agentStatus =
          carriedUrl !== undefined
            ? {
                ...agentStatus,
                url: carriedUrl,
              }
            : agentStatus;
        workspace.lastStatusUrl = carriedUrl ?? null;
      } else {
        workspace.agentStatus = null;
        // Keep lastStatusUrl across clears so the next status_set without `url`
        // can still reuse the previous deep link.
        workspace.lastStatusUrl = previousUrl;
      }
    });
  }

  async getSnapshot(workspaceId: string): Promise<WorkspaceActivitySnapshot | null> {
    const data = await this.load();
    return this.toSnapshot(data.workspaces[workspaceId]);
  }

  /**
   * Delete metadata for a workspace.
   * Call this when a workspace is deleted.
   */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.withSerializedMutation(async () => {
      const data = await this.load();

      if (data.workspaces[workspaceId]) {
        delete data.workspaces[workspaceId];
        await this.save(data);
      }
    });
  }

  /**
   * Clear all streaming flags.
   * Call this on app startup to clean up stale streaming states from crashes.
   */
  async clearStaleStreaming(): Promise<void> {
    await this.withSerializedMutation(async () => {
      const data = await this.load();
      let modified = false;

      for (const [workspaceId, entry] of Object.entries(data.workspaces)) {
        const normalized = coerceExtensionMetadata(entry);
        if (!normalized?.streaming) {
          continue;
        }

        normalized.streaming = false;
        data.workspaces[workspaceId] = normalized;
        modified = true;
      }

      if (modified) {
        await this.save(data);
      }
    });
  }

  async getAllSnapshots(): Promise<Map<string, WorkspaceActivitySnapshot>> {
    const data = await this.load();
    const map = new Map<string, WorkspaceActivitySnapshot>();
    for (const [workspaceId, entry] of Object.entries(data.workspaces)) {
      const snapshot = this.toSnapshot(entry);
      if (snapshot) {
        map.set(workspaceId, snapshot);
      }
    }
    return map;
  }
}

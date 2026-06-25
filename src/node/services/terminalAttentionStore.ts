import type { Dirent } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { z } from "zod";

import assert from "@/common/utils/assert";
import type { Config } from "@/node/config";
import { log } from "@/node/services/log";
import { isErrnoWithCode } from "@/node/utils/fs";

/**
 * Persisted, idempotent record of a pending terminal wake-up the owner workspace still owes an
 * agent. The notifier (see {@link TerminalAttentionNotifier}) drains these when the owner is idle
 * and marks them delivered only after an accepted send, so a crash/restart cannot lose or duplicate
 * a wake-up.
 *
 * Output delivery:
 * - `already_injected`: a sub-agent report/failure synthetic message is already in parent history,
 *   so the wake-up tells the agent to integrate it WITHOUT calling task_await.
 * - `requires_task_await`: a workspace-turn handle's terminal output lives in the handle store, so
 *   the wake-up tells the agent to call task_await with the terminal IDs and timeout_secs: 0.
 */
export const TERMINAL_ATTENTION_DIR = "terminal-attention";

export type TerminalAttentionOutputDelivery = "already_injected" | "requires_task_await";

export type TerminalAttentionSourceKind = "agent_task" | "workspace_turn";

export type TerminalAttentionOutcome = "completed" | "failed" | "interrupted" | "error";

export interface TerminalAttentionNotification {
  id: string;
  ownerWorkspaceId: string;
  sourceKind: TerminalAttentionSourceKind;
  sourceId: string;
  outputDelivery: TerminalAttentionOutputDelivery;
  terminalOutcome: TerminalAttentionOutcome;
  status: "pending" | "delivered" | "superseded";
  title?: string;
  createdAt: string;
  deliveredAt?: string;
}

const TerminalAttentionNotificationSchema = z
  .object({
    id: z.string().min(1),
    ownerWorkspaceId: z.string().min(1),
    sourceKind: z.enum(["agent_task", "workspace_turn"]),
    sourceId: z.string().min(1),
    outputDelivery: z.enum(["already_injected", "requires_task_await"]),
    terminalOutcome: z.enum(["completed", "failed", "interrupted", "error"]),
    status: z.enum(["pending", "delivered", "superseded"]),
    title: z.string().optional(),
    createdAt: z.string().min(1),
    deliveredAt: z.string().optional(),
  })
  .strict();

/**
 * Disk-backed store for terminal attention notifications, one JSON file per notification under the
 * owner workspace session dir. Pure local I/O with a single dependency (getSessionDir); self-heals
 * by skipping malformed files at read time.
 */
export class TerminalAttentionStore {
  constructor(private readonly config: Pick<Config, "getSessionDir" | "sessionsDir">) {}

  private dir(ownerWorkspaceId: string): string {
    assert(ownerWorkspaceId.trim().length > 0, "TerminalAttentionStore requires ownerWorkspaceId");
    return path.join(this.config.getSessionDir(ownerWorkspaceId), TERMINAL_ATTENTION_DIR);
  }

  /** Stable id keyed by source so re-enqueuing the same terminal source is idempotent. */
  static notificationId(sourceKind: TerminalAttentionSourceKind, sourceId: string): string {
    return `${sourceKind}:${sourceId}`;
  }

  private file(ownerWorkspaceId: string, id: string): string {
    return path.join(this.dir(ownerWorkspaceId), `${encodeURIComponent(id)}.json`);
  }

  /**
   * Insert a pending notification if none exists yet for this source. Idempotent: an existing
   * record (pending/delivered/superseded) is left untouched so we never resurrect a delivered
   * wake-up or duplicate a pending one.
   */
  async enqueueIfAbsent(
    notification: Omit<TerminalAttentionNotification, "id" | "status" | "createdAt"> & {
      createdAt?: string;
    }
  ): Promise<TerminalAttentionNotification | null> {
    const id = TerminalAttentionStore.notificationId(
      notification.sourceKind,
      notification.sourceId
    );
    const existing = await this.get(notification.ownerWorkspaceId, id);
    if (existing != null) {
      return null;
    }
    const record: TerminalAttentionNotification = {
      id,
      ownerWorkspaceId: notification.ownerWorkspaceId,
      sourceKind: notification.sourceKind,
      sourceId: notification.sourceId,
      outputDelivery: notification.outputDelivery,
      terminalOutcome: notification.terminalOutcome,
      status: "pending",
      ...(notification.title != null ? { title: notification.title } : {}),
      createdAt: notification.createdAt ?? new Date().toISOString(),
    };
    await this.write(record);
    return record;
  }

  async get(ownerWorkspaceId: string, id: string): Promise<TerminalAttentionNotification | null> {
    let raw: string;
    try {
      raw = await fsPromises.readFile(this.file(ownerWorkspaceId, id), "utf-8");
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return null;
      throw error;
    }
    return this.parse(raw);
  }

  async listPending(ownerWorkspaceId: string): Promise<TerminalAttentionNotification[]> {
    const dir = this.dir(ownerWorkspaceId);
    let entries: string[];
    try {
      entries = await fsPromises.readdir(dir);
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return [];
      throw error;
    }
    const records: TerminalAttentionNotification[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const raw = await fsPromises.readFile(path.join(dir, entry), "utf-8").catch(() => null);
      if (raw == null) continue;
      const parsed = this.parse(raw);
      if (parsed?.status === "pending") {
        records.push(parsed);
      }
    }
    // Stable order for deterministic coalescing.
    records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return records;
  }

  async listPendingOwnerWorkspaceIds(): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await fsPromises.readdir(this.config.sessionsDir, { withFileTypes: true });
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return [];
      throw error;
    }

    const ownerWorkspaceIds: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if ((await this.listPending(entry.name)).length > 0) {
        ownerWorkspaceIds.push(entry.name);
      }
    }
    ownerWorkspaceIds.sort();
    return ownerWorkspaceIds;
  }

  async markPending(ownerWorkspaceId: string, id: string): Promise<void> {
    const record = await this.get(ownerWorkspaceId, id);
    if (record?.status !== "delivered") {
      return;
    }
    const { deliveredAt: _deliveredAt, ...pendingRecord } = record;
    await this.write({ ...pendingRecord, status: "pending" });
  }

  async markDelivered(ownerWorkspaceId: string, id: string): Promise<void> {
    await this.transition(ownerWorkspaceId, id, "delivered");
  }

  async markSuperseded(ownerWorkspaceId: string, id: string): Promise<void> {
    await this.transition(ownerWorkspaceId, id, "superseded");
  }

  private async transition(
    ownerWorkspaceId: string,
    id: string,
    status: "delivered" | "superseded"
  ): Promise<void> {
    const record = await this.get(ownerWorkspaceId, id);
    if (record?.status !== "pending") {
      return;
    }
    await this.write({
      ...record,
      status,
      ...(status === "delivered" ? { deliveredAt: new Date().toISOString() } : {}),
    });
  }

  private async write(record: TerminalAttentionNotification): Promise<void> {
    const dir = this.dir(record.ownerWorkspaceId);
    await fsPromises.mkdir(dir, { recursive: true });
    await fsPromises.writeFile(
      this.file(record.ownerWorkspaceId, record.id),
      JSON.stringify(record, null, 2),
      "utf-8"
    );
  }

  private parse(raw: string): TerminalAttentionNotification | null {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return null;
    }
    const parsed = TerminalAttentionNotificationSchema.safeParse(json);
    if (!parsed.success) {
      log.debug("Skipping malformed terminal attention notification", { error: parsed.error });
      return null;
    }
    return parsed.data;
  }
}

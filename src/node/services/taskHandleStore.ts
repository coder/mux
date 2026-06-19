import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { z } from "zod";

import type { Config } from "@/node/config";
import type { CompletedMessagePart, StreamEndEvent } from "@/common/types/stream";
import type { ParsedThinkingInput, ThinkingLevel } from "@/common/types/thinking";
import {
  WorkspaceTurnFinalMessageRefSchema,
  type WorkspaceTurnFinalMessageRef,
} from "@/common/types/workspaceTurn";
import { log } from "@/node/services/log";
import { isErrnoWithCode } from "@/node/utils/fs";

export type { WorkspaceTurnFinalMessageRef };

export const WORKSPACE_TURN_TASK_ID_PREFIX = "wst_";
const TASK_HANDLES_DIR = "task-handles";

export type WorkspaceTurnTaskStatus =
  | "queued"
  | "starting"
  | "running"
  | "completed"
  | "interrupted"
  | "error";

export interface WorkspaceTurnTaskHandleRecord {
  kind: "workspace_turn";
  handleId: string;
  ownerWorkspaceId: string;
  workspaceId: string;
  turnId: string;
  status: WorkspaceTurnTaskStatus;
  createdAt: string;
  updatedAt: string;
  createdWorkspace: boolean;
  disposableWorkspace: boolean;
  title?: string;
  prompt?: string;
  modelString?: string;
  thinkingLevel?: ParsedThinkingInput | ThinkingLevel;
  messageId?: string;
  reportMarkdown?: string;
  finalMessageRef?: WorkspaceTurnFinalMessageRef;
  finalMessage?: {
    messageId: string;
    parts?: CompletedMessagePart[];
    metadata: StreamEndEvent["metadata"];
  };
  error?: string;
}

const WorkspaceTurnTaskHandleRecordSchema = z
  .object({
    kind: z.literal("workspace_turn"),
    handleId: z.string().min(1),
    ownerWorkspaceId: z.string().min(1),
    workspaceId: z.string().min(1),
    turnId: z.string().min(1),
    status: z.enum(["queued", "starting", "running", "completed", "interrupted", "error"]),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    createdWorkspace: z.boolean(),
    disposableWorkspace: z.boolean(),
    title: z.string().optional(),
    prompt: z.string().optional(),
    modelString: z.string().optional(),
    thinkingLevel: z.unknown().optional(),
    messageId: z.string().optional(),
    reportMarkdown: z.string().optional(),
    finalMessageRef: WorkspaceTurnFinalMessageRefSchema.optional(),
    finalMessage: z
      .object({
        messageId: z.string().min(1),
        parts: z.array(z.unknown()).optional(),
        metadata: z.unknown(),
      })
      .passthrough()
      .optional(),
    error: z.string().optional(),
  })
  .strict();

export function isWorkspaceTurnTaskId(
  value: unknown
): value is `${typeof WORKSPACE_TURN_TASK_ID_PREFIX}${string}` {
  return typeof value === "string" && value.startsWith(WORKSPACE_TURN_TASK_ID_PREFIX);
}

export class TaskHandleStore {
  constructor(private readonly config: Config) {}

  async upsertWorkspaceTurn(record: WorkspaceTurnTaskHandleRecord): Promise<void> {
    this.assertValidRecord(record);
    const dir = this.getOwnerHandleDir(record.ownerWorkspaceId);
    await fsPromises.mkdir(dir, { recursive: true });
    await fsPromises.writeFile(
      this.getHandlePath(record.ownerWorkspaceId, record.handleId),
      JSON.stringify(record, null, 2)
    );
  }

  async updateWorkspaceTurn(
    ownerWorkspaceId: string,
    handleId: string,
    mutator: (record: WorkspaceTurnTaskHandleRecord) => WorkspaceTurnTaskHandleRecord
  ): Promise<WorkspaceTurnTaskHandleRecord | null> {
    assert(ownerWorkspaceId.trim().length > 0, "updateWorkspaceTurn requires ownerWorkspaceId");
    assert(handleId.trim().length > 0, "updateWorkspaceTurn requires handleId");
    const current = await this.getWorkspaceTurn(ownerWorkspaceId, handleId);
    if (current == null) {
      return null;
    }
    const next = mutator(current);
    await this.upsertWorkspaceTurn(next);
    return next;
  }

  async getWorkspaceTurn(
    ownerWorkspaceId: string,
    handleId: string
  ): Promise<WorkspaceTurnTaskHandleRecord | null> {
    assert(ownerWorkspaceId.trim().length > 0, "getWorkspaceTurn requires ownerWorkspaceId");
    assert(handleId.trim().length > 0, "getWorkspaceTurn requires handleId");
    const record = await this.readWorkspaceTurnFile(ownerWorkspaceId, handleId);
    return record?.ownerWorkspaceId === ownerWorkspaceId ? record : null;
  }

  async listWorkspaceTurns(
    ownerWorkspaceId: string,
    options: { statuses?: readonly WorkspaceTurnTaskStatus[] } = {}
  ): Promise<WorkspaceTurnTaskHandleRecord[]> {
    assert(ownerWorkspaceId.trim().length > 0, "listWorkspaceTurns requires ownerWorkspaceId");
    const dir = this.getOwnerHandleDir(ownerWorkspaceId);
    let entries: string[];
    try {
      entries = await fsPromises.readdir(dir);
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return [];
      throw error;
    }

    const statuses = options.statuses != null ? new Set(options.statuses) : null;
    const records = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) =>
          this.readWorkspaceTurnFile(ownerWorkspaceId, entry.slice(0, -".json".length))
        )
    );
    return records
      .filter((record): record is WorkspaceTurnTaskHandleRecord => {
        if (record == null) return false;
        return statuses == null || statuses.has(record.status);
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listAllWorkspaceTurns(
    options: { statuses?: readonly WorkspaceTurnTaskStatus[] } = {}
  ): Promise<WorkspaceTurnTaskHandleRecord[]> {
    let entries: Array<{ isDirectory: () => boolean; name: string }>;
    try {
      entries = await fsPromises.readdir(this.config.sessionsDir, { withFileTypes: true });
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return [];
      throw error;
    }

    const recordsByOwner = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.listWorkspaceTurns(entry.name, options))
    );
    return recordsByOwner.flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async isWorkspaceOwnedBy(ownerWorkspaceId: string, workspaceId: string): Promise<boolean> {
    assert(ownerWorkspaceId.trim().length > 0, "isWorkspaceOwnedBy requires ownerWorkspaceId");
    assert(workspaceId.trim().length > 0, "isWorkspaceOwnedBy requires workspaceId");
    const records = await this.listWorkspaceTurns(ownerWorkspaceId);
    return records.some((record) => record.createdWorkspace && record.workspaceId === workspaceId);
  }

  private getOwnerHandleDir(ownerWorkspaceId: string): string {
    assert(ownerWorkspaceId.trim().length > 0, "ownerWorkspaceId must be non-empty");
    return path.join(this.config.getSessionDir(ownerWorkspaceId), TASK_HANDLES_DIR);
  }

  private getHandlePath(ownerWorkspaceId: string, handleId: string): string {
    assert(handleId.trim().length > 0, "handleId must be non-empty");
    return path.join(this.getOwnerHandleDir(ownerWorkspaceId), `${handleId}.json`);
  }

  private assertValidRecord(record: WorkspaceTurnTaskHandleRecord): void {
    const parsed = WorkspaceTurnTaskHandleRecordSchema.safeParse(record);
    assert(
      parsed.success,
      `Invalid workspace turn handle record: ${parsed.success ? "" : parsed.error.message}`
    );
    assert(
      record.handleId.startsWith(WORKSPACE_TURN_TASK_ID_PREFIX),
      "workspace turn handle IDs must use the wst_ prefix"
    );
  }

  private async readWorkspaceTurnFile(
    ownerWorkspaceId: string,
    handleId: string
  ): Promise<WorkspaceTurnTaskHandleRecord | null> {
    try {
      const raw = await fsPromises.readFile(
        this.getHandlePath(ownerWorkspaceId, handleId),
        "utf-8"
      );
      const parsedJson = JSON.parse(raw) as unknown;
      const parsed = WorkspaceTurnTaskHandleRecordSchema.safeParse(parsedJson);
      if (!parsed.success) {
        log.warn("Ignoring unreadable workspace turn task handle", {
          ownerWorkspaceId,
          handleId,
          issues: parsed.error.issues,
        });
        return null;
      }
      return parsed.data as WorkspaceTurnTaskHandleRecord;
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT") || error instanceof SyntaxError) {
        if (error instanceof SyntaxError) {
          log.warn("Ignoring corrupt workspace turn task handle", { ownerWorkspaceId, handleId });
        }
        return null;
      }
      throw error;
    }
  }
}

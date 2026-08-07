import * as path from "node:path";
import * as fsPromises from "node:fs/promises";

import writeFileAtomic from "write-file-atomic";

import assert from "@/common/utils/assert";
import {
  ExecutionHandleSchema,
  isExecutionId,
  type ExecutionHandle,
  type ExecutionStatus,
} from "@/common/types/execution";
import type { Config } from "@/node/config";
import { log } from "@/node/services/log";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { isErrnoWithCode } from "@/node/utils/fs";

export const EXECUTIONS_DIR = "executions";

function isSafePathComponent(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.trim() &&
    value !== "." &&
    value !== ".." &&
    !path.isAbsolute(value) &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

/** Owner-session-scoped persistence for canonical execution handles. */
export class ExecutionStore {
  private readonly locks = new MutexMap<string>();

  constructor(private readonly config: Pick<Config, "getSessionDir">) {}

  async upsert(handle: ExecutionHandle): Promise<void> {
    const parsed = ExecutionHandleSchema.safeParse(handle);
    assert(
      parsed.success,
      `Invalid execution handle: ${parsed.success ? "" : parsed.error.message}`
    );
    this.assertSafeOwnerSessionId(handle.ownerSessionId);
    assert(isExecutionId(handle.executionId), "ExecutionStore requires a valid execution ID");

    const key = `${handle.ownerSessionId}:${handle.executionId}`;
    await this.locks.withLock(key, async () => {
      const dir = this.dir(handle.ownerSessionId);
      await fsPromises.mkdir(dir, { recursive: true });
      await writeFileAtomic(
        this.file(handle.ownerSessionId, handle.executionId),
        JSON.stringify(parsed.data, null, 2)
      );
    });
  }

  async get(ownerSessionId: string, executionId: string): Promise<ExecutionHandle | null> {
    this.assertSafeOwnerSessionId(ownerSessionId);
    if (!isExecutionId(executionId)) return null;
    return this.read(ownerSessionId, executionId);
  }

  async list(
    ownerSessionId: string,
    options: { statuses?: readonly ExecutionStatus[] } = {}
  ): Promise<ExecutionHandle[]> {
    this.assertSafeOwnerSessionId(ownerSessionId);
    const dir = this.dir(ownerSessionId);
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
        .map((entry) => entry.slice(0, -".json".length))
        .filter(isExecutionId)
        .map((executionId) => this.read(ownerSessionId, executionId))
    );
    return records
      .filter((record): record is ExecutionHandle => {
        return record != null && (statuses == null || statuses.has(record.status));
      })
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.executionId.localeCompare(b.executionId)
      );
  }

  async delete(ownerSessionId: string, executionId: string): Promise<void> {
    this.assertSafeOwnerSessionId(ownerSessionId);
    assert(isExecutionId(executionId), "ExecutionStore requires a valid execution ID");
    const key = `${ownerSessionId}:${executionId}`;
    await this.locks.withLock(key, async () => {
      await fsPromises.rm(this.file(ownerSessionId, executionId), { force: true });
    });
  }

  private dir(ownerSessionId: string): string {
    this.assertSafeOwnerSessionId(ownerSessionId);
    return path.join(this.config.getSessionDir(ownerSessionId), EXECUTIONS_DIR);
  }

  private file(ownerSessionId: string, executionId: string): string {
    assert(isExecutionId(executionId), "ExecutionStore requires a valid execution ID");
    return path.join(this.dir(ownerSessionId), `${executionId}.json`);
  }

  private assertSafeOwnerSessionId(ownerSessionId: string): void {
    assert(
      isSafePathComponent(ownerSessionId),
      "ExecutionStore ownerSessionId must be a safe path component"
    );
  }

  private async read(ownerSessionId: string, executionId: string): Promise<ExecutionHandle | null> {
    let raw: string;
    try {
      raw = await fsPromises.readFile(this.file(ownerSessionId, executionId), "utf-8");
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return null;
      throw error;
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      log.warn("Ignoring corrupt execution record", { ownerSessionId, executionId });
      return null;
    }
    const parsed = ExecutionHandleSchema.safeParse(json);
    if (!parsed.success) {
      log.warn("Ignoring malformed execution record", {
        ownerSessionId,
        executionId,
        issues: parsed.error.issues,
      });
      return null;
    }
    if (parsed.data.ownerSessionId !== ownerSessionId || parsed.data.executionId !== executionId) {
      log.warn("Ignoring mismatched execution record", {
        ownerSessionId,
        executionId,
        recordOwnerSessionId: parsed.data.ownerSessionId,
        recordExecutionId: parsed.data.executionId,
      });
      return null;
    }
    return parsed.data;
  }
}

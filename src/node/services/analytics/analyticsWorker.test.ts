import { describe, expect, mock, test } from "bun:test";

import type { SyncAction } from "./backfillDecision";

void mock.module("@duckdb/node-api", () => ({
  DuckDBInstance: {
    create: (): Promise<never> =>
      Promise.reject(
        new Error("DuckDB should not be initialized in shouldCheckpointAfterSync tests")
      ),
  },
  DuckDBAppender: class DuckDBAppender {},
  DuckDBDateValue: {
    fromParts: (): { year: number; month: number; day: number } => ({
      year: 1970,
      month: 1,
      day: 1,
    }),
  },
}));

void mock.module("node:worker_threads", () => ({
  parentPort: {
    on: (): void => undefined,
    postMessage: (): void => undefined,
    removeAllListeners: (): void => undefined,
    close: (): void => undefined,
  },
}));

type ShouldCheckpointAfterSyncFn = (
  action: SyncAction,
  workspacesIngested: number,
  workspacesPurged: number
) => boolean;

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment */
const analyticsWorkerModule: {
  shouldCheckpointAfterSync: ShouldCheckpointAfterSyncFn;
} = require("./analyticsWorker");
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment */
const { shouldCheckpointAfterSync } = analyticsWorkerModule;

describe("shouldCheckpointAfterSync", () => {
  test("returns false for noop regardless of counts", () => {
    expect(shouldCheckpointAfterSync("noop", 5, 3)).toBe(false);
  });

  test("returns false for incremental with zero writes", () => {
    expect(shouldCheckpointAfterSync("incremental", 0, 0)).toBe(false);
  });

  test("returns true for full_rebuild with ingested workspaces", () => {
    expect(shouldCheckpointAfterSync("full_rebuild", 10, 0)).toBe(true);
  });

  test("returns true for incremental with ingested workspaces", () => {
    expect(shouldCheckpointAfterSync("incremental", 3, 0)).toBe(true);
  });

  test("returns true for incremental with purged workspaces only", () => {
    expect(shouldCheckpointAfterSync("incremental", 0, 2)).toBe(true);
  });

  test("returns true for full_rebuild even with zero ingested (purge-only rebuild)", () => {
    // full_rebuild always writes (it clears tables), so always checkpoint
    expect(shouldCheckpointAfterSync("full_rebuild", 0, 0)).toBe(true);
  });
});

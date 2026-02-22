import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, mock, test } from "bun:test";
import type { DuckDBConnection } from "@duckdb/node-api";
import { rebuildAll } from "./etl";

function createMissingSessionsDir(): string {
  return path.join(os.tmpdir(), `mux-analytics-etl-${process.pid}-${randomUUID()}`);
}

function createMockConn(runImplementation: (sql: string, params?: unknown[]) => Promise<unknown>): {
  conn: DuckDBConnection;
  runMock: ReturnType<typeof mock>;
} {
  const runMock = mock(runImplementation);

  return {
    conn: { run: runMock } as unknown as DuckDBConnection,
    runMock,
  };
}

describe("rebuildAll", () => {
  test("deletes events and watermarks inside a single transaction", async () => {
    const { conn, runMock } = createMockConn(async () => undefined);

    const result = await rebuildAll(conn, createMissingSessionsDir());

    expect(result).toEqual({ workspacesIngested: 0 });
    expect(runMock.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN TRANSACTION",
      "DELETE FROM events",
      "DELETE FROM ingest_watermarks",
      "COMMIT",
    ]);
  });

  test("rolls back when the reset cannot delete both tables", async () => {
    const deleteWatermarksError = new Error("delete ingest_watermarks failed");
    const { conn, runMock } = createMockConn(async (sql) => {
      if (sql === "DELETE FROM ingest_watermarks") {
        throw deleteWatermarksError;
      }

      return undefined;
    });

    await expect(rebuildAll(conn, createMissingSessionsDir())).rejects.toThrow(
      deleteWatermarksError.message
    );

    expect(runMock.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN TRANSACTION",
      "DELETE FROM events",
      "DELETE FROM ingest_watermarks",
      "ROLLBACK",
    ]);
  });
});

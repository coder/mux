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

function getSqlStatements(runMock: ReturnType<typeof mock>): string[] {
  const calls = runMock.mock.calls as unknown[][];

  return calls.map((call) => {
    const sql = call[0];
    if (typeof sql !== "string") {
      throw new TypeError("Expected SQL statement as the first run() argument");
    }

    return sql;
  });
}

describe("rebuildAll", () => {
  test("deletes events and watermarks inside a single transaction", async () => {
    const { conn, runMock } = createMockConn(() => Promise.resolve(undefined));

    const result = await rebuildAll(conn, createMissingSessionsDir());

    expect(result).toEqual({ workspacesIngested: 0 });
    expect(getSqlStatements(runMock)).toEqual([
      "BEGIN TRANSACTION",
      "DELETE FROM events",
      "DELETE FROM ingest_watermarks",
      "COMMIT",
    ]);
  });

  test("rolls back when the reset cannot delete both tables", async () => {
    const deleteWatermarksError = new Error("delete ingest_watermarks failed");
    const { conn, runMock } = createMockConn((sql) => {
      if (sql === "DELETE FROM ingest_watermarks") {
        return Promise.reject(deleteWatermarksError);
      }

      return Promise.resolve(undefined);
    });

    await rebuildAll(conn, createMissingSessionsDir()).then(
      () => {
        throw new Error("Expected rebuildAll to reject when deleting ingest_watermarks fails");
      },
      (error: unknown) => {
        expect(error).toBe(deleteWatermarksError);
      }
    );

    expect(getSqlStatements(runMock)).toEqual([
      "BEGIN TRANSACTION",
      "DELETE FROM events",
      "DELETE FROM ingest_watermarks",
      "ROLLBACK",
    ]);
  });
});

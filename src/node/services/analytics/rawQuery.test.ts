import { describe, expect, mock, test } from "bun:test";
import type { DuckDBConnection } from "@duckdb/node-api";
import { executeRawQuery, RAW_QUERY_ROW_LIMIT } from "./queries";

interface MockColumn {
  name: string;
  type: string | { toString(): string };
}

interface MockResultInput {
  columns: MockColumn[];
  rows: Array<Record<string, unknown>>;
}

function createMockResult(input: MockResultInput) {
  return {
    get columnCount(): number {
      return input.columns.length;
    },
    columnName(index: number): string {
      return input.columns[index].name;
    },
    columnType(index: number): string | { toString(): string } {
      return input.columns[index].type;
    },
    getRowObjectsJS(): Promise<Array<Record<string, unknown>>> {
      return Promise.resolve(input.rows);
    },
  };
}

function createMockConn(
  runImplementation: (
    sql: string
  ) =>
    | Promise<ReturnType<typeof createMockResult>>
    | ReturnType<typeof createMockResult>
    | Promise<never>
): {
  conn: DuckDBConnection;
  runMock: ReturnType<typeof mock>;
} {
  const runMock = mock(runImplementation);

  return {
    conn: { run: runMock } as unknown as DuckDBConnection,
    runMock,
  };
}

async function expectQueryFailure(promise: Promise<unknown>, errorPattern: RegExp): Promise<void> {
  try {
    await promise;
    throw new Error("Expected query to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) {
      throw error;
    }
    expect(error.message).toMatch(errorPattern);
  }
}

async function expectValidationFailure(sql: string, errorPattern: RegExp): Promise<void> {
  const { conn, runMock } = createMockConn(() => {
    throw new Error("executeRawQuery should reject SQL before DuckDB execution");
  });

  await expectQueryFailure(executeRawQuery(conn, sql), errorPattern);
  expect(runMock).not.toHaveBeenCalled();
}

describe("executeRawQuery", () => {
  test("wraps SQL with limit, normalizes rows, and returns metadata", async () => {
    const { conn, runMock } = createMockConn(() =>
      createMockResult({
        columns: [
          { name: "model", type: "VARCHAR" },
          { name: "input_tokens", type: "BIGINT" },
          { name: "created_at", type: "TIMESTAMP" },
        ],
        rows: [
          {
            model: "openai:gpt-4.1",
            input_tokens: 123n,
            created_at: new Date("2025-01-01T00:00:00.000Z"),
          },
        ],
      })
    );

    const result = await executeRawQuery(
      conn,
      "SELECT model, input_tokens, created_at FROM events"
    );

    expect(runMock).toHaveBeenCalledWith(
      "SELECT * FROM (SELECT model, input_tokens, created_at FROM events) AS __q LIMIT 10001"
    );
    expect(result.columns).toEqual([
      { name: "model", type: "VARCHAR" },
      { name: "input_tokens", type: "BIGINT" },
      { name: "created_at", type: "TIMESTAMP" },
    ]);
    expect(result.rows).toEqual([
      {
        model: "openai:gpt-4.1",
        input_tokens: 123,
        created_at: "2025-01-01T00:00:00.000Z",
      },
    ]);
    expect(result.truncated).toBe(false);
    expect(result.rowCount).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("strips trailing semicolons before wrapping SQL", async () => {
    const { conn, runMock } = createMockConn(() =>
      createMockResult({
        columns: [{ name: "value", type: "INTEGER" }],
        rows: [{ value: 1 }],
      })
    );

    const result = await executeRawQuery(conn, "  SELECT 1 AS value FROM events;;   ");

    expect(runMock).toHaveBeenCalledWith(
      "SELECT * FROM (SELECT 1 AS value FROM events) AS __q LIMIT 10001"
    );
    expect(result.rows).toEqual([{ value: 1 }]);
  });

  test("rejects queries referencing tables outside the analytics allowlist", async () => {
    await expectValidationFailure("SELECT * FROM duckdb_tables()", /disallowed table or source/i);
  });

  test("rejects comma-joined sources outside the analytics allowlist", async () => {
    await expectValidationFailure(
      "SELECT 1 FROM events, duckdb_tables()",
      /disallowed table or source/i
    );
  });

  test("rejects CTE-shadowed function call", async () => {
    await expectValidationFailure(
      "WITH duckdb_tables AS (SELECT * FROM events) SELECT * FROM duckdb_tables()",
      /disallowed table or source/i
    );
  });

  test("allows legitimate CTE reference", async () => {
    const { conn, runMock } = createMockConn(() =>
      createMockResult({
        columns: [{ name: "event_count", type: "BIGINT" }],
        rows: [{ event_count: 4n }],
      })
    );

    const sql = "WITH daily AS (SELECT * FROM events) SELECT COUNT(*) AS event_count FROM daily";

    const result = await executeRawQuery(conn, sql);

    expect(runMock).toHaveBeenCalledWith(`SELECT * FROM (${sql}) AS __q LIMIT 10001`);
    expect(result.rows).toEqual([{ event_count: 4 }]);
  });

  test("rejects queries using read_csv_auto", async () => {
    await expectValidationFailure(
      "SELECT * FROM read_csv_auto('/etc/passwd')",
      /disallowed function or statement: read_csv_auto/i
    );
  });

  test("rejects queries using read_parquet", async () => {
    await expectValidationFailure(
      "SELECT * FROM read_parquet('file.parquet')",
      /disallowed function or statement: read_parquet/i
    );
  });

  test("rejects queries using read_json", async () => {
    await expectValidationFailure(
      "SELECT * FROM read_json('/tmp/data.json')",
      /disallowed function or statement: read_json/i
    );
  });

  test("rejects COPY statements", async () => {
    await expectValidationFailure(
      "COPY events TO '/tmp/out.csv'",
      /disallowed function or statement: COPY/i
    );
  });

  test("rejects ATTACH statements", async () => {
    await expectValidationFailure(
      "ATTACH '/tmp/db.duckdb' AS stolen",
      /disallowed function or statement: ATTACH/i
    );
  });

  test("rejects PRAGMA statements", async () => {
    await expectValidationFailure(
      "PRAGMA database_list",
      /disallowed function or statement: PRAGMA/i
    );
  });

  test("rejects SET statements", async () => {
    await expectValidationFailure(
      "SET access_mode = 'read_write'",
      /disallowed function or statement: SET/i
    );
  });

  test("rejects INSTALL and LOAD statements", async () => {
    await expectValidationFailure("INSTALL httpfs", /disallowed function or statement: INSTALL/i);
    await expectValidationFailure("LOAD httpfs", /disallowed function or statement: LOAD/i);
  });

  test("allows normal SELECT from events", async () => {
    const { conn, runMock } = createMockConn(() =>
      createMockResult({
        columns: [{ name: "request_count", type: "BIGINT" }],
        rows: [{ request_count: 7n }],
      })
    );

    const result = await executeRawQuery(conn, "SELECT COUNT(*) AS request_count FROM events");

    expect(runMock).toHaveBeenCalledWith(
      "SELECT * FROM (SELECT COUNT(*) AS request_count FROM events) AS __q LIMIT 10001"
    );
    expect(result.rows).toEqual([{ request_count: 7 }]);
  });

  test("allows normal SELECT from delegation_rollups", async () => {
    const { conn, runMock } = createMockConn(() =>
      createMockResult({
        columns: [{ name: "delegation_count", type: "BIGINT" }],
        rows: [{ delegation_count: 2n }],
      })
    );

    const result = await executeRawQuery(
      conn,
      "SELECT COUNT(*) AS delegation_count FROM delegation_rollups"
    );

    expect(runMock).toHaveBeenCalledWith(
      "SELECT * FROM (SELECT COUNT(*) AS delegation_count FROM delegation_rollups) AS __q LIMIT 10001"
    );
    expect(result.rows).toEqual([{ delegation_count: 2 }]);
  });

  test("allows CTEs and subqueries that only reference allowed analytics tables", async () => {
    const { conn, runMock } = createMockConn(() =>
      createMockResult({
        columns: [{ name: "total_rows", type: "BIGINT" }],
        rows: [{ total_rows: 3n }],
      })
    );

    const sql =
      "WITH scoped_events AS (SELECT * FROM events), scoped_rollups AS (SELECT * FROM delegation_rollups) SELECT COUNT(*) AS total_rows FROM (SELECT * FROM scoped_events) AS e JOIN scoped_rollups AS d ON TRUE";

    const result = await executeRawQuery(conn, sql);

    expect(runMock).toHaveBeenCalledWith(`SELECT * FROM (${sql}) AS __q LIMIT 10001`);
    expect(result.rows).toEqual([{ total_rows: 3 }]);
  });

  test("false positive check: a column named read_count is allowed", async () => {
    const { conn, runMock } = createMockConn(() =>
      createMockResult({
        columns: [{ name: "read_count", type: "BIGINT" }],
        rows: [{ read_count: 5n }],
      })
    );

    const result = await executeRawQuery(conn, "SELECT read_count FROM events");

    expect(runMock).toHaveBeenCalledWith(
      "SELECT * FROM (SELECT read_count FROM events) AS __q LIMIT 10001"
    );
    expect(result.rows).toEqual([{ read_count: 5 }]);
  });

  test("throws when SQL execution fails", async () => {
    const { conn } = createMockConn(() => {
      throw new Error("Parser Error: syntax error at or near FRM");
    });

    await expectQueryFailure(
      executeRawQuery(conn, "SELECT * FRM events"),
      /syntax error at or near FRM/i
    );
  });

  test("enforces RAW_QUERY_ROW_LIMIT and marks response truncated", async () => {
    const oversizedRows = Array.from({ length: RAW_QUERY_ROW_LIMIT + 10 }, (_, index) => ({
      rank: index,
    }));

    const { conn } = createMockConn(() =>
      createMockResult({
        columns: [{ name: "rank", type: "BIGINT" }],
        rows: oversizedRows,
      })
    );

    const result = await executeRawQuery(conn, "SELECT rank FROM events");

    expect(result.truncated).toBe(true);
    expect(result.rowCount).toBe(RAW_QUERY_ROW_LIMIT);
    expect(result.rows).toHaveLength(RAW_QUERY_ROW_LIMIT);
    expect(result.rows[0]).toEqual({ rank: 0 });
    expect(result.rows.at(-1)).toEqual({ rank: RAW_QUERY_ROW_LIMIT - 1 });
  });

  test("returns empty rows with column metadata for empty result sets", async () => {
    const { conn } = createMockConn(() =>
      createMockResult({
        columns: [
          { name: "workspace_id", type: "VARCHAR" },
          { name: "total_cost_usd", type: "DOUBLE" },
        ],
        rows: [],
      })
    );

    const result = await executeRawQuery(
      conn,
      "SELECT workspace_id, total_cost_usd FROM events WHERE workspace_id = 'missing'"
    );

    expect(result.columns).toEqual([
      { name: "workspace_id", type: "VARCHAR" },
      { name: "total_cost_usd", type: "DOUBLE" },
    ]);
    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(0);
    expect(result.truncated).toBe(false);
  });

  test("uses DuckDB type toString output for complex type names", async () => {
    const { conn } = createMockConn(() =>
      createMockResult({
        columns: [{ name: "cost", type: { toString: () => "DECIMAL(18,4)" } }],
        rows: [{ cost: 12.34 }],
      })
    );

    const result = await executeRawQuery(conn, "SELECT cost FROM delegation_rollups");

    expect(result.columns).toEqual([{ name: "cost", type: "DECIMAL(18,4)" }]);
  });

  test("preserves CTE SQL and relies on subquery wrapping for write prevention", async () => {
    const { conn, runMock } = createMockConn((sql) => {
      if (sql.includes("INSERT INTO events")) {
        throw new Error('Parser Error: syntax error at or near "INSERT"');
      }

      return createMockResult({
        columns: [{ name: "value", type: "INTEGER" }],
        rows: [{ value: 1 }],
      });
    });

    await expectQueryFailure(
      executeRawQuery(
        conn,
        "WITH cte AS (INSERT INTO events (workspace_id) VALUES ('x')) SELECT * FROM cte"
      ),
      /syntax error at or near "INSERT"/i
    );

    expect(runMock).toHaveBeenCalledWith(
      "SELECT * FROM (WITH cte AS (INSERT INTO events (workspace_id) VALUES ('x')) SELECT * FROM cte) AS __q LIMIT 10001"
    );
  });
});

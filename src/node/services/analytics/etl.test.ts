import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { CHAT_FILE_NAME, clearWorkspaceAnalyticsState, ingestWorkspace, rebuildAll } from "./etl";

const CREATE_EVENTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS events (
  workspace_id VARCHAR NOT NULL,
  project_path VARCHAR,
  project_name VARCHAR,
  workspace_name VARCHAR,
  parent_workspace_id VARCHAR,
  agent_id VARCHAR,
  timestamp BIGINT,
  date DATE,
  model VARCHAR,
  thinking_level VARCHAR,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  reasoning_tokens INTEGER DEFAULT 0,
  cached_tokens INTEGER DEFAULT 0,
  cache_create_tokens INTEGER DEFAULT 0,
  input_cost_usd DOUBLE DEFAULT 0,
  output_cost_usd DOUBLE DEFAULT 0,
  reasoning_cost_usd DOUBLE DEFAULT 0,
  cached_cost_usd DOUBLE DEFAULT 0,
  total_cost_usd DOUBLE DEFAULT 0,
  duration_ms DOUBLE,
  ttft_ms DOUBLE,
  streaming_ms DOUBLE,
  tool_execution_ms DOUBLE,
  output_tps DOUBLE,
  response_index INTEGER,
  is_sub_agent BOOLEAN DEFAULT false
)
`;

const CREATE_WATERMARK_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ingest_watermarks (
  workspace_id VARCHAR PRIMARY KEY,
  last_sequence BIGINT NOT NULL,
  last_modified DOUBLE NOT NULL
)
`;

const SUBAGENT_TRANSCRIPTS_DIR_NAME = "subagent-transcripts";

const tempDirsToClean: string[] = [];
const duckDbHandlesToClose: Array<{ instance: DuckDBInstance; conn: DuckDBConnection }> = [];

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

function makeAssistantLine(
  opts: {
    model?: string;
    sequence?: number;
    timestamp?: number;
    inputTokens?: number;
    outputTokens?: number;
  } = {}
): string {
  return JSON.stringify({
    role: "assistant",
    content: "response",
    metadata: {
      model: opts.model ?? "anthropic:claude-sonnet-4-20250514",
      usage: {
        inputTokens: opts.inputTokens ?? 100,
        outputTokens: opts.outputTokens ?? 50,
      },
      historySequence: opts.sequence ?? 1,
      timestamp: opts.timestamp ?? 1700000000000,
    },
  });
}

function makeUserLine(): string {
  return JSON.stringify({
    role: "user",
    content: "test",
    createdAt: "2024-01-01T00:00:00.000Z",
  });
}

function parseInteger(value: unknown, fieldName: string): number {
  if (typeof value === "number") {
    assert(Number.isInteger(value), `${fieldName} should be an integer number`);
    return value;
  }

  if (typeof value === "bigint") {
    const coerced = Number(value);
    assert(Number.isSafeInteger(coerced), `${fieldName} should coerce to a safe integer`);
    return coerced;
  }

  throw new TypeError(`${fieldName} should be an integer-compatible value`);
}

function parseBooleanFromInteger(value: unknown, fieldName: string): boolean {
  const parsed = parseInteger(value, fieldName);
  assert(parsed === 0 || parsed === 1, `${fieldName} should be 0 or 1`);
  return parsed === 1;
}

async function createTempSessionDir(): Promise<string> {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-etl-test-"));
  tempDirsToClean.push(sessionDir);
  return sessionDir;
}

async function createTestConn(): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  duckDbHandlesToClose.push({ instance, conn });

  await conn.run(CREATE_EVENTS_TABLE_SQL);
  await conn.run(CREATE_WATERMARK_TABLE_SQL);

  return conn;
}

async function writeChatJsonl(sessionDir: string, lines: string[]): Promise<void> {
  await fs.writeFile(path.join(sessionDir, CHAT_FILE_NAME), `${lines.join("\n")}\n`);
}

async function writeMetadataJson(sessionDir: string, meta: Record<string, unknown>): Promise<void> {
  await fs.writeFile(path.join(sessionDir, "metadata.json"), JSON.stringify(meta));
}

async function queryRows(
  conn: DuckDBConnection,
  sql: string,
  params: string[] = []
): Promise<Array<Record<string, unknown>>> {
  const result = await conn.run(sql, params);
  return await result.getRowObjectsJS();
}

async function queryEventCount(conn: DuckDBConnection, workspaceId?: string): Promise<number> {
  const rows =
    workspaceId == null
      ? await queryRows(conn, "SELECT COUNT(*) AS cnt FROM events")
      : await queryRows(conn, "SELECT COUNT(*) AS cnt FROM events WHERE workspace_id = ?", [
          workspaceId,
        ]);

  assert(rows.length === 1, "queryEventCount expected exactly one row");
  return parseInteger(rows[0].cnt, "cnt");
}

async function bumpChatMtime(sessionDir: string): Promise<void> {
  const chatPath = path.join(sessionDir, CHAT_FILE_NAME);
  const currentStat = await fs.stat(chatPath);
  const bumpedTime = new Date(currentStat.mtimeMs + 5_000);
  await fs.utimes(chatPath, bumpedTime, bumpedTime);
}

afterEach(async () => {
  for (const { conn, instance } of duckDbHandlesToClose.splice(0).reverse()) {
    try {
      conn.closeSync();
    } catch {
      // Ignore close failures in test cleanup.
    }

    try {
      instance.closeSync();
    } catch {
      // Ignore close failures in test cleanup.
    }
  }

  await Promise.all(
    tempDirsToClean.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

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

describe("ingestArchivedSubagentTranscripts", () => {
  test("ingests archived sub-agent transcripts from parent session dir", async () => {
    const conn = await createTestConn();
    const parentWorkspaceId = "parent-id";
    const childWorkspaceId = "child-1";

    const parentSessionDir = await createTempSessionDir();
    await writeChatJsonl(parentSessionDir, [makeUserLine(), makeAssistantLine({ sequence: 1 })]);

    const childSessionDir = path.join(
      parentSessionDir,
      SUBAGENT_TRANSCRIPTS_DIR_NAME,
      childWorkspaceId
    );
    await fs.mkdir(childSessionDir, { recursive: true });
    await writeChatJsonl(childSessionDir, [makeUserLine(), makeAssistantLine({ sequence: 1 })]);
    await writeMetadataJson(childSessionDir, {
      parentWorkspaceId,
      projectPath: "/home/user/myproject",
      projectName: "myproject",
      name: "child-workspace",
    });

    await ingestWorkspace(conn, parentWorkspaceId, parentSessionDir, { projectPath: "/test" });

    expect(await queryEventCount(conn)).toBe(2);

    const parentRows = await queryRows(
      conn,
      "SELECT CAST(is_sub_agent AS INTEGER) AS is_sub_agent_int FROM events WHERE workspace_id = ?",
      [parentWorkspaceId]
    );
    expect(parentRows).toHaveLength(1);
    expect(parseBooleanFromInteger(parentRows[0].is_sub_agent_int, "is_sub_agent_int")).toBe(false);

    const childRows = await queryRows(
      conn,
      "SELECT parent_workspace_id, CAST(is_sub_agent AS INTEGER) AS is_sub_agent_int FROM events WHERE workspace_id = ?",
      [childWorkspaceId]
    );
    expect(childRows).toHaveLength(1);
    expect(childRows[0].parent_workspace_id).toBe(parentWorkspaceId);
    expect(parseBooleanFromInteger(childRows[0].is_sub_agent_int, "is_sub_agent_int")).toBe(true);
  });

  test("handles flat rollup — ingests both child and grandchild at parent level", async () => {
    const conn = await createTestConn();
    const parentWorkspaceId = "parent-id";
    const childWorkspaceId = "child-b";
    const grandchildWorkspaceId = "child-c";

    const parentSessionDir = await createTempSessionDir();
    await writeChatJsonl(parentSessionDir, [makeUserLine(), makeAssistantLine({ sequence: 1 })]);

    const childSessionDir = path.join(
      parentSessionDir,
      SUBAGENT_TRANSCRIPTS_DIR_NAME,
      childWorkspaceId
    );
    await fs.mkdir(childSessionDir, { recursive: true });
    await writeChatJsonl(childSessionDir, [makeUserLine(), makeAssistantLine({ sequence: 1 })]);
    await writeMetadataJson(childSessionDir, {
      parentWorkspaceId,
      name: "child-workspace",
    });

    const grandchildSessionDir = path.join(
      parentSessionDir,
      SUBAGENT_TRANSCRIPTS_DIR_NAME,
      grandchildWorkspaceId
    );
    await fs.mkdir(grandchildSessionDir, { recursive: true });
    await writeChatJsonl(grandchildSessionDir, [
      makeUserLine(),
      makeAssistantLine({ sequence: 1 }),
    ]);
    await writeMetadataJson(grandchildSessionDir, {
      parentWorkspaceId: childWorkspaceId,
      name: "grandchild-workspace",
    });

    await ingestWorkspace(conn, parentWorkspaceId, parentSessionDir, { projectPath: "/test" });

    expect(await queryEventCount(conn)).toBe(3);

    const childRows = await queryRows(
      conn,
      "SELECT CAST(is_sub_agent AS INTEGER) AS is_sub_agent_int FROM events WHERE workspace_id = ?",
      [childWorkspaceId]
    );
    expect(childRows).toHaveLength(1);
    expect(parseBooleanFromInteger(childRows[0].is_sub_agent_int, "is_sub_agent_int")).toBe(true);

    const grandchildRows = await queryRows(
      conn,
      "SELECT parent_workspace_id, CAST(is_sub_agent AS INTEGER) AS is_sub_agent_int FROM events WHERE workspace_id = ?",
      [grandchildWorkspaceId]
    );
    expect(grandchildRows).toHaveLength(1);
    expect(grandchildRows[0].parent_workspace_id).toBe(childWorkspaceId);
    expect(parseBooleanFromInteger(grandchildRows[0].is_sub_agent_int, "is_sub_agent_int")).toBe(
      true
    );
  });

  test("watermark prevents double-counting on re-ingestion", async () => {
    const conn = await createTestConn();
    const parentWorkspaceId = "parent-id";
    const childWorkspaceId = "child-id";

    const parentSessionDir = await createTempSessionDir();
    await writeChatJsonl(parentSessionDir, [makeUserLine(), makeAssistantLine({ sequence: 1 })]);

    const childSessionDir = path.join(
      parentSessionDir,
      SUBAGENT_TRANSCRIPTS_DIR_NAME,
      childWorkspaceId
    );
    await fs.mkdir(childSessionDir, { recursive: true });
    await writeChatJsonl(childSessionDir, [makeUserLine(), makeAssistantLine({ sequence: 1 })]);
    await writeMetadataJson(childSessionDir, {
      parentWorkspaceId,
      name: "child-workspace",
    });

    await ingestWorkspace(conn, parentWorkspaceId, parentSessionDir, { projectPath: "/test" });
    const firstChildCount = await queryEventCount(conn, childWorkspaceId);

    await bumpChatMtime(parentSessionDir);
    await ingestWorkspace(conn, parentWorkspaceId, parentSessionDir, { projectPath: "/test" });

    const secondChildCount = await queryEventCount(conn, childWorkspaceId);
    expect(secondChildCount).toBe(firstChildCount);
    expect(await queryEventCount(conn)).toBe(2);
  });

  test("recovers sub-agent data after clearWorkspaceAnalyticsState", async () => {
    const conn = await createTestConn();
    const parentWorkspaceId = "parent-id";
    const childWorkspaceId = "child-id";

    const parentSessionDir = await createTempSessionDir();
    await writeChatJsonl(parentSessionDir, [makeUserLine(), makeAssistantLine({ sequence: 1 })]);

    const childSessionDir = path.join(
      parentSessionDir,
      SUBAGENT_TRANSCRIPTS_DIR_NAME,
      childWorkspaceId
    );
    await fs.mkdir(childSessionDir, { recursive: true });
    await writeChatJsonl(childSessionDir, [makeUserLine(), makeAssistantLine({ sequence: 1 })]);
    await writeMetadataJson(childSessionDir, {
      parentWorkspaceId,
      name: "child-workspace",
    });

    await ingestWorkspace(conn, parentWorkspaceId, parentSessionDir, { projectPath: "/test" });
    expect(await queryEventCount(conn, childWorkspaceId)).toBe(1);

    await clearWorkspaceAnalyticsState(conn, childWorkspaceId);
    expect(await queryEventCount(conn, childWorkspaceId)).toBe(0);

    await bumpChatMtime(parentSessionDir);
    await ingestWorkspace(conn, parentWorkspaceId, parentSessionDir, { projectPath: "/test" });

    expect(await queryEventCount(conn, childWorkspaceId)).toBe(1);

    const childRows = await queryRows(
      conn,
      "SELECT CAST(is_sub_agent AS INTEGER) AS is_sub_agent_int FROM events WHERE workspace_id = ?",
      [childWorkspaceId]
    );
    expect(childRows).toHaveLength(1);
    expect(parseBooleanFromInteger(childRows[0].is_sub_agent_int, "is_sub_agent_int")).toBe(true);
  });

  test("rebuildAll ingests archived sub-agent transcripts", async () => {
    const conn = await createTestConn();
    const sessionsDir = await createTempSessionDir();
    const parentWorkspaceId = "parent-id";
    const childWorkspaceId = "child-id";

    const parentSessionDir = path.join(sessionsDir, parentWorkspaceId);
    await fs.mkdir(parentSessionDir, { recursive: true });
    await writeChatJsonl(parentSessionDir, [makeUserLine(), makeAssistantLine({ sequence: 1 })]);

    const childSessionDir = path.join(
      parentSessionDir,
      SUBAGENT_TRANSCRIPTS_DIR_NAME,
      childWorkspaceId
    );
    await fs.mkdir(childSessionDir, { recursive: true });
    await writeChatJsonl(childSessionDir, [makeUserLine(), makeAssistantLine({ sequence: 1 })]);
    await writeMetadataJson(childSessionDir, {
      parentWorkspaceId,
      name: "child-workspace",
    });

    const result = await rebuildAll(conn, sessionsDir);

    expect(result).toEqual({ workspacesIngested: 1 });
    expect(await queryEventCount(conn)).toBe(2);
    expect(await queryEventCount(conn, parentWorkspaceId)).toBe(1);
    expect(await queryEventCount(conn, childWorkspaceId)).toBe(1);
  });

  test("no-op when subagent-transcripts directory does not exist", async () => {
    const conn = await createTestConn();
    const parentWorkspaceId = "parent-id";

    const parentSessionDir = await createTempSessionDir();
    await writeChatJsonl(parentSessionDir, [makeUserLine(), makeAssistantLine({ sequence: 1 })]);

    await ingestWorkspace(conn, parentWorkspaceId, parentSessionDir, { projectPath: "/test" });

    expect(await queryEventCount(conn)).toBe(1);
    expect(await queryEventCount(conn, parentWorkspaceId)).toBe(1);
  });

  test("falls back to parent workspace ID when archived metadata.json is missing", async () => {
    const conn = await createTestConn();
    const parentWorkspaceId = "parent-id";
    const childWorkspaceId = "legacy-child";

    const parentSessionDir = await createTempSessionDir();
    await writeChatJsonl(parentSessionDir, [makeUserLine(), makeAssistantLine({ sequence: 1 })]);

    // Create archived child WITHOUT metadata.json — simulates pre-existing archives
    const childSessionDir = path.join(
      parentSessionDir,
      SUBAGENT_TRANSCRIPTS_DIR_NAME,
      childWorkspaceId
    );
    await fs.mkdir(childSessionDir, { recursive: true });
    await writeChatJsonl(childSessionDir, [makeUserLine(), makeAssistantLine({ sequence: 1 })]);
    // Deliberately NOT writing metadata.json

    await ingestWorkspace(conn, parentWorkspaceId, parentSessionDir, { projectPath: "/test" });

    expect(await queryEventCount(conn, childWorkspaceId)).toBe(1);

    const childRows = await queryRows(
      conn,
      "SELECT parent_workspace_id, CAST(is_sub_agent AS INTEGER) AS is_sub_agent_int FROM events WHERE workspace_id = ?",
      [childWorkspaceId]
    );
    expect(childRows).toHaveLength(1);
    // Even without metadata.json, the fallback sets parentWorkspaceId and is_sub_agent
    expect(childRows[0].parent_workspace_id).toBe(parentWorkspaceId);
    expect(parseBooleanFromInteger(childRows[0].is_sub_agent_int, "is_sub_agent_int")).toBe(true);
  });
});

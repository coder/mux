import assert from "node:assert/strict";
import { parentPort } from "node:worker_threads";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { getErrorMessage } from "@/common/utils/errors";
import { ingestWorkspace, rebuildAll } from "./etl";
import { executeNamedQuery } from "./queries";

interface WorkerRequest {
  messageId: number;
  taskName: string;
  data: unknown;
}

interface WorkerSuccessResponse {
  messageId: number;
  result: unknown;
}

interface WorkerErrorResponse {
  messageId: number;
  error: {
    message: string;
    stack?: string;
  };
}

interface InitData {
  dbPath: string;
}

interface IngestData {
  workspaceId: string;
  sessionDir: string;
  meta?: {
    projectPath?: string;
    projectName?: string;
    workspaceName?: string;
    parentWorkspaceId?: string;
  };
}

interface RebuildAllData {
  sessionsDir: string;
}

interface QueryData {
  queryName: string;
  params: Record<string, unknown>;
}

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

let conn: DuckDBConnection | null = null;

function getConn(): DuckDBConnection {
  assert(conn, "analytics worker has not been initialized");
  return conn;
}

async function handleInit(data: InitData): Promise<void> {
  assert(data.dbPath.trim().length > 0, "init requires a non-empty dbPath");

  const instance = await DuckDBInstance.create(data.dbPath);
  conn = await instance.connect();

  const activeConn = getConn();
  await activeConn.run(CREATE_EVENTS_TABLE_SQL);
  await activeConn.run(CREATE_WATERMARK_TABLE_SQL);
}

async function handleIngest(data: IngestData): Promise<void> {
  assert(data.workspaceId.trim().length > 0, "ingest requires workspaceId");
  assert(data.sessionDir.trim().length > 0, "ingest requires sessionDir");

  await ingestWorkspace(getConn(), data.workspaceId, data.sessionDir, data.meta ?? {});
}

async function handleRebuildAll(data: RebuildAllData): Promise<{ workspacesIngested: number }> {
  assert(data.sessionsDir.trim().length > 0, "rebuildAll requires sessionsDir");
  return rebuildAll(getConn(), data.sessionsDir);
}

async function handleQuery(data: QueryData): Promise<unknown> {
  assert(data.queryName.trim().length > 0, "query requires queryName");
  return executeNamedQuery(getConn(), data.queryName, data.params);
}

async function dispatchTask(taskName: string, data: unknown): Promise<unknown> {
  switch (taskName) {
    case "init":
      return handleInit(data as InitData);
    case "ingest":
      return handleIngest(data as IngestData);
    case "rebuildAll":
      return handleRebuildAll(data as RebuildAllData);
    case "query":
      return handleQuery(data as QueryData);
    default:
      throw new Error(`Unknown analytics worker task: ${taskName}`);
  }
}

assert(parentPort, "analytics worker requires a parentPort");

parentPort.on("message", (message: WorkerRequest) => {
  dispatchTask(message.taskName, message.data)
    .then((result) => {
      const response: WorkerSuccessResponse = {
        messageId: message.messageId,
        result,
      };
      parentPort!.postMessage(response);
    })
    .catch((error) => {
      const response: WorkerErrorResponse = {
        messageId: message.messageId,
        error: {
          message: getErrorMessage(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      };
      parentPort!.postMessage(response);
    });
});

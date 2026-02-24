import assert from "node:assert/strict";
import { parentPort } from "node:worker_threads";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { getErrorMessage } from "@/common/utils/errors";
import { shouldRunInitialBackfill } from "./backfillDecision";
import { clearWorkspaceAnalyticsState, ingestWorkspace, rebuildAll } from "./etl";
import {
  listArchivedSubagentWorkspaceIds,
  listSessionWorkspaceIdsWithHistory,
} from "./workspaceDiscovery";
import { executeNamedQuery } from "./queries";

interface WorkerTaskRequest {
  messageId: number;
  taskName: string;
  data: unknown;
}

interface WorkerShutdownRequest {
  type: "shutdown";
}

type WorkerRequest = WorkerTaskRequest | WorkerShutdownRequest;

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

interface WorkspaceMeta {
  projectPath?: string;
  projectName?: string;
  workspaceName?: string;
  parentWorkspaceId?: string;
}

interface IngestData {
  workspaceId: string;
  sessionDir: string;
  meta?: WorkspaceMeta;
}

interface RebuildAllData {
  sessionsDir: string;
  workspaceMetaById?: Record<string, WorkspaceMeta>;
}

interface NeedsBackfillData {
  sessionsDir: string;
}

interface ClearWorkspaceData {
  workspaceId: string;
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

let instance: DuckDBInstance | null = null;
let conn: DuckDBConnection | null = null;
let isShuttingDown = false;

function getConn(): DuckDBConnection {
  assert(conn, "analytics worker has not been initialized");
  return conn;
}

async function handleInit(data: InitData): Promise<void> {
  assert(data.dbPath.trim().length > 0, "init requires a non-empty dbPath");
  assert(instance == null && conn == null, "analytics worker init must only run once per process");

  const createdInstance = await DuckDBInstance.create(data.dbPath);
  instance = createdInstance;
  conn = await createdInstance.connect();

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
  if (data.workspaceMetaById != null) {
    assert(
      isRecord(data.workspaceMetaById) && !Array.isArray(data.workspaceMetaById),
      "rebuildAll workspaceMetaById must be an object when provided"
    );
  }

  return rebuildAll(getConn(), data.sessionsDir, data.workspaceMetaById ?? {});
}

async function handleClearWorkspace(data: ClearWorkspaceData): Promise<void> {
  assert(data.workspaceId.trim().length > 0, "clearWorkspace requires workspaceId");
  await clearWorkspaceAnalyticsState(getConn(), data.workspaceId);
}

async function handleQuery(data: QueryData): Promise<unknown> {
  assert(data.queryName.trim().length > 0, "query requires queryName");
  return executeNamedQuery(getConn(), data.queryName, data.params);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseNonNegativeInteger(value: unknown): number | null {
  if (typeof value === "bigint") {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      return null;
    }

    return parsed;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }

  return value;
}

function parseBooleanLike(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  const parsed = parseNonNegativeInteger(value);
  if (parsed === 0) {
    return false;
  }

  if (parsed === 1) {
    return true;
  }

  return null;
}

function parseNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  if (value.trim().length === 0) {
    return null;
  }

  return value;
}

async function listWatermarkWorkspaceIds(): Promise<Set<string>> {
  const result = await getConn().run("SELECT workspace_id FROM ingest_watermarks");
  const rows = await result.getRowObjectsJS();

  const watermarkWorkspaceIds = new Set<string>();
  for (const row of rows) {
    const workspaceId = parseNonEmptyString(row.workspace_id);
    assert(
      workspaceId !== null,
      "needsBackfill expected ingest_watermarks rows to have non-empty workspace_id"
    );
    watermarkWorkspaceIds.add(workspaceId);
  }

  return watermarkWorkspaceIds;
}

async function handleNeedsBackfill(data: NeedsBackfillData): Promise<{ needsBackfill: boolean }> {
  assert(data.sessionsDir.trim().length > 0, "needsBackfill requires sessionsDir");

  const result = await getConn().run(`
    SELECT
      (SELECT COUNT(*) FROM events) AS event_count,
      (SELECT COUNT(*) FROM ingest_watermarks) AS watermark_count,
      (SELECT EXISTS(SELECT 1 FROM ingest_watermarks WHERE last_sequence >= 0))
        AS has_any_watermark_at_or_above_zero
  `);
  const rows = await result.getRowObjectsJS();
  assert(rows.length === 1, "needsBackfill should return exactly one row");

  const eventCount = parseNonNegativeInteger(rows[0].event_count);
  assert(eventCount !== null, "needsBackfill expected a non-negative integer event_count");

  const watermarkCount = parseNonNegativeInteger(rows[0].watermark_count);
  assert(watermarkCount !== null, "needsBackfill expected a non-negative integer watermark_count");

  const hasAnyWatermarkAtOrAboveZero = parseBooleanLike(rows[0].has_any_watermark_at_or_above_zero);
  assert(
    hasAnyWatermarkAtOrAboveZero !== null,
    "needsBackfill expected boolean has_any_watermark_at_or_above_zero"
  );

  const sessionWorkspaceIds = await listSessionWorkspaceIdsWithHistory(data.sessionsDir);
  const sessionWorkspaceCount = sessionWorkspaceIds.length;

  // Archived sub-agent transcripts are stored under the parent session directory
  // and never appear as top-level session workspace IDs. Include them so
  // sub-agent watermark rows do not trigger a rebuild loop on every startup.
  const archivedSubagentWorkspaceIds = await listArchivedSubagentWorkspaceIds(
    data.sessionsDir,
    sessionWorkspaceIds
  );
  const knownWorkspaceIdSet = new Set(sessionWorkspaceIds);
  for (const archivedWorkspaceId of archivedSubagentWorkspaceIds) {
    knownWorkspaceIdSet.add(archivedWorkspaceId);
  }

  const watermarkWorkspaceIds = await listWatermarkWorkspaceIds();
  assert(
    watermarkWorkspaceIds.size === watermarkCount,
    "needsBackfill expected watermark_count to match ingest_watermarks workspace IDs"
  );

  const hasSessionWorkspaceMissingWatermark = sessionWorkspaceIds.some(
    (workspaceId) => !watermarkWorkspaceIds.has(workspaceId)
  );
  const hasWatermarkMissingSessionWorkspace = [...watermarkWorkspaceIds].some(
    (workspaceId) => !knownWorkspaceIdSet.has(workspaceId)
  );

  return {
    needsBackfill: shouldRunInitialBackfill({
      eventCount,
      watermarkCount,
      sessionWorkspaceCount,
      hasSessionWorkspaceMissingWatermark,
      hasWatermarkMissingSessionWorkspace,
      hasAnyWatermarkAtOrAboveZero,
    }),
  };
}

function isWorkerTaskRequest(message: unknown): message is WorkerTaskRequest {
  if (!isRecord(message)) {
    return false;
  }

  const messageId = message.messageId;
  if (typeof messageId !== "number" || !Number.isInteger(messageId) || messageId < 0) {
    return false;
  }

  const taskName = message.taskName;
  return typeof taskName === "string" && taskName.trim().length > 0;
}

function isWorkerShutdownRequest(message: unknown): message is WorkerShutdownRequest {
  return isRecord(message) && message.type === "shutdown";
}

function closeDuckDb(): void {
  const activeConn = conn;
  const activeInstance = instance;
  conn = null;
  instance = null;

  try {
    if (activeConn != null) {
      activeConn.disconnectSync();
    }
  } finally {
    if (activeInstance != null) {
      activeInstance.closeSync();
    }
  }
}

// Shutdown runs in the serialized message queue, so we only close DuckDB
// after earlier ETL/query tasks have completed on this worker thread.
function handleShutdown(): void {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  let exitCode = 0;

  try {
    closeDuckDb();
  } catch (error) {
    exitCode = 1;
    process.stderr.write(
      `[analytics-worker] Failed to close DuckDB during shutdown: ${getErrorMessage(error)}\n`
    );
  }

  workerParentPort.removeAllListeners("message");
  workerParentPort.close();
  process.exit(exitCode);
}

async function dispatchTask(taskName: string, data: unknown): Promise<unknown> {
  switch (taskName) {
    case "init":
      return handleInit(data as InitData);
    case "ingest":
      return handleIngest(data as IngestData);
    case "rebuildAll":
      return handleRebuildAll(data as RebuildAllData);
    case "clearWorkspace":
      return handleClearWorkspace(data as ClearWorkspaceData);
    case "query":
      return handleQuery(data as QueryData);
    case "needsBackfill":
      return handleNeedsBackfill(data as NeedsBackfillData);
    default:
      throw new Error(`Unknown analytics worker task: ${taskName}`);
  }
}

function requireParentPort(): NonNullable<typeof parentPort> {
  if (parentPort == null) {
    throw new Error("analytics worker requires a parentPort");
  }

  return parentPort;
}

const workerParentPort = requireParentPort();

function toResponseMessageId(message: WorkerTaskRequest): number {
  if (Number.isInteger(message.messageId) && message.messageId >= 0) {
    return message.messageId;
  }

  return -1;
}

function postWorkerResponse(response: WorkerSuccessResponse | WorkerErrorResponse): void {
  try {
    workerParentPort.postMessage(response);
  } catch (error) {
    process.stderr.write(
      `[analytics-worker] Failed to post worker response: ${getErrorMessage(error)}\n`
    );
  }
}

async function processMessage(message: WorkerTaskRequest): Promise<void> {
  const responseMessageId = toResponseMessageId(message);

  try {
    assert(
      Number.isInteger(message.messageId) && message.messageId >= 0,
      "analytics worker message must include a non-negative integer messageId"
    );
    assert(
      typeof message.taskName === "string" && message.taskName.trim().length > 0,
      "analytics worker message requires taskName"
    );

    const result = await dispatchTask(message.taskName, message.data);
    const response: WorkerSuccessResponse = {
      messageId: responseMessageId,
      result,
    };
    postWorkerResponse(response);
  } catch (error) {
    const response: WorkerErrorResponse = {
      messageId: responseMessageId,
      error: {
        message: getErrorMessage(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
    };
    postWorkerResponse(response);
  }
}

let messageQueue: Promise<void> = Promise.resolve();

workerParentPort.on("message", (message: WorkerRequest) => {
  // Serialize ETL/query tasks and shutdown so dispose can wait for in-flight
  // DuckDB work to finish before we disconnect and close the database.
  if (isWorkerShutdownRequest(message)) {
    messageQueue = messageQueue.then(
      () => handleShutdown(),
      () => handleShutdown()
    );
    return;
  }

  if (!isWorkerTaskRequest(message)) {
    process.stderr.write("[analytics-worker] Dropping invalid worker message payload\n");
    return;
  }

  messageQueue = messageQueue.then(
    () => processMessage(message),
    () => processMessage(message)
  );
});

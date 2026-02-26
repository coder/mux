import assert from "node:assert/strict";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import type { DuckDBConnection } from "@duckdb/node-api";
import { EventRowSchema, type EventRow } from "@/common/orpc/schemas/analytics";
import { getErrorMessage } from "@/common/utils/errors";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import { log } from "@/node/services/log";

export const CHAT_FILE_NAME = "chat.jsonl";
const METADATA_FILE_NAME = "metadata.json";
const SUBAGENT_TRANSCRIPTS_DIR_NAME = "subagent-transcripts";
const SESSION_USAGE_FILE_NAME = "session-usage.json";
const SUBAGENT_REPORTS_FILE_NAME = "subagent-reports.json";

const INSERT_EVENT_SQL = `
INSERT INTO events (
  workspace_id,
  project_path,
  project_name,
  workspace_name,
  parent_workspace_id,
  agent_id,
  timestamp,
  date,
  model,
  thinking_level,
  input_tokens,
  output_tokens,
  reasoning_tokens,
  cached_tokens,
  cache_create_tokens,
  input_cost_usd,
  output_cost_usd,
  reasoning_cost_usd,
  cached_cost_usd,
  total_cost_usd,
  duration_ms,
  ttft_ms,
  streaming_ms,
  tool_execution_ms,
  output_tps,
  response_index,
  is_sub_agent
) VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?, ?
)
`;

const INSERT_DELEGATION_ROLLUP_SQL = `
INSERT OR REPLACE INTO delegation_rollups (
  parent_workspace_id, child_workspace_id, project_path, project_name,
  agent_type, model, total_tokens, context_tokens,
  input_tokens, output_tokens, reasoning_tokens, cached_tokens, cache_create_tokens,
  report_token_estimate, total_cost_usd, rolled_up_at_ms, date
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

interface WorkspaceMeta {
  projectPath?: string;
  projectName?: string;
  workspaceName?: string;
  parentWorkspaceId?: string;
}

type WorkspaceMetaById = Record<string, WorkspaceMeta>;

interface IngestWatermark {
  lastSequence: number;
  lastModified: number;
}

interface IngestEvent {
  row: EventRow;
  sequence: number;
  date: string | null;
}

interface EventHeadSignatureParts {
  timestamp: number | null;
  model: string | null;
  totalCostUsd: number | null;
}

interface PersistedMessage {
  role?: unknown;
  createdAt?: unknown;
  metadata?: unknown;
}

const TTFT_FIELD_CANDIDATES = [
  "ttftMs",
  "ttft_ms",
  "timeToFirstTokenMs",
  "time_to_first_token_ms",
  "timeToFirstToken",
  "time_to_first_token",
  "firstTokenMs",
  "first_token_ms",
] as const;

const TIMING_RECORD_CANDIDATES = [
  "providerMetadata",
  "timing",
  "timings",
  "metrics",
  "latency",
  "performance",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toFiniteNumber(value: unknown): number | null {
  // DuckDB returns BIGINT columns as JS bigint — coerce to number when safe.
  if (typeof value === "bigint") {
    const coerced = Number(value);
    return Number.isFinite(coerced) ? coerced : null;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return value;
}

function toFiniteInteger(value: unknown): number | null {
  const parsed = toFiniteNumber(value);
  if (parsed === null || !Number.isInteger(parsed)) {
    return null;
  }

  return parsed;
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseCreatedAtTimestamp(value: unknown): number | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.getTime();
  }

  if (typeof value !== "string") {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateBucketFromTimestamp(timestampMs: number | null): string | null {
  if (timestampMs === null) {
    return null;
  }

  const date = new Date(timestampMs);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}

function parseUsage(rawUsage: unknown): LanguageModelV2Usage | undefined {
  if (!isRecord(rawUsage)) {
    return undefined;
  }

  const inputTokens = toFiniteNumber(rawUsage.inputTokens) ?? undefined;
  const outputTokens = toFiniteNumber(rawUsage.outputTokens) ?? undefined;
  const totalTokens = toFiniteNumber(rawUsage.totalTokens) ?? undefined;
  const reasoningTokens = toFiniteNumber(rawUsage.reasoningTokens) ?? undefined;
  const cachedInputTokens = toFiniteNumber(rawUsage.cachedInputTokens) ?? undefined;

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    reasoningTokens === undefined &&
    cachedInputTokens === undefined
  ) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens,
    cachedInputTokens,
  };
}

function readFirstFiniteMetric(
  source: Record<string, unknown>,
  keys: readonly string[]
): number | null {
  for (const key of keys) {
    const parsed = toFiniteNumber(source[key]);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function collectTimingMetricSources(
  metadata: Record<string, unknown>
): Array<Record<string, unknown>> {
  const visited = new Set<Record<string, unknown>>();
  const sources: Array<Record<string, unknown>> = [];

  const enqueueRecord = (value: unknown): void => {
    if (!isRecord(value) || visited.has(value)) {
      return;
    }

    visited.add(value);
    sources.push(value);
  };

  const enqueueKnownTimingCandidates = (value: unknown): void => {
    if (!isRecord(value)) {
      return;
    }

    enqueueRecord(value);

    for (const key of TIMING_RECORD_CANDIDATES) {
      enqueueRecord(value[key]);
    }
  };

  enqueueKnownTimingCandidates(metadata);

  const providerMetadata = metadata.providerMetadata;
  enqueueKnownTimingCandidates(providerMetadata);

  if (isRecord(providerMetadata)) {
    for (const nestedProviderMetadata of Object.values(providerMetadata)) {
      enqueueKnownTimingCandidates(nestedProviderMetadata);
    }
  }

  return sources;
}

function extractTtftMs(metadata: Record<string, unknown>): number | null {
  const timingSources = collectTimingMetricSources(metadata);
  assert(timingSources.length > 0, "extractTtftMs: expected at least one timing source");

  for (const source of timingSources) {
    const ttftMs = readFirstFiniteMetric(source, TTFT_FIELD_CANDIDATES);
    if (ttftMs !== null) {
      return ttftMs;
    }
  }

  return null;
}

function deriveProjectName(projectPath: string | undefined): string | undefined {
  if (!projectPath) {
    return undefined;
  }

  const basename = path.basename(projectPath);
  return basename.length > 0 ? basename : undefined;
}

function parseWorkspaceMetaFromUnknown(value: unknown): WorkspaceMeta {
  if (!isRecord(value)) {
    return {};
  }

  return {
    projectPath: toOptionalString(value.projectPath),
    projectName: toOptionalString(value.projectName),
    workspaceName: toOptionalString(value.name),
    parentWorkspaceId: toOptionalString(value.parentWorkspaceId),
  };
}

async function readWorkspaceMetaFromDisk(sessionDir: string): Promise<WorkspaceMeta> {
  const metadataPath = path.join(sessionDir, METADATA_FILE_NAME);

  try {
    const raw = await fs.readFile(metadataPath, "utf-8");
    return parseWorkspaceMetaFromUnknown(JSON.parse(raw) as unknown);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return {};
    }

    log.warn("[analytics-etl] Failed to read workspace metadata", {
      metadataPath,
      error: getErrorMessage(error),
    });
    return {};
  }
}

function mergeWorkspaceMeta(
  sessionMeta: WorkspaceMeta,
  overrideMeta: WorkspaceMeta
): WorkspaceMeta {
  const projectPath = overrideMeta.projectPath ?? sessionMeta.projectPath;

  return {
    projectPath,
    projectName:
      overrideMeta.projectName ?? sessionMeta.projectName ?? deriveProjectName(projectPath),
    workspaceName: overrideMeta.workspaceName ?? sessionMeta.workspaceName,
    parentWorkspaceId: overrideMeta.parentWorkspaceId ?? sessionMeta.parentWorkspaceId,
  };
}

function parsePersistedMessage(
  line: string,
  workspaceId: string,
  lineNumber: number
): PersistedMessage | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return isRecord(parsed) ? (parsed as PersistedMessage) : null;
  } catch (error) {
    log.warn("[analytics-etl] Skipping malformed chat.jsonl line", {
      workspaceId,
      lineNumber,
      error: getErrorMessage(error),
    });
    return null;
  }
}

function extractIngestEvent(params: {
  workspaceId: string;
  workspaceMeta: WorkspaceMeta;
  message: PersistedMessage;
  lineNumber: number;
  responseIndex: number;
}): IngestEvent | null {
  if (params.message.role !== "assistant") {
    return null;
  }

  const metadata = isRecord(params.message.metadata) ? params.message.metadata : null;
  if (!metadata) {
    return null;
  }

  const usage = parseUsage(metadata.usage);
  if (!usage) {
    return null;
  }

  const sequence = toFiniteInteger(metadata.historySequence) ?? params.lineNumber;

  const model = toOptionalString(metadata.model);
  const providerMetadata = isRecord(metadata.providerMetadata)
    ? metadata.providerMetadata
    : undefined;

  const displayUsage = createDisplayUsage(usage, model ?? "unknown", providerMetadata);
  assert(displayUsage, "createDisplayUsage should return data for parsed usage payloads");

  const timestamp =
    toFiniteNumber(metadata.timestamp) ?? parseCreatedAtTimestamp(params.message.createdAt) ?? null;
  const dateBucket = dateBucketFromTimestamp(timestamp);

  const inputTokens = displayUsage.input.tokens;
  const outputTokens = displayUsage.output.tokens;
  const reasoningTokens = displayUsage.reasoning.tokens;
  const cachedTokens = displayUsage.cached.tokens;
  const cacheCreateTokens = displayUsage.cacheCreate.tokens;

  const inputCostUsd = displayUsage.input.cost_usd ?? 0;
  const outputCostUsd = displayUsage.output.cost_usd ?? 0;
  const reasoningCostUsd = displayUsage.reasoning.cost_usd ?? 0;
  const cachedCostUsd =
    (displayUsage.cached.cost_usd ?? 0) + (displayUsage.cacheCreate.cost_usd ?? 0);

  const durationMs = toFiniteNumber(metadata.duration);
  const ttftMs = extractTtftMs(metadata);
  const outputTps =
    durationMs !== null && durationMs > 0 ? outputTokens / (durationMs / 1000) : null;

  const maybeEvent = {
    workspace_id: params.workspaceId,
    project_path: params.workspaceMeta.projectPath ?? null,
    project_name: params.workspaceMeta.projectName ?? null,
    workspace_name: params.workspaceMeta.workspaceName ?? null,
    parent_workspace_id: params.workspaceMeta.parentWorkspaceId ?? null,
    agent_id: toOptionalString(metadata.agentId) ?? null,
    timestamp,
    model: model ?? null,
    thinking_level: toOptionalString(metadata.thinkingLevel) ?? null,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: reasoningTokens,
    cached_tokens: cachedTokens,
    cache_create_tokens: cacheCreateTokens,
    input_cost_usd: inputCostUsd,
    output_cost_usd: outputCostUsd,
    reasoning_cost_usd: reasoningCostUsd,
    cached_cost_usd: cachedCostUsd,
    total_cost_usd: inputCostUsd + outputCostUsd + reasoningCostUsd + cachedCostUsd,
    duration_ms: durationMs,
    ttft_ms: ttftMs,
    streaming_ms: null,
    tool_execution_ms: null,
    output_tps: outputTps,
    response_index: params.responseIndex,
    is_sub_agent: (params.workspaceMeta.parentWorkspaceId ?? "").length > 0,
  };

  const parsedEvent = EventRowSchema.safeParse(maybeEvent);
  if (!parsedEvent.success) {
    log.warn("[analytics-etl] Skipping invalid analytics row", {
      workspaceId: params.workspaceId,
      lineNumber: params.lineNumber,
      issues: parsedEvent.error.issues,
    });
    return null;
  }

  return {
    row: parsedEvent.data,
    sequence,
    date: dateBucket,
  };
}

async function readWatermark(
  conn: DuckDBConnection,
  workspaceId: string
): Promise<IngestWatermark> {
  const result = await conn.run(
    `SELECT last_sequence, last_modified FROM ingest_watermarks WHERE workspace_id = ?`,
    [workspaceId]
  );
  const rows = await result.getRowObjectsJS();

  if (rows.length === 0) {
    return { lastSequence: -1, lastModified: 0 };
  }

  const row = rows[0];
  const lastSequence = toFiniteNumber(row.last_sequence) ?? -1;
  const lastModified = toFiniteNumber(row.last_modified) ?? 0;

  return {
    lastSequence,
    lastModified,
  };
}

async function readWorkspaceEventRowCount(
  conn: DuckDBConnection,
  workspaceId: string
): Promise<number> {
  const result = await conn.run(`SELECT COUNT(*) AS row_count FROM events WHERE workspace_id = ?`, [
    workspaceId,
  ]);
  const rows = await result.getRowObjectsJS();
  assert(rows.length === 1, "readWorkspaceEventRowCount: expected exactly one COUNT(*) result row");

  const rowCount = toFiniteInteger(rows[0].row_count);
  assert(
    rowCount !== null && rowCount >= 0,
    "readWorkspaceEventRowCount: expected non-negative integer row_count"
  );

  return rowCount;
}

export async function clearWorkspaceAnalyticsState(
  conn: DuckDBConnection,
  workspaceId: string
): Promise<void> {
  assert(workspaceId.trim().length > 0, "clearWorkspaceAnalyticsState: workspaceId is required");

  await conn.run("BEGIN TRANSACTION");
  try {
    await conn.run("DELETE FROM events WHERE workspace_id = ?", [workspaceId]);
    await conn.run("DELETE FROM ingest_watermarks WHERE workspace_id = ?", [workspaceId]);
    await conn.run("DELETE FROM delegation_rollups WHERE parent_workspace_id = ?", [workspaceId]);
    await conn.run("COMMIT");
  } catch (error) {
    await conn.run("ROLLBACK");
    throw error;
  }
}

function serializeHeadSignatureValue(value: string | number | null): string {
  if (value === null) {
    return "null";
  }

  return `${typeof value}:${String(value)}`;
}

function createEventHeadSignature(parts: EventHeadSignatureParts): string {
  return [
    serializeHeadSignatureValue(parts.timestamp),
    serializeHeadSignatureValue(parts.model),
    serializeHeadSignatureValue(parts.totalCostUsd),
  ].join("|");
}

function createEventHeadSignatureFromParsedEvent(event: IngestEvent): string {
  const row = event.row;
  assert(
    Number.isFinite(row.total_cost_usd),
    "createEventHeadSignatureFromParsedEvent: expected finite total_cost_usd"
  );

  return createEventHeadSignature({
    timestamp: row.timestamp,
    model: row.model,
    totalCostUsd: row.total_cost_usd,
  });
}

async function readPersistedWorkspaceHeadSignature(
  conn: DuckDBConnection,
  workspaceId: string
): Promise<string | null> {
  const result = await conn.run(
    `
    SELECT timestamp, model, total_cost_usd
    FROM events
    WHERE workspace_id = ?
    ORDER BY response_index ASC NULLS LAST
    LIMIT 1
    `,
    [workspaceId]
  );
  const rows = await result.getRowObjectsJS();

  if (rows.length === 0) {
    return null;
  }

  assert(
    rows.length === 1,
    "readPersistedWorkspaceHeadSignature: expected zero or one persisted head row"
  );

  const row = rows[0] as Record<string, unknown>;
  const timestamp = toFiniteNumber(row.timestamp);
  assert(
    timestamp !== null || row.timestamp === null,
    "readPersistedWorkspaceHeadSignature: expected timestamp to be finite number or null"
  );

  const model = row.model;
  assert(
    model === null || typeof model === "string",
    "readPersistedWorkspaceHeadSignature: expected model to be string or null"
  );

  const totalCostUsd = toFiniteNumber(row.total_cost_usd);
  assert(
    totalCostUsd !== null || row.total_cost_usd === null,
    "readPersistedWorkspaceHeadSignature: expected total_cost_usd to be finite number or null"
  );

  return createEventHeadSignature({
    timestamp,
    model,
    totalCostUsd,
  });
}

function hasPersistedWatermark(watermark: IngestWatermark): boolean {
  return watermark.lastSequence >= 0 || watermark.lastModified > 0;
}

async function writeWatermark(
  conn: DuckDBConnection,
  workspaceId: string,
  watermark: IngestWatermark
): Promise<void> {
  await conn.run(
    `
    INSERT INTO ingest_watermarks (workspace_id, last_sequence, last_modified)
    VALUES (?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE
      SET last_sequence = excluded.last_sequence,
          last_modified = excluded.last_modified
    `,
    [workspaceId, watermark.lastSequence, watermark.lastModified]
  );
}

async function replaceEventsByResponseIndex(
  conn: DuckDBConnection,
  workspaceId: string,
  events: IngestEvent[]
): Promise<void> {
  if (events.length === 0) {
    return;
  }

  const responseIndexes: number[] = [];
  const seenResponseIndexes = new Set<number>();

  for (const event of events) {
    const row = event.row;
    assert(
      row.workspace_id === workspaceId,
      "replaceEventsByResponseIndex: all rows must belong to the target workspace"
    );
    const responseIndex = row.response_index;
    assert(responseIndex !== null, "replaceEventsByResponseIndex: response_index must be present");
    assert(
      Number.isInteger(responseIndex),
      "replaceEventsByResponseIndex: response_index must be an integer"
    );
    if (seenResponseIndexes.has(responseIndex)) {
      continue;
    }

    seenResponseIndexes.add(responseIndex);
    responseIndexes.push(responseIndex);
  }

  assert(
    responseIndexes.length > 0,
    "replaceEventsByResponseIndex: non-empty events must include response indexes"
  );

  const placeholders = responseIndexes.map(() => "?").join(", ");

  await conn.run("BEGIN TRANSACTION");
  try {
    // response_index is stable for in-place rewrites, so delete before insert to
    // ensure rewritten rows replace stale analytics entries instead of appending.
    await conn.run(
      `DELETE FROM events WHERE workspace_id = ? AND response_index IN (${placeholders})`,
      [workspaceId, ...responseIndexes]
    );

    for (const event of events) {
      const row = event.row;
      await conn.run(INSERT_EVENT_SQL, [
        row.workspace_id,
        row.project_path,
        row.project_name,
        row.workspace_name,
        row.parent_workspace_id,
        row.agent_id,
        row.timestamp,
        event.date,
        row.model,
        row.thinking_level,
        row.input_tokens,
        row.output_tokens,
        row.reasoning_tokens,
        row.cached_tokens,
        row.cache_create_tokens,
        row.input_cost_usd,
        row.output_cost_usd,
        row.reasoning_cost_usd,
        row.cached_cost_usd,
        row.total_cost_usd,
        row.duration_ms,
        row.ttft_ms,
        row.streaming_ms,
        row.tool_execution_ms,
        row.output_tps,
        row.response_index,
        row.is_sub_agent,
      ]);
    }

    await conn.run("COMMIT");
  } catch (error) {
    await conn.run("ROLLBACK");
    throw error;
  }
}

async function replaceWorkspaceEvents(
  conn: DuckDBConnection,
  workspaceId: string,
  events: IngestEvent[]
): Promise<void> {
  await conn.run("BEGIN TRANSACTION");
  try {
    await conn.run("DELETE FROM events WHERE workspace_id = ?", [workspaceId]);

    for (const event of events) {
      const row = event.row;
      assert(
        row.workspace_id === workspaceId,
        "replaceWorkspaceEvents: all rows must belong to the target workspace"
      );
      await conn.run(INSERT_EVENT_SQL, [
        row.workspace_id,
        row.project_path,
        row.project_name,
        row.workspace_name,
        row.parent_workspace_id,
        row.agent_id,
        row.timestamp,
        event.date,
        row.model,
        row.thinking_level,
        row.input_tokens,
        row.output_tokens,
        row.reasoning_tokens,
        row.cached_tokens,
        row.cache_create_tokens,
        row.input_cost_usd,
        row.output_cost_usd,
        row.reasoning_cost_usd,
        row.cached_cost_usd,
        row.total_cost_usd,
        row.duration_ms,
        row.ttft_ms,
        row.streaming_ms,
        row.tool_execution_ms,
        row.output_tps,
        row.response_index,
        row.is_sub_agent,
      ]);
    }

    await conn.run("COMMIT");
  } catch (error) {
    await conn.run("ROLLBACK");
    throw error;
  }
}

function getMaxSequence(events: IngestEvent[]): number | null {
  if (events.length === 0) {
    return null;
  }

  let maxSequence = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    maxSequence = Math.max(maxSequence, event.sequence);
  }

  assert(Number.isFinite(maxSequence), "getMaxSequence: expected finite max sequence");
  return maxSequence;
}

function shouldRebuildWorkspaceForSequenceRegression(params: {
  watermark: IngestWatermark;
  parsedMaxSequence: number | null;
  hasTruncation: boolean;
  hasHeadMismatch: boolean;
}): boolean {
  if (params.hasTruncation || params.hasHeadMismatch) {
    return true;
  }

  if (!hasPersistedWatermark(params.watermark)) {
    return false;
  }

  if (params.parsedMaxSequence === null) {
    return true;
  }

  return params.parsedMaxSequence < params.watermark.lastSequence;
}

export async function ingestWorkspace(
  conn: DuckDBConnection,
  workspaceId: string,
  sessionDir: string,
  meta: WorkspaceMeta
): Promise<void> {
  assert(workspaceId.trim().length > 0, "ingestWorkspace: workspaceId is required");
  assert(sessionDir.trim().length > 0, "ingestWorkspace: sessionDir is required");

  const chatPath = path.join(sessionDir, CHAT_FILE_NAME);

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(chatPath);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      // Remove stale analytics state when the workspace history file no longer exists.
      await clearWorkspaceAnalyticsState(conn, workspaceId);
      return;
    }

    throw error;
  }

  const watermark = await readWatermark(conn, workspaceId);
  const persistedMeta = await readWorkspaceMetaFromDisk(sessionDir);
  const workspaceMeta = mergeWorkspaceMeta(persistedMeta, meta);

  // Keep delegation rollups fresh even when chat.jsonl is unchanged.
  await ingestDelegationRollups(conn, workspaceId, sessionDir, workspaceMeta);

  if (stat.mtimeMs <= watermark.lastModified) {
    return;
  }

  const chatContents = await fs.readFile(chatPath, "utf-8");
  const lines = chatContents.split("\n").filter((line) => line.trim().length > 0);

  let responseIndex = 0;
  const parsedEvents: IngestEvent[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const message = parsePersistedMessage(lines[i], workspaceId, lineNumber);
    if (!message) {
      continue;
    }

    const event = extractIngestEvent({
      workspaceId,
      workspaceMeta,
      message,
      lineNumber,
      responseIndex,
    });
    if (!event) {
      continue;
    }

    assert(
      Number.isInteger(event.sequence),
      "ingestWorkspace: expected assistant event sequence to be an integer"
    );

    responseIndex += 1;
    parsedEvents.push(event);
  }

  const parsedMaxSequence = getMaxSequence(parsedEvents);
  const hasExistingWatermark = hasPersistedWatermark(watermark);
  const persistedEventRowCount = await readWorkspaceEventRowCount(conn, workspaceId);
  // Sequence-only checks miss truncations when the tail keeps the previous max
  // historySequence. If fewer assistant events are parsed than currently stored,
  // stale deleted rows remain unless we force a full workspace rebuild.
  const hasTruncation = hasExistingWatermark && parsedEvents.length < persistedEventRowCount;
  const persistedHeadSignature = hasExistingWatermark
    ? await readPersistedWorkspaceHeadSignature(conn, workspaceId)
    : null;
  const parsedHeadSignature =
    parsedEvents.length > 0 ? createEventHeadSignatureFromParsedEvent(parsedEvents[0]) : null;
  // Count checks can miss head truncation + append rewrites where assistant row
  // totals recover. Head signature drift reveals shifted response indexes.
  const hasHeadMismatch =
    hasExistingWatermark &&
    persistedHeadSignature !== null &&
    parsedHeadSignature !== null &&
    persistedHeadSignature !== parsedHeadSignature;

  const shouldRebuild = shouldRebuildWorkspaceForSequenceRegression({
    watermark,
    parsedMaxSequence,
    hasTruncation,
    hasHeadMismatch,
  });

  if (shouldRebuild) {
    // Rebuild on truncation, head mismatch, or max-sequence rewinds. This removes
    // stale rows, including the zero-assistant-event truncation case.
    await replaceWorkspaceEvents(conn, workspaceId, parsedEvents);

    await writeWatermark(conn, workspaceId, {
      lastSequence: parsedMaxSequence ?? -1,
      lastModified: stat.mtimeMs,
    });
  } else {
    let maxSequence = watermark.lastSequence;
    const eventsToInsert: IngestEvent[] = [];
    for (const event of parsedEvents) {
      maxSequence = Math.max(maxSequence, event.sequence);

      // Include the current watermark sequence so in-place rewrites with the same
      // historySequence refresh stale analytics rows instead of getting skipped forever.
      if (event.sequence < watermark.lastSequence) {
        continue;
      }

      eventsToInsert.push(event);
    }

    await replaceEventsByResponseIndex(conn, workspaceId, eventsToInsert);

    await writeWatermark(conn, workspaceId, {
      lastSequence: maxSequence,
      lastModified: stat.mtimeMs,
    });
  }

  // Also ingest archived sub-agent transcripts stored in this workspace's
  // session dir. This recovers sub-agent data that was cleared when the
  // child workspace was removed (clearWorkspace deletes child rows, but
  // the archived chat.jsonl in the parent dir is the source of truth).
  // Watermark dedup makes repeated calls cheap (stat + comparison only).
  const mergedMetaForChildren = mergeWorkspaceMeta(
    await readWorkspaceMetaFromDisk(sessionDir),
    meta
  );
  await ingestArchivedSubagentTranscripts(conn, sessionDir, mergedMetaForChildren, workspaceId);
}

/**
 * Scan a workspace's archived sub-agent transcripts and ingest each one.
 * The archive is flat: existing rollup logic in workspaceService copies
 * grandchild directories up to the parent level, so all descendants appear
 * as siblings under subagent-transcripts/.
 */
async function ingestArchivedSubagentTranscripts(
  conn: DuckDBConnection,
  sessionDir: string,
  parentMeta: WorkspaceMeta,
  parentWorkspaceId: string
): Promise<number> {
  const transcriptsDir = path.join(sessionDir, SUBAGENT_TRANSCRIPTS_DIR_NAME);

  let entries: Dirent[];
  try {
    entries = await fs.readdir(transcriptsDir, { withFileTypes: true });
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      // No archived transcripts directory — nothing to ingest.
      return 0;
    }

    log.warn("[analytics-etl] Failed to read archived sub-agent transcripts directory", {
      transcriptsDir,
      error: getErrorMessage(error),
    });
    return 0;
  }

  let ingested = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const childWorkspaceId = entry.name;
    const archivedSessionDir = path.join(transcriptsDir, childWorkspaceId);

    try {
      const archivedWorkspaceMeta = await readWorkspaceMetaFromDisk(archivedSessionDir);
      const overrideMeta: WorkspaceMeta = {
        projectPath: parentMeta.projectPath,
        projectName: parentMeta.projectName,
        workspaceName: archivedWorkspaceMeta.workspaceName,
      };

      // Archived transcripts created before workspace metadata persisted
      // parentWorkspaceId still represent sub-agent sessions. Only inject a
      // parent fallback when metadata is missing so we do not clobber the
      // correct parent for flattened descendants.
      if (!archivedWorkspaceMeta.parentWorkspaceId) {
        overrideMeta.parentWorkspaceId = parentWorkspaceId;
      }

      // Pass parent's projectPath/projectName so the child inherits
      // project-level attribution even if its own metadata.json is incomplete.
      await ingestWorkspace(conn, childWorkspaceId, archivedSessionDir, overrideMeta);
      ingested += 1;
    } catch (error) {
      log.warn("[analytics-etl] Failed to ingest archived sub-agent transcript", {
        childWorkspaceId,
        sessionDir,
        error: getErrorMessage(error),
      });
    }
  }

  return ingested;
}

/** Read session-usage.json and subagent-reports.json, then insert delegation_rollups rows. */
async function ingestDelegationRollups(
  conn: DuckDBConnection,
  workspaceId: string,
  sessionDir: string,
  workspaceMeta: WorkspaceMeta
): Promise<void> {
  const usagePath = path.join(sessionDir, SESSION_USAGE_FILE_NAME);
  let usageRaw: string;
  try {
    usageRaw = await fs.readFile(usagePath, "utf-8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      await conn.run("DELETE FROM delegation_rollups WHERE parent_workspace_id = ?", [workspaceId]);
      return;
    }
    log.warn("[analytics-etl] Failed to read session-usage.json for delegation rollups", {
      workspaceId,
      error: getErrorMessage(error),
    });
    await conn.run("DELETE FROM delegation_rollups WHERE parent_workspace_id = ?", [workspaceId]);
    return;
  }

  let usageData: unknown;
  try {
    usageData = JSON.parse(usageRaw);
  } catch {
    await conn.run("DELETE FROM delegation_rollups WHERE parent_workspace_id = ?", [workspaceId]);
    return;
  }
  if (!isRecord(usageData)) {
    await conn.run("DELETE FROM delegation_rollups WHERE parent_workspace_id = ?", [workspaceId]);
    return;
  }

  const rolledUpFrom = usageData.rolledUpFrom;
  if (!isRecord(rolledUpFrom) || Object.keys(rolledUpFrom).length === 0) {
    await conn.run("DELETE FROM delegation_rollups WHERE parent_workspace_id = ?", [workspaceId]);
    return;
  }

  // Read subagent-reports.json for reportTokenEstimate lookup
  const reportTokenByChildId = await readReportTokenEstimates(sessionDir);

  await conn.run("BEGIN TRANSACTION");
  try {
    await conn.run("DELETE FROM delegation_rollups WHERE parent_workspace_id = ?", [workspaceId]);

    for (const [childId, entry] of Object.entries(rolledUpFrom)) {
      // Skip legacy boolean entries
      if (entry === true || !isRecord(entry)) continue;

      const totalTokens = toFiniteInteger(entry.totalTokens) ?? 0;
      const contextTokens = toFiniteInteger(entry.contextTokens) ?? 0;
      const inputTokens = toFiniteInteger(entry.inputTokens) ?? 0;
      const outputTokens = toFiniteInteger(entry.outputTokens) ?? 0;
      const reasoningTokens = toFiniteInteger(entry.reasoningTokens) ?? 0;
      const cachedTokens = toFiniteInteger(entry.cachedTokens) ?? 0;
      const cacheCreateTokens = toFiniteInteger(entry.cacheCreateTokens) ?? 0;
      const totalCostUsd = toFiniteNumber(entry.totalCostUsd) ?? 0;
      const agentType = toOptionalString(entry.agentType) ?? null;
      const model = toOptionalString(entry.model) ?? null;
      const rolledUpAtMs = toFiniteNumber(entry.rolledUpAtMs) ?? null;
      const reportTokenEstimate = reportTokenByChildId.get(childId) ?? 0;
      const dateBucket = dateBucketFromTimestamp(rolledUpAtMs);

      await conn.run(INSERT_DELEGATION_ROLLUP_SQL, [
        workspaceId,
        childId,
        workspaceMeta.projectPath ?? null,
        workspaceMeta.projectName ?? null,
        agentType,
        model,
        totalTokens,
        contextTokens,
        inputTokens,
        outputTokens,
        reasoningTokens,
        cachedTokens,
        cacheCreateTokens,
        reportTokenEstimate,
        totalCostUsd,
        rolledUpAtMs,
        dateBucket,
      ]);
    }
    await conn.run("COMMIT");
  } catch (error) {
    await conn.run("ROLLBACK");
    throw error;
  }
}

async function readReportTokenEstimates(sessionDir: string): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const reportsPath = path.join(sessionDir, SUBAGENT_REPORTS_FILE_NAME);
  try {
    const raw = await fs.readFile(reportsPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return result;
    const artifacts = parsed.artifactsByChildTaskId;
    if (!isRecord(artifacts)) return result;
    for (const [childId, artifact] of Object.entries(artifacts)) {
      if (!isRecord(artifact)) continue;
      const estimate = toFiniteInteger(artifact.reportTokenEstimate);
      if (estimate != null && estimate > 0) {
        result.set(childId, estimate);
      }
    }
  } catch {
    // Missing or invalid file — not an error, just no report data.
  }
  return result;
}

export async function rebuildAll(
  conn: DuckDBConnection,
  sessionsDir: string,
  workspaceMetaById: WorkspaceMetaById = {}
): Promise<{ workspacesIngested: number }> {
  assert(sessionsDir.trim().length > 0, "rebuildAll: sessionsDir is required");
  assert(
    isRecord(workspaceMetaById) && !Array.isArray(workspaceMetaById),
    "rebuildAll: workspaceMetaById must be an object"
  );

  await conn.run("BEGIN TRANSACTION");
  try {
    // Reset analytics tables atomically so a crash cannot leave empty events with
    // stale watermarks or stale delegation rollups that suppress rebuild accuracy.
    await conn.run("DELETE FROM events");
    await conn.run("DELETE FROM ingest_watermarks");
    await conn.run("DELETE FROM delegation_rollups");
    await conn.run("COMMIT");
  } catch (error) {
    await conn.run("ROLLBACK");
    throw error;
  }

  let entries: Dirent[] | null = null;
  try {
    entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { workspacesIngested: 0 };
    }

    throw error;
  }

  assert(entries, "rebuildAll expected a directory listing");

  let workspacesIngested = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const workspaceId = entry.name;
    const sessionDir = path.join(sessionsDir, workspaceId);
    const suppliedWorkspaceMeta = workspaceMetaById[workspaceId] ?? {};

    try {
      await ingestWorkspace(conn, workspaceId, sessionDir, suppliedWorkspaceMeta);
      workspacesIngested += 1;
    } catch (error) {
      log.warn("[analytics-etl] Failed to ingest workspace during rebuild", {
        workspaceId,
        error: getErrorMessage(error),
      });
    }
  }

  return { workspacesIngested };
}

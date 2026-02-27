import assert from "node:assert/strict";
import type { DuckDBConnection, DuckDBValue } from "@duckdb/node-api";
import type { z } from "zod";
import {
  AgentCostRowSchema,
  DelegationAgentBreakdownRowSchema,
  DelegationSummaryTotalsRowSchema,
  HistogramBucketSchema,
  ProviderCacheHitModelRowSchema,
  SpendByModelRowSchema,
  SpendByProjectRowSchema,
  SpendOverTimeRowSchema,
  SummaryRowSchema,
  TimingPercentilesRowSchema,
  TokensByModelRowSchema,
  type AgentCostRow,
  type DelegationAgentBreakdownRow,
  type DelegationSummaryTotalsRow,
  type HistogramBucket,
  type ProviderCacheHitModelRow,
  type SpendByModelRow,
  type SpendByProjectRow,
  type SpendOverTimeRow,
  type SummaryRow,
  type TimingPercentilesRow,
  type TokensByModelRow,
} from "@/common/orpc/schemas/analytics";

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

type Granularity = "hour" | "day" | "week";
type TimingMetric = "ttft" | "duration" | "tps";

interface TimingDistributionResult {
  percentiles: TimingPercentilesRow;
  histogram: HistogramBucket[];
}

interface DelegationSummaryResult {
  totals: DelegationSummaryTotalsRow;
  breakdown: DelegationAgentBreakdownRow[];
}

function normalizeDuckDbValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    assert(
      value <= MAX_SAFE_BIGINT && value >= MIN_SAFE_BIGINT,
      `DuckDB bigint out of JS safe integer range: ${value}`
    );
    return Number(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
}

function normalizeDuckDbRow(row: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    normalized[key] = normalizeDuckDbValue(value);
  }

  return normalized;
}

async function typedQuery<T>(
  conn: DuckDBConnection,
  sql: string,
  params: DuckDBValue[],
  schema: z.ZodType<T>
): Promise<T[]> {
  const result = await conn.run(sql, params);
  const rows = await result.getRowObjectsJS();

  return rows.map((row) => schema.parse(normalizeDuckDbRow(row)));
}

async function typedQueryOne<T>(
  conn: DuckDBConnection,
  sql: string,
  params: DuckDBValue[],
  schema: z.ZodType<T>
): Promise<T> {
  const rows = await typedQuery(conn, sql, params, schema);
  assert(rows.length === 1, `Expected one row, got ${rows.length}`);
  return rows[0];
}

function parseOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseDateFilter(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    assert(Number.isFinite(value.getTime()), "Invalid Date provided for analytics filter");
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    // Accept either full ISO timestamps or YYYY-MM-DD and normalize to YYYY-MM-DD.
    const parsed = new Date(trimmed);
    assert(Number.isFinite(parsed.getTime()), `Invalid date filter value: ${trimmed}`);
    return parsed.toISOString().slice(0, 10);
  }

  throw new Error("Unsupported analytics date filter type");
}

function parseGranularity(value: unknown): Granularity {
  assert(
    value === "hour" || value === "day" || value === "week",
    `Invalid granularity: ${String(value)}`
  );
  return value;
}

function parseTimingMetric(value: unknown): TimingMetric {
  assert(
    value === "ttft" || value === "duration" || value === "tps",
    `Invalid timing metric: ${String(value)}`
  );
  return value;
}

function getTodayUtcDateString(now: Date = new Date()): string {
  assert(Number.isFinite(now.getTime()), "Invalid Date while computing analytics summary date");
  return now.toISOString().slice(0, 10);
}

async function querySummary(
  conn: DuckDBConnection,
  params: {
    projectPath: string | null;
    from: string | null;
    to: string | null;
  }
): Promise<SummaryRow> {
  // events.date is derived from message timestamps via UTC date buckets, so
  // summary "today" must use a UTC date key instead of DuckDB local CURRENT_DATE.
  const todayUtcDate = getTodayUtcDateString();

  return typedQueryOne(
    conn,
    `
    SELECT
      COALESCE(SUM(total_cost_usd), 0) AS total_spend_usd,
      COALESCE(SUM(CASE WHEN date = CAST(? AS DATE) THEN total_cost_usd ELSE 0 END), 0) AS today_spend_usd,
      COALESCE(
        COALESCE(SUM(total_cost_usd), 0) / NULLIF(COUNT(DISTINCT date), 0),
        0
      ) AS avg_daily_spend_usd,
      COALESCE(
        SUM(cached_tokens)::DOUBLE / NULLIF(SUM(input_tokens + cached_tokens + cache_create_tokens), 0),
        0
      ) AS cache_hit_ratio,
      COALESCE(
        SUM(input_tokens + output_tokens + reasoning_tokens + cached_tokens + cache_create_tokens),
        0
      ) AS total_tokens,
      COALESCE(COUNT(*), 0) AS total_responses
    FROM events
    WHERE (? IS NULL OR project_path = ?)
      AND (? IS NULL OR date >= CAST(? AS DATE))
      AND (? IS NULL OR date <= CAST(? AS DATE))
    `,
    [
      todayUtcDate,
      params.projectPath,
      params.projectPath,
      params.from,
      params.from,
      params.to,
      params.to,
    ],
    SummaryRowSchema
  );
}

async function querySpendOverTime(
  conn: DuckDBConnection,
  params: {
    granularity: Granularity;
    projectPath: string | null;
    from: string | null;
    to: string | null;
  }
): Promise<SpendOverTimeRow[]> {
  const bucketExpression: Record<Granularity, string> = {
    hour: "DATE_TRUNC('hour', to_timestamp(timestamp / 1000.0))",
    day: "DATE_TRUNC('day', date)",
    week: "DATE_TRUNC('week', date)",
  };

  const bucketExpr = bucketExpression[params.granularity];
  const bucketNullFilter =
    params.granularity === "hour" ? "AND timestamp IS NOT NULL" : "AND date IS NOT NULL";

  return typedQuery(
    conn,
    `
    SELECT
      CAST(${bucketExpr} AS VARCHAR) AS bucket,
      COALESCE(model, 'unknown') AS model,
      COALESCE(SUM(total_cost_usd), 0) AS cost_usd
    FROM events
    WHERE
      (? IS NULL OR project_path = ?)
      AND (? IS NULL OR date >= CAST(? AS DATE))
      AND (? IS NULL OR date <= CAST(? AS DATE))
      ${bucketNullFilter}
    GROUP BY 1, 2
    ORDER BY 1 ASC, 2 ASC
    `,
    [params.projectPath, params.projectPath, params.from, params.from, params.to, params.to],
    SpendOverTimeRowSchema
  );
}

async function querySpendByProject(
  conn: DuckDBConnection,
  params: { from: string | null; to: string | null }
): Promise<SpendByProjectRow[]> {
  return typedQuery(
    conn,
    `
    SELECT
      COALESCE(project_name, 'unknown') AS project_name,
      COALESCE(project_path, 'unknown') AS project_path,
      COALESCE(SUM(total_cost_usd), 0) AS cost_usd,
      COALESCE(
        SUM(input_tokens + output_tokens + reasoning_tokens + cached_tokens + cache_create_tokens),
        0
      ) AS token_count
    FROM events
    WHERE (? IS NULL OR date >= CAST(? AS DATE))
      AND (? IS NULL OR date <= CAST(? AS DATE))
    GROUP BY 1, 2
    ORDER BY cost_usd DESC
    `,
    [params.from, params.from, params.to, params.to],
    SpendByProjectRowSchema
  );
}

async function querySpendByModel(
  conn: DuckDBConnection,
  projectPath: string | null,
  from: string | null,
  to: string | null
): Promise<SpendByModelRow[]> {
  return typedQuery(
    conn,
    `
    SELECT
      COALESCE(model, 'unknown') AS model,
      COALESCE(SUM(total_cost_usd), 0) AS cost_usd,
      COALESCE(
        SUM(input_tokens + output_tokens + reasoning_tokens + cached_tokens + cache_create_tokens),
        0
      ) AS token_count,
      COALESCE(COUNT(*), 0) AS response_count
    FROM events
    WHERE (? IS NULL OR project_path = ?)
      AND (? IS NULL OR date >= CAST(? AS DATE))
      AND (? IS NULL OR date <= CAST(? AS DATE))
    GROUP BY 1
    ORDER BY cost_usd DESC
    `,
    [projectPath, projectPath, from, from, to, to],
    SpendByModelRowSchema
  );
}

async function queryTokensByModel(
  conn: DuckDBConnection,
  projectPath: string | null,
  from: string | null,
  to: string | null
): Promise<TokensByModelRow[]> {
  return typedQuery(
    conn,
    `
    SELECT
      COALESCE(model, 'unknown') AS model,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
      COALESCE(SUM(cache_create_tokens), 0) AS cache_create_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
      COALESCE(SUM(
        COALESCE(input_tokens, 0) + COALESCE(cached_tokens, 0) + COALESCE(cache_create_tokens, 0)
        + COALESCE(output_tokens, 0) + COALESCE(reasoning_tokens, 0)
      ), 0) AS total_tokens,
      COALESCE(COUNT(*), 0) AS request_count
    FROM events
    WHERE (? IS NULL OR project_path = ?)
      AND (? IS NULL OR date >= CAST(? AS DATE))
      AND (? IS NULL OR date <= CAST(? AS DATE))
    GROUP BY 1
    ORDER BY total_tokens DESC
    LIMIT 10
    `,
    [projectPath, projectPath, from, from, to, to],
    TokensByModelRowSchema
  );
}

async function queryTimingDistribution(
  conn: DuckDBConnection,
  metric: TimingMetric,
  projectPath: string | null,
  from: string | null,
  to: string | null
): Promise<TimingDistributionResult> {
  const columnByMetric: Record<TimingMetric, string> = {
    ttft: "ttft_ms",
    duration: "duration_ms",
    tps: "output_tps",
  };

  const column = columnByMetric[metric];

  const percentiles = await typedQueryOne(
    conn,
    `
    SELECT
      COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${column}), 0) AS p50,
      COALESCE(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY ${column}), 0) AS p90,
      COALESCE(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY ${column}), 0) AS p99
    FROM events
    WHERE ${column} IS NOT NULL
      AND (? IS NULL OR project_path = ?)
      AND (? IS NULL OR date >= CAST(? AS DATE))
      AND (? IS NULL OR date <= CAST(? AS DATE))
    `,
    [projectPath, projectPath, from, from, to, to],
    TimingPercentilesRowSchema
  );

  // Histogram emits real metric values (e.g. ms, tok/s) as bucket labels,
  // not abstract 1..20 indices. This way the chart x-axis maps directly to
  // meaningful units and percentile reference lines land correctly.
  //
  // Cap the histogram range at p99 so a single extreme outlier does not flatten
  // the distribution for the other 99% of responses. If p99 collapses to min
  // (for near-constant datasets), fall back to raw max to preserve bucket spread.
  const histogram = await typedQuery(
    conn,
    `
    WITH raw_stats AS (
      SELECT
        MIN(${column}) AS min_value,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY ${column}) AS p99_value,
        MAX(${column}) AS raw_max_value
      FROM events
      WHERE ${column} IS NOT NULL
        AND (? IS NULL OR project_path = ?)
        AND (? IS NULL OR date >= CAST(? AS DATE))
        AND (? IS NULL OR date <= CAST(? AS DATE))
    ),
    stats AS (
      SELECT
        min_value,
        CASE
          -- If p99 collapses to the minimum (e.g. >99% identical values),
          -- fall back to the raw max so outliers do not get forced into bucket 1.
          WHEN p99_value = min_value AND raw_max_value > p99_value THEN raw_max_value
          ELSE p99_value
        END AS max_value
      FROM raw_stats
    ),
    bucketed AS (
      SELECT
        CASE
          WHEN stats.min_value IS NULL OR stats.max_value IS NULL THEN NULL
          WHEN stats.max_value = stats.min_value THEN 1
          ELSE LEAST(
            20,
            GREATEST(
              1,
              CAST(
                FLOOR(
                  ((events.${column} - stats.min_value) / NULLIF(stats.max_value - stats.min_value, 0)) * 20
                ) AS INTEGER
              ) + 1
            )
          )
        END AS bucket_id
      FROM events
      CROSS JOIN stats
      WHERE events.${column} IS NOT NULL
        AND (? IS NULL OR events.project_path = ?)
        AND (? IS NULL OR events.date >= CAST(? AS DATE))
        AND (? IS NULL OR events.date <= CAST(? AS DATE))
    )
    SELECT
      COALESCE(
        ROUND(
          (SELECT min_value FROM stats) +
          (bucket_id - 0.5) * (
            NULLIF((SELECT max_value FROM stats) - (SELECT min_value FROM stats), 0) / 20.0
          ),
          2
        ),
        -- When min == max (single distinct value), NULLIF produces NULL.
        -- Fall back to the actual value so the bucket label is meaningful.
        ROUND((SELECT min_value FROM stats), 2)
      ) AS bucket,
      COUNT(*) AS count
    FROM bucketed
    WHERE bucket_id IS NOT NULL
    GROUP BY bucket_id
    ORDER BY bucket_id
    `,
    [projectPath, projectPath, from, from, to, to, projectPath, projectPath, from, from, to, to],
    HistogramBucketSchema
  );

  return {
    percentiles,
    histogram,
  };
}

async function queryAgentCostBreakdown(
  conn: DuckDBConnection,
  projectPath: string | null,
  from: string | null,
  to: string | null
): Promise<AgentCostRow[]> {
  return typedQuery(
    conn,
    `
    SELECT
      COALESCE(agent_id, 'unknown') AS agent_id,
      COALESCE(SUM(total_cost_usd), 0) AS cost_usd,
      COALESCE(
        SUM(input_tokens + output_tokens + reasoning_tokens + cached_tokens + cache_create_tokens),
        0
      ) AS token_count,
      COALESCE(COUNT(*), 0) AS response_count
    FROM events
    WHERE (? IS NULL OR project_path = ?)
      AND (? IS NULL OR date >= CAST(? AS DATE))
      AND (? IS NULL OR date <= CAST(? AS DATE))
    GROUP BY 1
    ORDER BY cost_usd DESC
    `,
    [projectPath, projectPath, from, from, to, to],
    AgentCostRowSchema
  );
}

async function queryCacheHitRatioByProvider(
  conn: DuckDBConnection,
  projectPath: string | null,
  from: string | null,
  to: string | null
): Promise<ProviderCacheHitModelRow[]> {
  return typedQuery(
    conn,
    `
    SELECT
      COALESCE(model, 'unknown') AS model,
      COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
      COALESCE(SUM(input_tokens + cached_tokens + cache_create_tokens), 0) AS total_prompt_tokens,
      COALESCE(COUNT(*), 0) AS response_count
    FROM events
    WHERE (? IS NULL OR project_path = ?)
      AND (? IS NULL OR date >= CAST(? AS DATE))
      AND (? IS NULL OR date <= CAST(? AS DATE))
    GROUP BY 1
    ORDER BY response_count DESC
    `,
    [projectPath, projectPath, from, from, to, to],
    ProviderCacheHitModelRowSchema
  );
}

async function queryDelegationSummary(
  conn: DuckDBConnection,
  params: { projectPath: string | null; from: string | null; to: string | null }
): Promise<DelegationSummaryResult> {
  const filterParams: DuckDBValue[] = [
    params.projectPath,
    params.projectPath,
    params.from,
    params.from,
    params.to,
    params.to,
  ];

  const whereClause = `
    WHERE (? IS NULL OR project_path = ?)
      AND (? IS NULL OR date >= CAST(? AS DATE))
      AND (? IS NULL OR date <= CAST(? AS DATE))
  `;

  const totals = await typedQueryOne(
    conn,
    `
    SELECT
      COALESCE(COUNT(*), 0) AS total_children,
      COALESCE(SUM(total_tokens), 0) AS total_tokens_consumed,
      COALESCE(SUM(report_token_estimate), 0) AS total_report_tokens,
      COALESCE(
        CASE
          WHEN SUM(CASE WHEN report_token_estimate > 0 THEN report_token_estimate ELSE 0 END) = 0 THEN 0
          ELSE SUM(CASE WHEN report_token_estimate > 0 THEN total_tokens ELSE 0 END)::DOUBLE
               / SUM(CASE WHEN report_token_estimate > 0 THEN report_token_estimate ELSE 0 END)
        END,
        0
      ) AS compression_ratio,
      COALESCE(SUM(total_cost_usd), 0) AS total_cost_delegated
    FROM delegation_rollups
    ${whereClause}
    `,
    [...filterParams],
    DelegationSummaryTotalsRowSchema
  );

  const breakdown = await typedQuery(
    conn,
    `
    SELECT
      COALESCE(agent_type, 'unknown') AS agent_type,
      COALESCE(COUNT(*), 0) AS delegation_count,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
      COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
      COALESCE(SUM(cache_create_tokens), 0) AS cache_create_tokens
    FROM delegation_rollups
    ${whereClause}
    GROUP BY agent_type
    ORDER BY total_tokens DESC
    `,
    [...filterParams],
    DelegationAgentBreakdownRowSchema
  );

  return { totals, breakdown };
}

export async function executeNamedQuery(
  conn: DuckDBConnection,
  queryName: string,
  params: Record<string, unknown>
): Promise<unknown> {
  switch (queryName) {
    case "getSummary": {
      return querySummary(conn, {
        projectPath: parseOptionalString(params.projectPath),
        from: parseDateFilter(params.from),
        to: parseDateFilter(params.to),
      });
    }

    case "getSpendOverTime": {
      return querySpendOverTime(conn, {
        granularity: parseGranularity(params.granularity),
        projectPath: parseOptionalString(params.projectPath),
        from: parseDateFilter(params.from),
        to: parseDateFilter(params.to),
      });
    }

    case "getSpendByProject": {
      return querySpendByProject(conn, {
        from: parseDateFilter(params.from),
        to: parseDateFilter(params.to),
      });
    }

    case "getSpendByModel": {
      return querySpendByModel(
        conn,
        parseOptionalString(params.projectPath),
        parseDateFilter(params.from),
        parseDateFilter(params.to)
      );
    }

    case "getTokensByModel": {
      return queryTokensByModel(
        conn,
        parseOptionalString(params.projectPath),
        parseDateFilter(params.from),
        parseDateFilter(params.to)
      );
    }

    case "getTimingDistribution": {
      return queryTimingDistribution(
        conn,
        parseTimingMetric(params.metric),
        parseOptionalString(params.projectPath),
        parseDateFilter(params.from),
        parseDateFilter(params.to)
      );
    }

    case "getAgentCostBreakdown": {
      return queryAgentCostBreakdown(
        conn,
        parseOptionalString(params.projectPath),
        parseDateFilter(params.from),
        parseDateFilter(params.to)
      );
    }

    case "getCacheHitRatioByProvider": {
      return queryCacheHitRatioByProvider(
        conn,
        parseOptionalString(params.projectPath),
        parseDateFilter(params.from),
        parseDateFilter(params.to)
      );
    }

    case "getDelegationSummary": {
      return queryDelegationSummary(conn, {
        projectPath: parseOptionalString(params.projectPath),
        from: parseDateFilter(params.from),
        to: parseDateFilter(params.to),
      });
    }

    default:
      throw new Error(`Unknown analytics query: ${queryName}`);
  }
}

export const RAW_QUERY_ROW_LIMIT = 10_000;

export interface RawQueryColumn {
  name: string;
  type: string;
}

export interface RawQueryResult {
  columns: RawQueryColumn[];
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
  rowCount: number;
  durationMs: number;
}

const RAW_QUERY_ALLOWED_TABLES = new Set(["events", "delegation_rollups"]);
const RAW_QUERY_ALLOWED_TABLE_NAMES = Array.from(RAW_QUERY_ALLOWED_TABLES).join(", ");

interface RawQueryDisallowedPattern {
  label: string;
  pattern: RegExp;
}

const RAW_QUERY_DISALLOWED_PATTERNS: RawQueryDisallowedPattern[] = [
  { label: "read_csv", pattern: /\bread_csv\s*\(/i },
  { label: "read_csv_auto", pattern: /\bread_csv_auto\s*\(/i },
  { label: "read_parquet", pattern: /\bread_parquet\s*\(/i },
  { label: "read_json", pattern: /\bread_json\s*\(/i },
  { label: "read_json_auto", pattern: /\bread_json_auto\s*\(/i },
  { label: "read_ndjson", pattern: /\bread_ndjson\s*\(/i },
  { label: "read_ndjson_auto", pattern: /\bread_ndjson_auto\s*\(/i },
  { label: "read_blob", pattern: /\bread_blob\s*\(/i },
  { label: "read_text", pattern: /\bread_text\s*\(/i },
  { label: "http_get", pattern: /\bhttp_get\s*\(/i },
  { label: "http_post", pattern: /\bhttp_post\s*\(/i },
  { label: "glob", pattern: /\bglob\s*\(/i },
  { label: "list_files", pattern: /\blist_files\s*\(/i },
  { label: "scan_*", pattern: /\b[a-zA-Z_][a-zA-Z0-9_]*_scan\s*\(/i },
  { label: "COPY", pattern: /(^|[;(])\s*copy\b/i },
  { label: "EXPORT", pattern: /(^|[;(])\s*export\b/i },
  { label: "IMPORT", pattern: /(^|[;(])\s*import\b/i },
  { label: "ATTACH", pattern: /(^|[;(])\s*attach\b/i },
  { label: "DETACH", pattern: /(^|[;(])\s*detach\b/i },
  { label: "INSTALL", pattern: /(^|[;(])\s*install\b/i },
  { label: "LOAD", pattern: /(^|[;(])\s*load\b/i },
  { label: "PRAGMA", pattern: /(^|[;(])\s*pragma\b/i },
  { label: "SET", pattern: /(^|[;(])\s*set\b/i },
];

const RAW_QUERY_FROM_CLAUSE_BOUNDARY_KEYWORDS = new Set([
  "where",
  "group",
  "order",
  "having",
  "limit",
  "qualify",
  "window",
  "union",
  "intersect",
  "except",
]);

const RAW_QUERY_RELATION_PREFIX_KEYWORDS = new Set(["lateral"]);

interface ParsedSqlToken {
  value: string;
  nextIndex: number;
}

interface RawQueryRelationSource {
  source: string;
  isFunctionCall: boolean;
  isQualifiedName: boolean;
}

interface RawQueryRelationSourceWithDepth extends RawQueryRelationSource {
  depth: number;
}

interface ParsedRawQueryRelationSource extends RawQueryRelationSource {
  nextIndex: number;
}

interface RawQueryFromClauseContext {
  depth: number;
  expectingSource: boolean;
}

function skipSqlWhitespace(sql: string, startIndex: number): number {
  let index = startIndex;
  while (index < sql.length && /\s/.test(sql[index])) {
    index += 1;
  }
  return index;
}

function isSqlIdentifierStart(char: string): boolean {
  return /[a-zA-Z_]/.test(char);
}

function isSqlIdentifierPart(char: string): boolean {
  return /[a-zA-Z0-9_$]/.test(char);
}

function parseUnquotedSqlToken(sql: string, startIndex: number): ParsedSqlToken | null {
  const firstChar = sql[startIndex];
  if (firstChar == null || !isSqlIdentifierStart(firstChar)) {
    return null;
  }

  let index = startIndex + 1;
  while (index < sql.length && isSqlIdentifierPart(sql[index])) {
    index += 1;
  }

  return {
    value: sql.slice(startIndex, index),
    nextIndex: index,
  };
}

function parseSqlIdentifier(sql: string, startIndex: number): ParsedSqlToken | null {
  if (sql[startIndex] !== '"') {
    return parseUnquotedSqlToken(sql, startIndex);
  }

  let index = startIndex + 1;
  while (index < sql.length) {
    if (sql[index] !== '"') {
      index += 1;
      continue;
    }

    if (sql[index + 1] === '"') {
      index += 2;
      continue;
    }

    return {
      value: sql.slice(startIndex, index + 1),
      nextIndex: index + 1,
    };
  }

  throw new Error("Raw analytics query contains unterminated quoted identifier");
}

function normalizeSqlIdentifier(identifier: string): string {
  const trimmed = identifier.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replaceAll('""', '"').toLowerCase();
  }

  return trimmed.toLowerCase();
}

function normalizeQualifiedSqlIdentifier(identifier: string): string {
  const segments = identifier.split(".").map((segment) => normalizeSqlIdentifier(segment));
  assert(segments.length > 0, "Raw analytics query identifier must have at least one segment");
  const lastSegment = segments.at(-1);
  assert(lastSegment != null, "Raw analytics query identifier must include a table name");
  return lastSegment;
}

function parseRawQueryRelationSource(
  sql: string,
  startIndex: number
): ParsedRawQueryRelationSource | null {
  let index = skipSqlWhitespace(sql, startIndex);
  const firstSegment = parseSqlIdentifier(sql, index);
  if (firstSegment == null) {
    return null;
  }

  let source = firstSegment.value;
  let segmentCount = 1;
  index = skipSqlWhitespace(sql, firstSegment.nextIndex);

  while (sql[index] === ".") {
    index = skipSqlWhitespace(sql, index + 1);
    const segment = parseSqlIdentifier(sql, index);
    if (segment == null) {
      throw new Error("Raw analytics query contains malformed qualified table reference");
    }

    segmentCount += 1;
    source = `${source}.${segment.value}`;
    index = skipSqlWhitespace(sql, segment.nextIndex);
  }

  return {
    source,
    isFunctionCall: sql[index] === "(",
    isQualifiedName: segmentCount > 1,
    nextIndex: index,
  };
}

function collectRawQueryRelationSources(maskedSql: string): RawQueryRelationSourceWithDepth[] {
  const sources: RawQueryRelationSourceWithDepth[] = [];
  const fromClauseContexts: RawQueryFromClauseContext[] = [];

  let depth = 0;
  let index = 0;

  while (index < maskedSql.length) {
    index = skipSqlWhitespace(maskedSql, index);
    if (index >= maskedSql.length) {
      break;
    }

    const currentContext = fromClauseContexts.at(-1);
    const currentContextAtDepth = currentContext?.depth === depth ? currentContext : null;
    const char = maskedSql[index];

    if (char === "(") {
      if (currentContextAtDepth?.expectingSource) {
        currentContextAtDepth.expectingSource = false;
      }

      depth += 1;
      index += 1;
      continue;
    }

    if (char === ")") {
      depth = Math.max(0, depth - 1);
      while (fromClauseContexts.length > 0 && fromClauseContexts.at(-1)!.depth > depth) {
        fromClauseContexts.pop();
      }
      index += 1;
      continue;
    }

    if (char === "," && currentContextAtDepth != null) {
      currentContextAtDepth.expectingSource = true;
      index += 1;
      continue;
    }

    const token = parseUnquotedSqlToken(maskedSql, index);
    if (token == null) {
      if (currentContextAtDepth?.expectingSource) {
        const source = parseRawQueryRelationSource(maskedSql, index);
        if (source != null) {
          sources.push({
            source: source.source,
            isFunctionCall: source.isFunctionCall,
            isQualifiedName: source.isQualifiedName,
            depth,
          });
          currentContextAtDepth.expectingSource = false;
          index = source.nextIndex;
          continue;
        }
      }

      index += 1;
      continue;
    }

    const keyword = token.value.toLowerCase();

    if (keyword === "from") {
      fromClauseContexts.push({
        depth,
        expectingSource: true,
      });
      index = token.nextIndex;
      continue;
    }

    const activeContext = fromClauseContexts.at(-1);
    const activeContextAtDepth = activeContext?.depth === depth ? activeContext : null;

    if (activeContextAtDepth != null) {
      if (RAW_QUERY_FROM_CLAUSE_BOUNDARY_KEYWORDS.has(keyword)) {
        fromClauseContexts.pop();
        index = token.nextIndex;
        continue;
      }

      if (keyword === "join") {
        activeContextAtDepth.expectingSource = true;
        index = token.nextIndex;
        continue;
      }

      if (activeContextAtDepth.expectingSource) {
        if (RAW_QUERY_RELATION_PREFIX_KEYWORDS.has(keyword)) {
          index = token.nextIndex;
          continue;
        }

        const source = parseRawQueryRelationSource(maskedSql, index);
        if (source != null) {
          sources.push({
            source: source.source,
            isFunctionCall: source.isFunctionCall,
            isQualifiedName: source.isQualifiedName,
            depth,
          });
          activeContextAtDepth.expectingSource = false;
          index = source.nextIndex;
          continue;
        }
      }
    }

    index = token.nextIndex;
  }

  return sources;
}

function maskSqlCommentsAndStringLiterals(sql: string): string {
  const characters = Array.from(sql);
  let index = 0;

  while (index < characters.length) {
    const char = characters[index];
    const nextChar = characters[index + 1];

    if (char === "'") {
      characters[index] = " ";
      index += 1;
      while (index < characters.length) {
        const current = characters[index];
        const following = characters[index + 1];
        characters[index] = " ";
        if (current === "'" && following === "'") {
          characters[index + 1] = " ";
          index += 2;
          continue;
        }

        index += 1;
        if (current === "'") {
          break;
        }
      }
      continue;
    }

    if (char === "-" && nextChar === "-") {
      characters[index] = " ";
      characters[index + 1] = " ";
      index += 2;
      while (index < characters.length && characters[index] !== "\n") {
        characters[index] = " ";
        index += 1;
      }
      continue;
    }

    if (char === "/" && nextChar === "*") {
      characters[index] = " ";
      characters[index + 1] = " ";
      index += 2;
      while (index < characters.length) {
        if (characters[index] === "*" && characters[index + 1] === "/") {
          characters[index] = " ";
          characters[index + 1] = " ";
          index += 2;
          break;
        }

        characters[index] = " ";
        index += 1;
      }
      continue;
    }

    index += 1;
  }

  return characters.join("");
}

function skipBalancedParentheses(sql: string, startIndex: number): number {
  assert(sql[startIndex] === "(", "Expected open parenthesis while parsing raw analytics SQL");

  let depth = 0;
  let index = startIndex;

  while (index < sql.length) {
    const char = sql[index];

    if (char === '"') {
      const quotedIdentifier = parseSqlIdentifier(sql, index);
      assert(
        quotedIdentifier != null,
        "Expected quoted identifier while parsing raw analytics SQL"
      );
      index = quotedIdentifier.nextIndex;
      continue;
    }

    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }

    index += 1;
  }

  throw new Error("Raw analytics query contains unbalanced parentheses");
}

function parseRawQueryWithClauseCteNames(maskedSql: string, withTokenStartIndex: number): string[] {
  const cteNames: string[] = [];
  const withKeyword = parseUnquotedSqlToken(maskedSql, withTokenStartIndex);
  assert(
    withKeyword != null && withKeyword.value.toLowerCase() === "with",
    "Expected WITH keyword while collecting raw analytics CTE names"
  );

  let index = skipSqlWhitespace(maskedSql, withKeyword.nextIndex);

  const recursiveKeyword = parseUnquotedSqlToken(maskedSql, index);
  if (recursiveKeyword?.value.toLowerCase() === "recursive") {
    index = skipSqlWhitespace(maskedSql, recursiveKeyword.nextIndex);
  }

  while (index < maskedSql.length) {
    const cteName = parseSqlIdentifier(maskedSql, index);
    if (cteName == null) {
      throw new Error("Raw analytics query contains malformed WITH clause");
    }

    cteNames.push(normalizeSqlIdentifier(cteName.value));
    index = skipSqlWhitespace(maskedSql, cteName.nextIndex);

    if (maskedSql[index] === "(") {
      index = skipBalancedParentheses(maskedSql, index);
      index = skipSqlWhitespace(maskedSql, index);
    }

    const asKeyword = parseUnquotedSqlToken(maskedSql, index);
    if (asKeyword == null || asKeyword.value.toLowerCase() !== "as") {
      throw new Error("Raw analytics query contains malformed WITH clause");
    }

    index = skipSqlWhitespace(maskedSql, asKeyword.nextIndex);

    const maybeModifier = parseUnquotedSqlToken(maskedSql, index);
    if (maybeModifier?.value.toLowerCase() === "not") {
      index = skipSqlWhitespace(maskedSql, maybeModifier.nextIndex);
      const materializedKeyword = parseUnquotedSqlToken(maskedSql, index);
      if (materializedKeyword?.value.toLowerCase() !== "materialized") {
        throw new Error("Raw analytics query contains malformed WITH clause");
      }
      index = skipSqlWhitespace(maskedSql, materializedKeyword.nextIndex);
    } else if (maybeModifier?.value.toLowerCase() === "materialized") {
      index = skipSqlWhitespace(maskedSql, maybeModifier.nextIndex);
    }

    if (maskedSql[index] !== "(") {
      throw new Error("Raw analytics query contains malformed WITH clause");
    }

    index = skipBalancedParentheses(maskedSql, index);
    index = skipSqlWhitespace(maskedSql, index);

    if (maskedSql[index] !== ",") {
      break;
    }

    index = skipSqlWhitespace(maskedSql, index + 1);
  }

  return cteNames;
}

function collectRawQueryCteNames(maskedSql: string): Map<string, number> {
  const cteMinDepthByName = new Map<string, number>();
  let depth = 0;
  let index = 0;

  while (index < maskedSql.length) {
    const char = maskedSql[index];

    if (char === '"') {
      const quotedIdentifier = parseSqlIdentifier(maskedSql, index);
      assert(
        quotedIdentifier != null,
        "Expected quoted identifier while collecting raw analytics CTE names"
      );
      index = quotedIdentifier.nextIndex;
      continue;
    }

    if (char === "(") {
      depth += 1;
      index += 1;
      continue;
    }

    if (char === ")") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }

    const token = parseUnquotedSqlToken(maskedSql, index);
    if (token == null) {
      index += 1;
      continue;
    }

    if (token.value.toLowerCase() === "with") {
      for (const cteName of parseRawQueryWithClauseCteNames(maskedSql, index)) {
        const existingDepth = cteMinDepthByName.get(cteName);
        if (existingDepth == null || depth < existingDepth) {
          cteMinDepthByName.set(cteName, depth);
        }
      }
    }

    index = token.nextIndex;
  }

  return cteMinDepthByName;
}

function validateRawQuerySql(sql: string): void {
  const maskedSql = maskSqlCommentsAndStringLiterals(sql);

  for (const disallowedPattern of RAW_QUERY_DISALLOWED_PATTERNS) {
    if (disallowedPattern.pattern.test(maskedSql)) {
      throw new Error(
        `Query contains disallowed function or statement: ${disallowedPattern.label}`
      );
    }
  }

  const cteMinDepthByName = collectRawQueryCteNames(maskedSql);
  const relationSources = collectRawQueryRelationSources(maskedSql);

  for (const relationSource of relationSources) {
    const normalizedSourceName = normalizeQualifiedSqlIdentifier(relationSource.source);

    if (RAW_QUERY_ALLOWED_TABLES.has(normalizedSourceName)) {
      continue;
    }

    const cteMinDepth = cteMinDepthByName.get(normalizedSourceName);
    if (
      !relationSource.isFunctionCall &&
      !relationSource.isQualifiedName &&
      cteMinDepth != null &&
      cteMinDepth <= relationSource.depth
    ) {
      continue;
    }

    throw new Error(
      `Query references disallowed table or source: ${relationSource.source.trim()}. Allowed tables: ${RAW_QUERY_ALLOWED_TABLE_NAMES}`
    );
  }
}

/**
 * Execute arbitrary user SQL as a read-only subquery with a hard row cap.
 * Wrapping the statement in a subquery prevents DML/DDL execution, and
 * validateRawQuerySql enforces a strict analytics-only table/function surface.
 */
export async function executeRawQuery(
  conn: DuckDBConnection,
  sql: string
): Promise<RawQueryResult> {
  assert(
    typeof sql === "string" && sql.trim().length > 0,
    "executeRawQuery requires non-empty SQL"
  );

  const cleanSql = sql.trim().replace(/;+$/, "").trim();
  assert(cleanSql.length > 0, "executeRawQuery requires SQL with at least one statement");

  validateRawQuerySql(cleanSql);

  const fetchLimit = RAW_QUERY_ROW_LIMIT + 1;
  const wrappedSql = `SELECT * FROM (${cleanSql}) AS __q LIMIT ${fetchLimit}`;

  const startMs = performance.now();
  const result = await conn.run(wrappedSql);
  const rawRows = await result.getRowObjectsJS();
  const durationMs = Math.round(performance.now() - startMs);

  const columns: RawQueryColumn[] = [];
  for (let index = 0; index < result.columnCount; index += 1) {
    columns.push({
      name: result.columnName(index),
      type: String(result.columnType(index)),
    });
  }

  const truncated = rawRows.length > RAW_QUERY_ROW_LIMIT;
  const rows = truncated ? rawRows.slice(0, RAW_QUERY_ROW_LIMIT) : rawRows;

  return {
    columns,
    rows: rows.map(normalizeDuckDbRow),
    truncated,
    rowCount: rows.length,
    durationMs,
  };
}

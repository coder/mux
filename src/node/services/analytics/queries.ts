import assert from "node:assert/strict";
import type { DuckDBConnection, DuckDBValue } from "@duckdb/node-api";
import type { z } from "zod";
import {
  AgentCostRowSchema,
  HistogramBucketSchema,
  ProviderCacheHitModelRowSchema,
  SpendByModelRowSchema,
  SpendByProjectRowSchema,
  SpendOverTimeRowSchema,
  SummaryRowSchema,
  TimingPercentilesRowSchema,
  type AgentCostRow,
  type HistogramBucket,
  type ProviderCacheHitModelRow,
  type SpendByModelRow,
  type SpendByProjectRow,
  type SpendOverTimeRow,
  type SummaryRow,
  type TimingPercentilesRow,
} from "@/common/orpc/schemas/analytics";

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

type Granularity = "hour" | "day" | "week";
type TimingMetric = "ttft" | "duration" | "tps";

interface TimingDistributionResult {
  percentiles: TimingPercentilesRow;
  histogram: HistogramBucket[];
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
  const histogram = await typedQuery(
    conn,
    `
    WITH stats AS (
      SELECT
        MIN(${column}) AS min_value,
        MAX(${column}) AS max_value
      FROM events
      WHERE ${column} IS NOT NULL
        AND (? IS NULL OR project_path = ?)
        AND (? IS NULL OR date >= CAST(? AS DATE))
        AND (? IS NULL OR date <= CAST(? AS DATE))
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

    default:
      throw new Error(`Unknown analytics query: ${queryName}`);
  }
}

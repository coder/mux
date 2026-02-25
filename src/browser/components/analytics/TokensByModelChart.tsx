import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Skeleton } from "@/browser/components/ui/skeleton";
import type { TokensByModelItem } from "@/browser/hooks/useAnalytics";
import {
  ANALYTICS_CHART_COLORS,
  CHART_AXIS_STROKE,
  CHART_AXIS_TICK,
  formatCompactNumber,
} from "./analyticsUtils";

interface TokensByModelChartProps {
  data: TokensByModelItem[] | null;
  loading: boolean;
  error: string | null;
}

// Stable color assignments for each token category.
const TOKEN_CATEGORY_COLORS = {
  inputTokens: ANALYTICS_CHART_COLORS[0],
  cachedTokens: ANALYTICS_CHART_COLORS[3],
  cacheCreateTokens: ANALYTICS_CHART_COLORS[4],
  outputTokens: ANALYTICS_CHART_COLORS[1],
  reasoningTokens: ANALYTICS_CHART_COLORS[2],
} as const;

function isTokensByModelItem(value: unknown): value is TokensByModelItem {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<TokensByModelItem>;
  return typeof record.model === "string" && typeof record.totalTokens === "number";
}

function TokensByModelTooltipContent(props: {
  active?: boolean;
  payload?: Array<{ payload?: unknown }>;
}) {
  if (!props.active || !props.payload || props.payload.length === 0) {
    return null;
  }

  const firstPayload = props.payload[0];
  if (!firstPayload || !isTokensByModelItem(firstPayload.payload)) {
    return null;
  }

  const row = firstPayload.payload;

  return (
    <div
      className="bg-background-secondary border-border-medium rounded-md border p-2 text-xs"
      style={{ minWidth: 200 }}
    >
      <div className="text-foreground mb-1 font-medium">{row.model}</div>
      <div className="text-muted flex items-center justify-between gap-4">
        <span>Input</span>
        <span className="text-foreground font-mono">{formatCompactNumber(row.inputTokens)}</span>
      </div>
      <div className="text-muted flex items-center justify-between gap-4">
        <span>Cached</span>
        <span className="text-foreground font-mono">{formatCompactNumber(row.cachedTokens)}</span>
      </div>
      {row.cacheCreateTokens > 0 ? (
        <div className="text-muted flex items-center justify-between gap-4">
          <span>Cache write</span>
          <span className="text-foreground font-mono">
            {formatCompactNumber(row.cacheCreateTokens)}
          </span>
        </div>
      ) : null}
      <div className="text-muted flex items-center justify-between gap-4">
        <span>Output</span>
        <span className="text-foreground font-mono">{formatCompactNumber(row.outputTokens)}</span>
      </div>
      <div className="text-muted flex items-center justify-between gap-4">
        <span>Reasoning</span>
        <span className="text-foreground font-mono">
          {formatCompactNumber(row.reasoningTokens)}
        </span>
      </div>
      <div className="border-border-light text-muted mt-1 flex items-center justify-between gap-4 border-t pt-1">
        <span>Total</span>
        <span className="text-foreground font-mono font-medium">
          {formatCompactNumber(row.totalTokens)}
        </span>
      </div>
      <div className="text-muted flex items-center justify-between gap-4">
        <span>Requests</span>
        <span className="text-foreground font-mono">{formatCompactNumber(row.requestCount)}</span>
      </div>
    </div>
  );
}

export function TokensByModelChart(props: TokensByModelChartProps) {
  const rows = [...(props.data ?? [])].sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 10);

  return (
    <div className="bg-background-secondary border-border-medium rounded-lg border p-4">
      <h2 className="text-foreground text-sm font-semibold">Token usage by model</h2>
      <p className="text-muted mt-1 text-xs">
        Token production and consumption breakdown per model.
      </p>

      {props.error ? (
        <p className="text-danger mt-3 text-xs">Failed to load token breakdown: {props.error}</p>
      ) : props.loading ? (
        <div className="mt-3">
          <Skeleton variant="shimmer" className="h-72 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <div className="text-muted mt-3 rounded border border-dashed px-3 py-10 text-center text-sm">
          No token usage data available.
        </div>
      ) : (
        <div className="mt-3 h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={rows}
              layout="vertical"
              margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_AXIS_STROKE} />
              <XAxis
                type="number"
                tick={CHART_AXIS_TICK}
                tickFormatter={(value: number) => formatCompactNumber(Number(value))}
                stroke={CHART_AXIS_STROKE}
              />
              <YAxis
                type="category"
                dataKey="model"
                width={160}
                tick={CHART_AXIS_TICK}
                stroke={CHART_AXIS_STROKE}
              />
              <Tooltip
                cursor={{ fill: "var(--color-hover)" }}
                content={(tooltipProps) => <TokensByModelTooltipContent {...tooltipProps} />}
              />
              <Legend wrapperStyle={{ fontSize: "11px" }} />
              <Bar
                dataKey="inputTokens"
                stackId="tokens"
                fill={TOKEN_CATEGORY_COLORS.inputTokens}
                name="Input"
              />
              <Bar
                dataKey="cachedTokens"
                stackId="tokens"
                fill={TOKEN_CATEGORY_COLORS.cachedTokens}
                name="Cached"
              />
              <Bar
                dataKey="cacheCreateTokens"
                stackId="tokens"
                fill={TOKEN_CATEGORY_COLORS.cacheCreateTokens}
                name="Cache write"
              />
              <Bar
                dataKey="outputTokens"
                stackId="tokens"
                fill={TOKEN_CATEGORY_COLORS.outputTokens}
                name="Output"
              />
              <Bar
                dataKey="reasoningTokens"
                stackId="tokens"
                fill={TOKEN_CATEGORY_COLORS.reasoningTokens}
                name="Reasoning"
                radius={[0, 4, 4, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

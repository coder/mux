import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Skeleton } from "@/browser/components/ui/skeleton";
import type { DelegationSummary } from "@/browser/hooks/useAnalytics";
import {
  ANALYTICS_CHART_COLORS,
  CHART_AXIS_STROKE,
  CHART_AXIS_TICK,
  formatCompactNumber,
  formatUsd,
} from "./analyticsUtils";

interface DelegationChartProps {
  data: DelegationSummary | null;
  loading: boolean;
  error: string | null;
}

interface DelegationChartRow {
  label: string;
  tokens: number;
  color: string;
}

function formatCompressionRatio(compressionRatio: number): string {
  if (!Number.isFinite(compressionRatio) || compressionRatio <= 0) {
    return "N/A";
  }

  return `${compressionRatio.toFixed(1)}x`;
}

export function DelegationChart(props: DelegationChartProps) {
  const rows: DelegationChartRow[] = props.data
    ? [
        {
          label: `Explore (${formatCompactNumber(props.data.exploreCount)})`,
          tokens: props.data.exploreTokens,
          color: ANALYTICS_CHART_COLORS[0],
        },
        {
          label: `Exec (${formatCompactNumber(props.data.execCount)})`,
          tokens: props.data.execTokens,
          color: ANALYTICS_CHART_COLORS[1],
        },
        {
          label: `Plan (${formatCompactNumber(props.data.planCount)})`,
          tokens: props.data.planTokens,
          color: ANALYTICS_CHART_COLORS[2],
        },
      ]
    : [];

  return (
    <div className="bg-background-secondary border-border-medium rounded-lg border p-4">
      <h2 className="text-foreground text-sm font-semibold">Delegation insights</h2>
      <p className="text-muted mt-1 text-xs">
        Sub-agent delegation volume, compression, and token usage by agent type.
      </p>

      {props.error ? (
        <p className="text-danger mt-3 text-xs">Failed to load delegation data: {props.error}</p>
      ) : props.loading ? (
        <div className="mt-3 space-y-3">
          <Skeleton variant="shimmer" className="h-20 w-full" />
          <Skeleton variant="shimmer" className="h-64 w-full" />
        </div>
      ) : !props.data || props.data.totalChildren === 0 ? (
        <div className="text-muted mt-3 rounded border border-dashed px-3 py-10 text-center text-sm">
          No delegation data available.
        </div>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="border-border-medium rounded border p-3">
              <p className="text-muted text-xs">Total Delegations</p>
              <p className="text-foreground mt-1 font-mono text-lg font-semibold">
                {props.data.totalChildren}
              </p>
            </div>
            <div className="border-border-medium rounded border p-3">
              <p className="text-muted text-xs">Compression Ratio</p>
              <p className="text-foreground mt-1 font-mono text-lg font-semibold">
                {formatCompressionRatio(props.data.compressionRatio)}
              </p>
            </div>
            <div className="border-border-medium rounded border p-3">
              <p className="text-muted text-xs">Cost Delegated</p>
              <p className="text-foreground mt-1 font-mono text-lg font-semibold">
                {formatUsd(props.data.totalCostDelegated)}
              </p>
            </div>
          </div>

          <div className="mt-3 h-64 w-full">
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
                  dataKey="label"
                  width={140}
                  tick={CHART_AXIS_TICK}
                  stroke={CHART_AXIS_STROKE}
                />
                <Tooltip
                  cursor={{ fill: "var(--color-hover)" }}
                  formatter={(value: number) => [formatCompactNumber(Number(value)), "Tokens"]}
                />
                <Bar dataKey="tokens" radius={[0, 4, 4, 0]}>
                  {rows.map((row) => (
                    <Cell key={row.label} fill={row.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}

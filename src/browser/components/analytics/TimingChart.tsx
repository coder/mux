import { Button } from "@/browser/components/ui/button";
import { Skeleton } from "@/browser/components/ui/skeleton";
import type { TimingDistribution } from "@/browser/hooks/useAnalytics";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ANALYTICS_CHART_COLORS } from "./analyticsUtils";

const METRIC_LABELS = {
  ttft: {
    label: "TTFT",
    unitSuffix: "ms",
    description: "Time to first token",
  },
  duration: {
    label: "Duration",
    unitSuffix: "ms",
    description: "End-to-end response duration",
  },
  tps: {
    label: "Output TPS",
    unitSuffix: " tok/s",
    description: "Tokens streamed per second",
  },
} as const;

type TimingMetric = keyof typeof METRIC_LABELS;

interface TimingChartProps {
  data: TimingDistribution | null;
  loading: boolean;
  error: string | null;
  metric: TimingMetric;
  onMetricChange: (metric: TimingMetric) => void;
}

function formatMetricValue(value: number, metric: TimingMetric): string {
  if (!Number.isFinite(value)) {
    return `0${METRIC_LABELS[metric].unitSuffix}`;
  }

  if (metric === "tps") {
    return `${value.toFixed(2)}${METRIC_LABELS[metric].unitSuffix}`;
  }

  return `${Math.round(value)}${METRIC_LABELS[metric].unitSuffix}`;
}

export function TimingChart(props: TimingChartProps) {
  return (
    <div className="bg-background-secondary border-border-medium rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-foreground text-sm font-semibold">Timing distribution</h2>
          <p className="text-muted mt-1 text-xs">{METRIC_LABELS[props.metric].description}</p>
        </div>
        <div className="border-border-medium bg-background flex items-center gap-1 rounded-md border p-1">
          {(Object.keys(METRIC_LABELS) as TimingMetric[]).map((metric) => (
            <Button
              key={metric}
              variant={props.metric === metric ? "secondary" : "ghost"}
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => props.onMetricChange(metric)}
            >
              {METRIC_LABELS[metric].label}
            </Button>
          ))}
        </div>
      </div>

      {props.error ? (
        <p className="text-danger mt-3 text-xs">
          Failed to load timing distribution: {props.error}
        </p>
      ) : props.loading ? (
        <div className="mt-3">
          <Skeleton variant="shimmer" className="h-72 w-full" />
        </div>
      ) : !props.data || props.data.histogram.length === 0 ? (
        <div className="text-muted mt-3 rounded border border-dashed px-3 py-10 text-center text-sm">
          No timing data available yet.
        </div>
      ) : (
        <div className="mt-3 h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={props.data.histogram}
              margin={{ top: 12, right: 12, left: 4, bottom: 0 }}
              barSize={14}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-light)" />
              <XAxis
                dataKey="bucket"
                type="number"
                tick={{ fill: "var(--color-muted)", fontSize: 11 }}
                tickFormatter={(value: number) => formatMetricValue(Number(value), props.metric)}
                stroke="var(--color-border-light)"
              />
              <YAxis
                tick={{ fill: "var(--color-muted)", fontSize: 11 }}
                stroke="var(--color-border-light)"
              />
              <Tooltip
                labelFormatter={(value: number) => formatMetricValue(Number(value), props.metric)}
                formatter={(value: number) => [value, "Responses"]}
                contentStyle={{
                  borderColor: "var(--color-border-medium)",
                  backgroundColor: "var(--color-background-secondary)",
                  borderRadius: "8px",
                }}
              />
              <ReferenceLine
                x={props.data.p50}
                stroke={ANALYTICS_CHART_COLORS[3]}
                strokeDasharray="4 4"
                label={{
                  value: "p50",
                  fill: "var(--color-success)",
                  fontSize: 10,
                  position: "top",
                }}
              />
              <ReferenceLine
                x={props.data.p90}
                stroke={ANALYTICS_CHART_COLORS[4]}
                strokeDasharray="4 4"
                label={{
                  value: "p90",
                  fill: "var(--color-warning)",
                  fontSize: 10,
                  position: "top",
                }}
              />
              <ReferenceLine
                x={props.data.p99}
                stroke={ANALYTICS_CHART_COLORS[5]}
                strokeDasharray="4 4"
                label={{ value: "p99", fill: "var(--color-danger)", fontSize: 10, position: "top" }}
              />
              <Bar dataKey="count" fill={ANALYTICS_CHART_COLORS[2]} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {!props.loading && !props.error && props.data && (
        <div className="text-muted mt-2 grid grid-cols-3 gap-2 text-xs">
          <div>
            <span className="text-foreground">p50:</span>{" "}
            {formatMetricValue(props.data.p50, props.metric)}
          </div>
          <div>
            <span className="text-foreground">p90:</span>{" "}
            {formatMetricValue(props.data.p90, props.metric)}
          </div>
          <div>
            <span className="text-foreground">p99:</span>{" "}
            {formatMetricValue(props.data.p99, props.metric)}
          </div>
        </div>
      )}
    </div>
  );
}

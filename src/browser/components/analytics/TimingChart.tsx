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
import {
  ANALYTICS_CHART_COLORS,
  CHART_AXIS_STROKE,
  CHART_AXIS_TICK,
  CHART_TOOLTIP_CONTENT_STYLE,
} from "./analyticsUtils";

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

// Keep timing labels readable for long responses; raw millisecond counts become hard to parse.
function formatDurationForChart(ms: number): string {
  if (!Number.isFinite(ms)) {
    return "0ms";
  }

  const normalizedMs = Math.max(0, ms);
  if (normalizedMs < 1_000) {
    return `${Math.round(normalizedMs)}ms`;
  }

  if (normalizedMs < 10_000) {
    return `${(normalizedMs / 1_000).toFixed(1)}s`;
  }

  if (normalizedMs < 60_000) {
    return `${Math.round(normalizedMs / 1_000)}s`;
  }

  if (normalizedMs < 3_600_000) {
    const minutes = normalizedMs / 60_000;
    return minutes < 10 ? `${minutes.toFixed(1)}m` : `${Math.round(minutes)}m`;
  }

  const hours = normalizedMs / 3_600_000;
  return hours < 10 ? `${hours.toFixed(1)}h` : `${Math.round(hours)}h`;
}

function formatMetricValue(value: number, metric: TimingMetric): string {
  if (metric === "tps") {
    const normalizedTps = Number.isFinite(value) ? Math.max(0, value) : 0;
    return `${normalizedTps.toFixed(2)}${METRIC_LABELS[metric].unitSuffix}`;
  }

  return formatDurationForChart(value);
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
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_AXIS_STROKE} />
              <XAxis
                dataKey="bucket"
                type="number"
                tick={CHART_AXIS_TICK}
                tickFormatter={(value: number) => formatMetricValue(Number(value), props.metric)}
                stroke={CHART_AXIS_STROKE}
              />
              <YAxis tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} />
              <Tooltip
                labelFormatter={(value: number) => formatMetricValue(Number(value), props.metric)}
                formatter={(value: number) => [value, "Responses"]}
                contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
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

import { useState, type ComponentType } from "react";
import {
  AlertTriangle,
  AreaChart as AreaChartIcon,
  BarChart3,
  LineChart as LineChartIcon,
  PieChart as PieChartIcon,
  Table,
} from "lucide-react";
import { cn } from "@/common/lib/utils";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import {
  DetailContent,
  DetailSection,
  ErrorBox,
  ExpandIcon,
  HeaderButton,
  StatusIndicator,
  ToolContainer,
  ToolDetails,
  ToolHeader,
  ToolIcon,
  ToolName,
} from "../Shared/ToolPrimitives";
import {
  getStatusDisplay,
  isToolErrorResult,
  type ToolStatus,
  useToolExpansion,
} from "../Shared/toolUtils";
import { inferAxes, inferChartType } from "./chartHeuristics";
import { DynamicChart } from "./DynamicChart";
import { ResultTable } from "./ResultTable";
import type {
  AnalyticsQueryArgs,
  AnalyticsQueryResult,
  AnalyticsQueryToolResult,
  ChartType,
  DrillDownContext,
} from "./types";

interface AnalyticsQueryToolCallProps {
  args: AnalyticsQueryArgs;
  result?: AnalyticsQueryToolResult;
  status?: ToolStatus;
}

interface ChartTypeOption {
  type: ChartType;
  icon: ComponentType<{ className?: string }>;
  label: string;
}

const CHART_TYPE_OPTIONS: ChartTypeOption[] = [
  { type: "table", icon: Table, label: "Table" },
  { type: "bar", icon: BarChart3, label: "Bar" },
  { type: "line", icon: LineChartIcon, label: "Line" },
  { type: "area", icon: AreaChartIcon, label: "Area" },
  { type: "pie", icon: PieChartIcon, label: "Pie" },
  { type: "stacked_bar", icon: BarChart3, label: "Stacked" },
];

function isAnalyticsQuerySuccessResult(
  result: AnalyticsQueryToolResult | undefined
): result is AnalyticsQueryResult {
  if (!result || typeof result !== "object") {
    return false;
  }

  if (result.success !== true) {
    return false;
  }

  return Array.isArray(result.columns) && Array.isArray(result.rows);
}

function escapeDoubleQuotes(value: string): string {
  return value.replaceAll('"', '\\"');
}

export function AnalyticsQueryToolCall(props: AnalyticsQueryToolCallProps): JSX.Element {
  const { expanded, toggleExpanded } = useToolExpansion(true);
  const [chartTypeOverride, setChartTypeOverride] = useState<ChartType | null>(null);
  const [showSql, setShowSql] = useState(false);

  const status = props.status ?? "pending";
  const errorResult = isToolErrorResult(props.result) ? props.result : null;
  const successResult = isAnalyticsQuerySuccessResult(props.result) ? props.result : null;

  const inferredChartType = successResult
    ? inferChartType(successResult.columns, successResult.rows)
    : "table";
  // Rationale: user override should always win, then model hint, then local heuristic fallback.
  const effectiveChartType = chartTypeOverride ?? successResult?.visualization ?? inferredChartType;

  const axes = successResult
    ? inferAxes(successResult.columns, successResult.x_axis, successResult.y_axis)
    : { xAxis: "", yAxes: [] };

  const title = props.args.title ?? successResult?.title ?? "Query results";
  const isRowCountLowerBound =
    successResult != null && (successResult.rowCountExact === false || successResult.truncated);

  const handleDrillDown = (context: DrillDownContext) => {
    if (typeof window === "undefined") {
      return;
    }

    const escapedValue = escapeDoubleQuotes(context.clickedValue);
    const text = `Drill down into rows where ${context.columnName} = "${escapedValue}" from the previous query`;

    window.dispatchEvent(
      createCustomEvent(CUSTOM_EVENTS.UPDATE_CHAT_INPUT, {
        text,
        mode: "replace",
      })
    );
  };

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="analytics_query" />
        <ToolName>{title}</ToolName>
        {successResult && (
          <span className="text-muted text-[10px] whitespace-nowrap">
            {successResult.rowCount.toLocaleString()} rows · {successResult.durationMs}ms
          </span>
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          {errorResult && (
            <>
              <ErrorBox>{errorResult.error}</ErrorBox>
              <DetailSection>
                <div className="text-muted mb-1 text-[10px] tracking-wide uppercase">SQL</div>
                <DetailContent className="px-2 py-1.5">{props.args.sql}</DetailContent>
              </DetailSection>
            </>
          )}

          {successResult && (
            <>
              {successResult.truncated && (
                <div className="text-warning mb-2 flex items-center gap-1 text-[10px]">
                  <AlertTriangle className="size-3" />
                  Showing {successResult.rows.length.toLocaleString()} of{" "}
                  {successResult.rowCount.toLocaleString()}
                  {isRowCountLowerBound ? "+" : ""} rows (results truncated).
                </div>
              )}

              <div className="mb-2 flex flex-wrap gap-1">
                {CHART_TYPE_OPTIONS.map((option) => (
                  <HeaderButton
                    key={option.type}
                    type="button"
                    active={effectiveChartType === option.type}
                    onClick={() => setChartTypeOverride(option.type)}
                    className={cn("inline-flex items-center gap-1")}
                  >
                    <option.icon className="size-3" />
                    {option.label}
                  </HeaderButton>
                ))}
              </div>

              {effectiveChartType === "table" ||
              axes.yAxes.length === 0 ||
              axes.xAxis.length === 0 ? (
                <ResultTable
                  columns={successResult.columns}
                  rows={successResult.rows}
                  onDrillDown={handleDrillDown}
                  chartType={effectiveChartType}
                />
              ) : (
                <DynamicChart
                  chartType={effectiveChartType}
                  data={successResult.rows}
                  xAxis={axes.xAxis}
                  yAxes={axes.yAxes}
                  onDrillDown={handleDrillDown}
                />
              )}

              <button
                type="button"
                onClick={() => setShowSql(!showSql)}
                className="text-muted hover:text-foreground mt-2 text-[10px] transition-colors"
              >
                {showSql ? "Hide SQL" : "Show SQL"}
              </button>

              {showSql && (
                <DetailSection>
                  <DetailContent className="px-2 py-1.5">{props.args.sql}</DetailContent>
                </DetailSection>
              )}
            </>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
}

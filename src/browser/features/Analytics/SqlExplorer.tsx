import { useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, Database, Pin, Play, X } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { useAnalyticsRawQuery } from "@/browser/hooks/useAnalytics";
import { cn } from "@/common/lib/utils";
import type { SavedQuery } from "@/common/types/savedQueries";
import { getErrorMessage } from "@/common/utils/errors";
import { DynamicChart } from "../Tools/analyticsQuery/DynamicChart";
import { ResultTable } from "../Tools/analyticsQuery/ResultTable";
import { inferAxes, inferChartType } from "../Tools/analyticsQuery/chartHeuristics";
import type { ChartType, ColumnMeta } from "../Tools/analyticsQuery/types";
import { ChartTypePicker } from "./ChartTypePicker";

export const SAMPLE_QUERIES = [
  {
    label: "Top Models by Cost",
    sql: "SELECT model, sum(total_cost_usd) as total_cost\nFROM events\nGROUP BY model\nORDER BY total_cost DESC\nLIMIT 10;",
  },
  {
    label: "Daily Spend Over Time",
    sql: "SELECT date, sum(total_cost_usd) as daily_cost\nFROM events\nGROUP BY date\nORDER BY date ASC;",
  },
  {
    label: "Agent Performance Summary",
    sql: "SELECT agent_id, count(*) as count, avg(duration_ms) as avg_duration, sum(total_cost_usd) as total_cost\nFROM events\nWHERE agent_id IS NOT NULL\nGROUP BY agent_id\nORDER BY total_cost DESC;",
  },
  {
    label: "Tokens by Thinking Level",
    sql: "SELECT thinking_level, sum(input_tokens + output_tokens + reasoning_tokens + cached_tokens + cache_create_tokens) as total_tokens\nFROM events\nWHERE thinking_level IS NOT NULL\nGROUP BY thinking_level\nORDER BY total_tokens DESC;",
  },
];

interface SqlExplorerProps {
  onSaveQuery?: (input: {
    label: string;
    sql: string;
    chartType?: string | null;
  }) => Promise<SavedQuery | null>;
}

export function SqlExplorer(props: SqlExplorerProps) {
  const [sql, setSql] = useState(SAMPLE_QUERIES[0].sql);
  const { data, loading, error, executeQuery } = useAnalyticsRawQuery();
  const [chartTypeOverride, setChartTypeOverride] = useState<ChartType | null>(null);
  const [showSamples, setShowSamples] = useState(false);
  const [saveLabel, setSaveLabel] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [lastExecutedSql, setLastExecutedSql] = useState<string | null>(null);
  // Keep save metadata aligned with the latest run when queries resolve out of order.
  const executionIdRef = useRef(0);

  const inferredChartType = data ? inferChartType(data.columns, data.rows) : "table";

  const effectiveChartType = chartTypeOverride ?? inferredChartType;

  // No explicit axes from raw query, let heuristics decide.
  const axes = data ? inferAxes(data.columns, undefined, undefined) : { xAxis: "", yAxes: [] };

  const handleRun = async () => {
    if (loading) {
      return;
    }

    const normalizedSql = sql.trim();
    if (!normalizedSql) {
      return;
    }

    const thisExecutionId = ++executionIdRef.current;
    await executeQuery(normalizedSql);

    if (thisExecutionId === executionIdRef.current) {
      setLastExecutedSql(normalizedSql);
    }
  };

  const handleCancelSave = () => {
    setSaveLabel(null);
    setSaveError(null);
  };

  const handleSave = async () => {
    if (!props.onSaveQuery || !data || !lastExecutedSql || saveLabel === null) {
      return;
    }

    const normalizedLabel = saveLabel.trim();
    const normalizedSql = lastExecutedSql.trim();
    if (!normalizedLabel || !normalizedSql) {
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const savedQuery = await props.onSaveQuery({
        label: normalizedLabel,
        sql: normalizedSql,
        chartType: chartTypeOverride ?? null,
      });

      if (savedQuery) {
        setSaveLabel(null);
      }
    } catch (saveQueryError) {
      setSaveError(getErrorMessage(saveQueryError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-background-secondary border-border-medium flex flex-col gap-4 rounded-xl border p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Database className="text-muted size-4" />
          <h2 className="text-sm font-semibold">SQL Explorer</h2>
        </div>
        <div className="relative">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowSamples(!showSamples)}
            className="text-muted hover:text-foreground h-7 gap-1 px-2 text-[11px]"
          >
            Sample Queries
            <ChevronDown
              className={cn("size-3 transition-transform", showSamples && "rotate-180")}
            />
          </Button>
          {showSamples && (
            <div className="bg-sidebar border-border-medium absolute top-full right-0 z-50 mt-1 w-64 rounded-md border p-1 shadow-lg">
              {SAMPLE_QUERIES.map((sample) => (
                <button
                  key={sample.label}
                  onClick={() => {
                    setSql(sample.sql);
                    setShowSamples(false);
                  }}
                  className="hover:bg-accent hover:text-accent-foreground w-full rounded px-2 py-1.5 text-left text-[11px] transition-colors"
                >
                  {sample.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="relative">
          <textarea
            value={sql}
            onChange={(event) => setSql(event.target.value)}
            spellCheck={false}
            className="border-border-medium bg-background text-foreground focus:border-accent focus:ring-accent min-h-[120px] w-full resize-y rounded-lg border p-3 font-mono text-xs leading-relaxed focus:ring-1 focus:outline-none"
            placeholder="SELECT * FROM events LIMIT 10;"
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                if (!loading && sql.trim()) {
                  void handleRun();
                }
              }
            }}
          />
          <div className="absolute right-2 bottom-2 flex items-center gap-2">
            <span className="text-muted text-[10px]">Ctrl/Cmd+Enter to run</span>
            <Button
              size="sm"
              onClick={() => {
                void handleRun();
              }}
              disabled={loading || !sql.trim()}
              className="h-7 gap-1.5 px-3 text-xs"
            >
              <Play className={cn("size-3 fill-current", loading && "animate-pulse")} />
              Run Query
            </Button>
          </div>
        </div>

        {error && (
          <div className="border-danger-soft bg-danger-soft/10 text-danger flex items-start gap-2 rounded-lg border p-3 text-xs">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <div className="flex-1 font-mono whitespace-pre-wrap">{error}</div>
          </div>
        )}

        {data && (
          <div className="flex flex-col gap-3 pt-2">
            <div className="border-border-light flex flex-wrap items-center justify-between gap-2 border-t pt-3">
              <ChartTypePicker
                activeType={effectiveChartType}
                onSelect={(nextType) => setChartTypeOverride(nextType)}
              />
              <div className="text-muted text-[10px]">
                {data.rowCount.toLocaleString()}
                {data.rowCountExact ? "" : "+"} rows · {data.durationMs}ms
                {data.truncated && " · Results truncated"}
              </div>
            </div>

            {props.onSaveQuery && lastExecutedSql && (
              <div className="border-border-light flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                <div className="text-muted text-xs">
                  Pin this query to the dashboard as a saved panel.
                </div>
                {saveLabel === null ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setSaveLabel("");
                      setSaveError(null);
                    }}
                    className="h-7 gap-1.5 px-2.5 text-[11px]"
                  >
                    <Pin className="size-3" />
                    Save as Panel
                  </Button>
                ) : (
                  <div className="flex min-w-[240px] items-center gap-1">
                    <input
                      value={saveLabel}
                      onChange={(event) => setSaveLabel(event.target.value)}
                      placeholder="Panel title"
                      className="border-border-medium bg-background text-foreground h-7 min-w-0 flex-1 rounded border px-2 text-xs focus:outline-none"
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void handleSave();
                        }

                        if (event.key === "Escape") {
                          event.preventDefault();
                          handleCancelSave();
                        }
                      }}
                      autoFocus
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={saving || saveLabel.trim().length === 0}
                      onClick={() => {
                        void handleSave();
                      }}
                      className="text-muted hover:text-foreground h-7 w-7"
                      aria-label="Save panel"
                    >
                      <Check className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={saving}
                      onClick={handleCancelSave}
                      className="text-muted hover:text-foreground h-7 w-7"
                      aria-label="Cancel saving panel"
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            )}

            {saveError && (
              <div className="border-danger-soft bg-danger-soft/10 text-danger flex items-start gap-2 rounded-lg border p-3 text-xs">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <div className="flex-1 font-mono whitespace-pre-wrap">{saveError}</div>
              </div>
            )}

            <div className="bg-background border-border-light min-h-[300px] overflow-hidden rounded-lg border">
              {effectiveChartType === "table" ||
              axes.yAxes.length === 0 ||
              axes.xAxis.length === 0 ? (
                <ResultTable
                  columns={data.columns as unknown as ColumnMeta[]}
                  rows={data.rows}
                  chartType={effectiveChartType}
                />
              ) : (
                <div className="p-4">
                  <DynamicChart
                    chartType={effectiveChartType}
                    data={data.rows}
                    xAxis={axes.xAxis}
                    yAxes={axes.yAxes}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

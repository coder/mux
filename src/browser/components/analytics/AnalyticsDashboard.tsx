import assert from "node:assert/strict";
import { useState } from "react";
import { ArrowLeft, Menu } from "lucide-react";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useRouter } from "@/browser/contexts/RouterContext";
import {
  useAnalyticsAgentCostBreakdown,
  useAnalyticsSpendByModel,
  useAnalyticsSpendByProject,
  useAnalyticsSpendOverTime,
  useAnalyticsSummary,
  useAnalyticsTimingDistribution,
} from "@/browser/hooks/useAnalytics";
import { DESKTOP_TITLEBAR_HEIGHT_CLASS, isDesktopMode } from "@/browser/hooks/useDesktopTitlebar";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { Button } from "@/browser/components/ui/button";
import { cn } from "@/common/lib/utils";
import { AgentCostChart } from "./AgentCostChart";
import { ModelBreakdown } from "./ModelBreakdown";
import { SpendChart } from "./SpendChart";
import { SummaryCards } from "./SummaryCards";
import { TimingChart } from "./TimingChart";
import { formatProjectDisplayName } from "./analyticsUtils";

interface AnalyticsDashboardProps {
  leftSidebarCollapsed: boolean;
  onToggleLeftSidebarCollapsed: () => void;
}

type TimeRange = "7d" | "30d" | "90d" | "all";
type TimingMetric = "ttft" | "duration" | "tps";

const ANALYTICS_TIME_RANGE_STORAGE_KEY = "analytics:timeRange";
const ANALYTICS_TIMING_METRIC_STORAGE_KEY = "analytics:timingMetric";

function computeDateRange(timeRange: TimeRange): {
  from: Date | null;
  granularity: "hour" | "day" | "week";
} {
  const now = new Date();

  switch (timeRange) {
    case "7d": {
      const from = new Date(now);
      from.setHours(0, 0, 0, 0);
      from.setDate(from.getDate() - 6);
      return {
        from,
        granularity: "day",
      };
    }
    case "30d": {
      const from = new Date(now);
      from.setHours(0, 0, 0, 0);
      from.setDate(from.getDate() - 29);
      return {
        from,
        granularity: "day",
      };
    }
    case "90d": {
      const from = new Date(now);
      from.setHours(0, 0, 0, 0);
      from.setDate(from.getDate() - 89);
      return {
        from,
        granularity: "week",
      };
    }
    case "all": {
      return {
        from: null,
        granularity: "week",
      };
    }
    default: {
      assert(false, "Unexpected time range");
    }
  }
}

export function AnalyticsDashboard(props: AnalyticsDashboardProps) {
  const { navigateFromAnalytics } = useRouter();
  const { projects } = useProjectContext();

  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [timeRange, setTimeRange] = usePersistedState<TimeRange>(
    ANALYTICS_TIME_RANGE_STORAGE_KEY,
    "30d"
  );
  const [timingMetric, setTimingMetric] = usePersistedState<TimingMetric>(
    ANALYTICS_TIMING_METRIC_STORAGE_KEY,
    "duration"
  );

  const dateRange = computeDateRange(timeRange);

  const summary = useAnalyticsSummary(projectPath);
  const spendOverTime = useAnalyticsSpendOverTime({
    projectPath,
    granularity: dateRange.granularity,
    from: dateRange.from,
  });
  const spendByProject = useAnalyticsSpendByProject();
  const spendByModel = useAnalyticsSpendByModel(projectPath);
  const timingDistribution = useAnalyticsTimingDistribution(timingMetric, projectPath);
  const agentCosts = useAnalyticsAgentCostBreakdown(projectPath);

  const projectRows = Array.from(projects.entries())
    .map(([path]) => ({
      path,
      label: formatProjectDisplayName(path),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const desktopMode = isDesktopMode();

  return (
    <div className="bg-dark flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        className={cn(
          "bg-sidebar border-border-light flex shrink-0 items-center gap-2 border-b px-3",
          desktopMode ? `${DESKTOP_TITLEBAR_HEIGHT_CLASS} titlebar-drag` : "h-8"
        )}
      >
        <div className={cn("flex min-w-0 items-center gap-2", desktopMode && "titlebar-no-drag")}>
          {props.leftSidebarCollapsed && (
            <Button
              variant="ghost"
              size="icon"
              onClick={props.onToggleLeftSidebarCollapsed}
              title="Open sidebar"
              aria-label="Open sidebar"
              className="text-muted hover:text-foreground hidden h-6 w-6 md:inline-flex"
            >
              <Menu className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={navigateFromAnalytics}
            className="text-muted hover:text-foreground h-6 gap-1 px-2 text-xs"
            title="Back"
            aria-label="Back to previous view"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </Button>
          <h1 className="text-foreground text-sm font-semibold">Analytics</h1>
        </div>

        <div className={cn("ml-auto flex items-center gap-2", desktopMode && "titlebar-no-drag")}>
          <label className="text-muted text-xs" htmlFor="analytics-project-filter">
            Project
          </label>
          <select
            id="analytics-project-filter"
            value={projectPath ?? "__all"}
            onChange={(event) => {
              const nextValue = event.target.value;
              setProjectPath(nextValue === "__all" ? null : nextValue);
            }}
            className="border-border-medium bg-separator text-foreground h-6 rounded border px-2 text-xs"
          >
            <option value="__all">All projects</option>
            {projectRows.map((project) => (
              <option key={project.path} value={project.path}>
                {project.label}
              </option>
            ))}
          </select>

          <div className="border-border-medium bg-background flex items-center gap-1 rounded-md border p-1">
            {(
              [
                ["7d", "7D"],
                ["30d", "30D"],
                ["90d", "90D"],
                ["all", "All"],
              ] as const
            ).map(([range, label]) => (
              <Button
                key={range}
                variant={timeRange === range ? "secondary" : "ghost"}
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => setTimeRange(range)}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
          <SummaryCards data={summary.data} loading={summary.loading} error={summary.error} />
          <SpendChart
            data={spendOverTime.data}
            loading={spendOverTime.loading}
            error={spendOverTime.error}
          />
          <ModelBreakdown spendByProject={spendByProject} spendByModel={spendByModel} />
          <TimingChart
            data={timingDistribution.data}
            loading={timingDistribution.loading}
            error={timingDistribution.error}
            metric={timingMetric}
            onMetricChange={setTimingMetric}
          />
          <AgentCostChart
            data={agentCosts.data}
            loading={agentCosts.loading}
            error={agentCosts.error}
          />
        </div>
      </div>
    </div>
  );
}

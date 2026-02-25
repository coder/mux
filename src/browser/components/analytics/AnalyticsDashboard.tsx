import { useEffect, useState } from "react";
import { ArrowLeft, Menu } from "lucide-react";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useRouter } from "@/browser/contexts/RouterContext";
import {
  useAnalyticsAgentCostBreakdown,
  useAnalyticsProviderCacheHitRatio,
  useAnalyticsSpendByModel,
  useAnalyticsSpendByProject,
  useAnalyticsSpendOverTime,
  useAnalyticsSummary,
  useAnalyticsTimingDistribution,
} from "@/browser/hooks/useAnalytics";
import { DESKTOP_TITLEBAR_HEIGHT_CLASS, isDesktopMode } from "@/browser/hooks/useDesktopTitlebar";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { isEditableElement, KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";
import { Button } from "@/browser/components/ui/button";
import { cn } from "@/common/lib/utils";
import { AgentCostChart } from "./AgentCostChart";
import { ProviderCacheHitChart } from "./ProviderCacheHitChart";
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

const VALID_TIME_RANGES = new Set<string>(["7d", "30d", "90d", "all"]);
const VALID_TIMING_METRICS = new Set<string>(["ttft", "duration", "tps"]);

const ANALYTICS_TIME_RANGE_STORAGE_KEY = "analytics:timeRange";
const ANALYTICS_TIMING_METRIC_STORAGE_KEY = "analytics:timingMetric";

/** Coerce a persisted value to a known TimeRange, falling back to "30d" if stale/corrupted. */
function normalizeTimeRange(value: unknown): TimeRange {
  return typeof value === "string" && VALID_TIME_RANGES.has(value) ? (value as TimeRange) : "30d";
}

/** Coerce a persisted value to a known TimingMetric, falling back to "duration" if stale/corrupted. */
function normalizeTimingMetric(value: unknown): TimingMetric {
  return typeof value === "string" && VALID_TIMING_METRICS.has(value)
    ? (value as TimingMetric)
    : "duration";
}

/** Build a UTC-aligned date boundary N days before today. Using UTC avoids
 *  the backend's `toISOString().slice(0,10)` conversion silently shifting the
 *  day in positive-offset timezones. */
function utcDaysAgo(days: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days));
}

function computeDateRange(timeRange: TimeRange): {
  from: Date | null;
  to: Date | null;
  granularity: "hour" | "day" | "week";
} {
  switch (timeRange) {
    case "7d":
      return { from: utcDaysAgo(6), to: null, granularity: "day" };
    case "30d":
      return { from: utcDaysAgo(29), to: null, granularity: "day" };
    case "90d":
      return { from: utcDaysAgo(89), to: null, granularity: "week" };
    case "all":
      return { from: null, to: null, granularity: "week" };
    default:
      // Self-heal: unknown persisted value → safe default.
      return { from: utcDaysAgo(29), to: null, granularity: "day" };
  }
}

export function AnalyticsDashboard(props: AnalyticsDashboardProps) {
  const { navigateFromAnalytics } = useRouter();
  const { userProjects } = useProjectContext();

  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [rawTimeRange, setTimeRange] = usePersistedState<TimeRange>(
    ANALYTICS_TIME_RANGE_STORAGE_KEY,
    "30d"
  );
  const [rawTimingMetric, setTimingMetric] = usePersistedState<TimingMetric>(
    ANALYTICS_TIMING_METRIC_STORAGE_KEY,
    "duration"
  );

  // Coerce persisted values to known enums — stale/corrupted localStorage
  // entries self-heal to defaults instead of crashing the dashboard.
  const timeRange = normalizeTimeRange(rawTimeRange);
  const timingMetric = normalizeTimingMetric(rawTimingMetric);

  const dateRange = computeDateRange(timeRange);

  const summary = useAnalyticsSummary(projectPath, {
    from: dateRange.from,
    to: dateRange.to,
  });
  const spendOverTime = useAnalyticsSpendOverTime({
    projectPath,
    granularity: dateRange.granularity,
    from: dateRange.from,
    to: dateRange.to,
  });
  const spendByProject = useAnalyticsSpendByProject({
    from: dateRange.from,
    to: dateRange.to,
  });
  const spendByModel = useAnalyticsSpendByModel(projectPath, {
    from: dateRange.from,
    to: dateRange.to,
  });
  const timingDistribution = useAnalyticsTimingDistribution(timingMetric, projectPath, {
    from: dateRange.from,
    to: dateRange.to,
  });
  const providerCacheHitRatios = useAnalyticsProviderCacheHitRatio(projectPath, {
    from: dateRange.from,
    to: dateRange.to,
  });
  const agentCosts = useAnalyticsAgentCostBreakdown(projectPath, {
    from: dateRange.from,
    to: dateRange.to,
  });

  const projectRows = Array.from(userProjects.entries())
    .map(([path]) => ({
      path,
      label: formatProjectDisplayName(path),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const desktopMode = isDesktopMode();

  // Close analytics on Escape. Uses bubble phase so inner surfaces (Select dropdowns,
  // Popover) that call stopPropagation/preventDefault on Escape get first
  // right of refusal—only an unclaimed Escape navigates away from analytics.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!matchesKeybind(e, KEYBINDS.CANCEL)) return;
      if (e.defaultPrevented) return;
      if (isEditableElement(e.target)) return;

      e.preventDefault();
      e.stopPropagation();
      navigateFromAnalytics();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigateFromAnalytics]);

  return (
    <div className="bg-dark flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        data-testid="analytics-header"
        className={cn(
          "bg-sidebar border-border-light titlebar-safe-right titlebar-safe-right-gutter-3 flex shrink-0 items-center gap-2 border-b px-3",
          desktopMode
            ? `${DESKTOP_TITLEBAR_HEIGHT_CLASS} titlebar-drag flex-nowrap`
            : "flex-wrap py-2 md:h-8 md:flex-nowrap md:py-0"
        )}
      >
        <div
          className={cn(
            "flex min-w-0 items-center gap-2",
            desktopMode ? "w-auto titlebar-no-drag" : "w-full md:w-auto"
          )}
        >
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

        <div
          className={cn(
            desktopMode
              ? "titlebar-no-drag ml-auto flex min-w-fit items-center gap-2"
              : "flex w-full min-w-0 flex-wrap items-center gap-2 md:ml-auto md:w-auto md:min-w-fit md:flex-nowrap"
          )}
        >
          {/* Keep the project control labeled on mobile for screen readers while
              keeping the compact mobile header visually uncluttered. */}
          <label
            className="text-muted sr-only text-xs md:not-sr-only md:inline"
            htmlFor="analytics-project-filter"
          >
            Project
          </label>
          <select
            id="analytics-project-filter"
            value={projectPath ?? "__all"}
            onChange={(event) => {
              const nextValue = event.target.value;
              setProjectPath(nextValue === "__all" ? null : nextValue);
            }}
            className="border-border-medium bg-separator text-foreground h-6 min-w-0 flex-1 rounded border px-2 text-xs md:max-w-56 md:flex-none"
          >
            <option value="__all">All projects</option>
            {projectRows.map((project) => (
              <option key={project.path} value={project.path}>
                {project.label}
              </option>
            ))}
          </select>

          <div className="border-border-medium bg-background ml-auto flex shrink-0 items-center gap-1 rounded-md border p-1">
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
          <ProviderCacheHitChart
            data={providerCacheHitRatios.data}
            loading={providerCacheHitRatios.loading}
            error={providerCacheHitRatios.error}
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

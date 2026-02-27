import React from "react";
import { Hourglass } from "lucide-react";
import { TokenMeter } from "./RightSidebar/TokenMeter";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "./Dialog/Dialog";
import {
  HorizontalThresholdSlider,
  type AutoCompactionConfig,
} from "./RightSidebar/ThresholdSlider";
import { Switch } from "./Switch/Switch";
import { formatTokens, type TokenMeterData } from "@/common/utils/tokens/tokenMeterUtils";
import { cn } from "@/common/lib/utils";
import { Toggle1MContext } from "./Toggle1MContext";
import { Tooltip, TooltipContent, TooltipTrigger } from "./Tooltip/Tooltip";

/** Compact threshold tick mark for the button view */
const CompactThresholdIndicator: React.FC<{ threshold: number }> = ({ threshold }) => {
  if (threshold >= 100) return null;

  return (
    <div
      className="bg-plan-mode pointer-events-none absolute top-0 z-50 h-full w-px"
      style={{ left: `${threshold}%` }}
    />
  );
};

export interface IdleCompactionConfig {
  /** Hours of inactivity before idle compaction triggers, or null if disabled */
  hours: number | null;
  /** Update the idle compaction hours setting */
  setHours: (hours: number | null) => void;
}

interface ContextUsageIndicatorButtonProps {
  data: TokenMeterData;
  autoCompaction?: AutoCompactionConfig;
  idleCompaction?: IdleCompactionConfig;
  /** Current model ID — used to show 1M context toggle for supported models */
  model?: string;
}

/** Tick marks with vertical lines attached to the meter */
const PercentTickMarks: React.FC = () => {
  const ticks = [0, 25, 50, 75, 100];
  return (
    <div className="relative -mt-1 h-5 w-full">
      {ticks.map((pct) => {
        const transform =
          pct === 0 ? "translateX(0%)" : pct === 100 ? "translateX(-100%)" : "translateX(-50%)";
        return (
          <div
            key={pct}
            className="absolute flex flex-col items-center"
            style={{ left: `${pct}%`, transform }}
          >
            <div className="bg-border-medium h-[3px] w-px" />
            <span className="text-muted text-[8px] leading-tight">{pct}</span>
          </div>
        );
      })}
    </div>
  );
};

/** Unified auto-compact settings panel */
const AutoCompactSettings: React.FC<{
  data: TokenMeterData;
  usageConfig?: AutoCompactionConfig;
  idleConfig?: IdleCompactionConfig;
  model?: string;
}> = ({ data, usageConfig, idleConfig, model }) => {
  const [idleInputValue, setIdleInputValue] = React.useState(idleConfig?.hours?.toString() ?? "24");

  // Sync idle input when external hours change
  React.useEffect(() => {
    setIdleInputValue(idleConfig?.hours?.toString() ?? "24");
  }, [idleConfig?.hours]);

  const totalDisplay = formatTokens(data.totalTokens);
  const maxDisplay = data.maxTokens ? ` / ${formatTokens(data.maxTokens)}` : "";
  const percentageDisplay = data.maxTokens ? ` (${data.totalPercentage.toFixed(1)}%)` : "";

  const showUsageSlider = Boolean(usageConfig && data.maxTokens);
  const isIdleEnabled = idleConfig?.hours !== null && idleConfig?.hours !== undefined;

  const handleIdleToggle = (enabled: boolean) => {
    if (!idleConfig) return;
    const parsed = parseInt(idleInputValue, 10);
    idleConfig.setHours(enabled ? (Number.isNaN(parsed) || parsed < 1 ? 24 : parsed) : null);
  };

  const handleIdleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    if (!idleConfig) return;
    const val = parseInt(e.target.value, 10);
    if (!isNaN(val) && val >= 1 && val !== idleConfig.hours && idleConfig.hours !== null) {
      idleConfig.setHours(val);
    } else if (e.target.value === "" || isNaN(val) || val < 1) {
      setIdleInputValue(idleConfig.hours?.toString() ?? "24");
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Context Usage header with instruction */}
      <div>
        <div className="flex items-baseline justify-between">
          <span className="text-foreground font-medium">Context Usage</span>
          <span className="text-muted text-xs">
            {totalDisplay}
            {maxDisplay}
            {percentageDisplay}
          </span>
        </div>
        {showUsageSlider && (
          <div className="text-muted mt-1 text-[10px]">
            Drag blue slider to adjust usage-based auto-compaction
          </div>
        )}
      </div>

      {/* Token meter with threshold slider + tick marks */}
      <div>
        <div className="relative w-full py-1.5">
          <TokenMeter segments={data.segments} orientation="horizontal" />
          {showUsageSlider && usageConfig && <HorizontalThresholdSlider config={usageConfig} />}
        </div>
        {showUsageSlider && <PercentTickMarks />}
      </div>

      {/* 1M context toggle for supported Anthropic models */}
      {model && <Toggle1MContext model={model} />}

      {/* Idle-based auto-compact */}
      {idleConfig && (
        <div className="border-separator-light border-t pt-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              <Hourglass className="text-muted h-2.5 w-2.5" />
              <span className="text-foreground text-[11px] font-medium">Idle compaction</span>
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={1}
                value={idleInputValue}
                onChange={(e) => setIdleInputValue(e.target.value)}
                onBlur={handleIdleBlur}
                disabled={!isIdleEnabled}
                className={cn(
                  "border-border-medium bg-background-secondary focus:border-accent h-5 w-10 rounded border px-1 text-center text-[11px] focus:outline-none",
                  !isIdleEnabled && "opacity-50"
                )}
              />
              <span className={cn("text-[10px]", isIdleEnabled ? "text-muted" : "text-muted/50")}>
                hrs
              </span>
              <Switch
                checked={isIdleEnabled}
                onCheckedChange={handleIdleToggle}
                className="scale-75"
              />
            </div>
          </div>
          <div className="text-muted mt-0.5 text-[10px]">
            Auto-compact after workspace inactivity
          </div>
        </div>
      )}

      {/* Warning for unknown model limits */}
      {!data.maxTokens && (
        <div className="text-subtle text-[10px] italic">
          Unknown model limits - showing relative usage only
        </div>
      )}

      {/* Persistence note */}
      <div className="text-muted border-separator-light border-t pt-2 text-[10px]">
        Usage threshold saved per model{idleConfig && "; idle timer saved per project"}
      </div>
    </div>
  );
};

export const ContextUsageIndicatorButton: React.FC<ContextUsageIndicatorButtonProps> = ({
  data,
  autoCompaction,
  idleCompaction,
  model,
}) => {
  const isAutoCompactionEnabled = autoCompaction && autoCompaction.threshold < 100;
  const idleHours = idleCompaction?.hours;
  const isIdleCompactionEnabled = idleHours !== null && idleHours !== undefined;

  // Show nothing only if no tokens AND no idle compaction config to display
  // (idle compaction settings should always be accessible when the prop is passed)
  if (data.totalTokens === 0 && !idleCompaction) return null;

  const ariaLabel = data.maxTokens
    ? `Context usage: ${formatTokens(data.totalTokens)} / ${formatTokens(data.maxTokens)} (${data.totalPercentage.toFixed(
        1
      )}%)`
    : `Context usage: ${formatTokens(data.totalTokens)} (unknown limit)`;

  const compactLabel = data.maxTokens
    ? `${Math.round(data.totalPercentage)}%`
    : formatTokens(data.totalTokens);

  const hoverUsageSummary = data.maxTokens
    ? `Context ${formatTokens(data.totalTokens)} / ${formatTokens(data.maxTokens)} (${data.totalPercentage.toFixed(1)}%)`
    : `Context ${formatTokens(data.totalTokens)} (unknown limit)`;
  const hoverAutoSummary = autoCompaction
    ? autoCompaction.threshold < 100
      ? `Auto ${autoCompaction.threshold}%`
      : "Auto off"
    : null;
  const hoverIdleSummary = idleCompaction
    ? isIdleCompactionEnabled
      ? `Idle ${idleHours}h`
      : "Idle off"
    : null;
  const hoverSummary = [hoverUsageSummary, hoverAutoSummary, hoverIdleSummary]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <Dialog>
      {/*
        Keep a hover-only one-line summary so users can quickly see compaction stats
        without reopening the full click-based settings dialog.
      */}
      <Tooltip delayDuration={200} disableHoverableContent>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <button
              aria-label={ariaLabel}
              aria-haspopup="dialog"
              className="hover:bg-sidebar-hover flex cursor-pointer items-center rounded py-0.5"
              type="button"
            >
              {/* Idle compaction indicator */}
              {isIdleCompactionEnabled && (
                <span
                  title={`Auto-compact after ${idleHours}h idle`}
                  className="mr-1.5 [@container(max-width:420px)]:hidden"
                >
                  <Hourglass className="text-muted h-3 w-3" />
                </span>
              )}

              {/* Full meter when there's room; fall back to a compact percentage label on narrow layouts. */}
              {data.totalTokens > 0 ? (
                <div
                  data-context-usage-meter
                  className="relative h-3 w-14 [@container(max-width:420px)]:hidden"
                >
                  <TokenMeter
                    segments={data.segments}
                    orientation="horizontal"
                    className="h-3"
                    trackClassName="bg-dark"
                  />
                  {isAutoCompactionEnabled && (
                    <CompactThresholdIndicator threshold={autoCompaction.threshold} />
                  )}
                </div>
              ) : (
                /* Empty meter placeholder - allows access to settings with no usage */
                <div
                  data-context-usage-meter
                  className="bg-dark relative h-3 w-14 rounded-full [@container(max-width:420px)]:hidden"
                />
              )}

              <span
                data-context-usage-percent
                className="text-muted hidden text-[10px] font-medium tabular-nums [@container(max-width:420px)]:block"
              >
                {compactLabel}
              </span>
            </button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" showArrow={false} className="whitespace-nowrap">
          {hoverSummary}
        </TooltipContent>
      </Tooltip>

      {/*
        Keep compaction controls in a dialog so auto + idle settings stay open
        while users adjust sliders/toggles, instead of depending on hover timing.
      */}
      <DialogContent maxWidth="380px" className="gap-3 p-3">
        <DialogHeader className="space-y-0">
          <DialogTitle className="text-sm">Compaction Settings</DialogTitle>
        </DialogHeader>
        {/* Keep manual /compact discoverability in the settings modal so the inline auto-compact hint stays minimal. */}
        <div className="text-muted text-[10px]">
          <div>
            Run <span className="font-mono">/compact</span> to compact manually
          </div>
          <div className="mt-1">
            • <span className="font-mono">-m model</span>
          </div>
          <div>
            • <span className="font-mono">-t max output tokens</span>
          </div>
          <div>• Add a followup message on the next line</div>
        </div>
        <AutoCompactSettings
          data={data}
          usageConfig={autoCompaction}
          idleConfig={idleCompaction}
          model={model}
        />
      </DialogContent>
    </Dialog>
  );
};

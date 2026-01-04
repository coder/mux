import React from "react";
import { Hourglass } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { TokenMeter } from "./RightSidebar/TokenMeter";
import {
  HorizontalThresholdSlider,
  type AutoCompactionConfig,
} from "./RightSidebar/ThresholdSlider";
import { Switch } from "./ui/switch";
import { formatTokens, type TokenMeterData } from "@/common/utils/tokens/tokenMeterUtils";
import { cn } from "@/common/lib/utils";

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
}

/** Tick marks for percentage scale - inline labels only */
const PercentTickMarks: React.FC = () => (
  <div className="text-muted flex justify-between text-[9px]">
    <span>0</span>
    <span>25</span>
    <span>50</span>
    <span>75</span>
    <span>100%</span>
  </div>
);

/** Unified auto-compact settings panel */
const AutoCompactSettings: React.FC<{
  data: TokenMeterData;
  usageConfig?: AutoCompactionConfig;
  idleConfig?: IdleCompactionConfig;
}> = ({ data, usageConfig, idleConfig }) => {
  const [idleInputValue, setIdleInputValue] = React.useState(idleConfig?.hours?.toString() ?? "24");

  // Sync idle input when external hours change
  React.useEffect(() => {
    setIdleInputValue(idleConfig?.hours?.toString() ?? "24");
  }, [idleConfig?.hours]);

  const totalDisplay = formatTokens(data.totalTokens);
  const maxDisplay = data.maxTokens ? ` / ${formatTokens(data.maxTokens)}` : "";
  const percentageDisplay = data.maxTokens ? ` (${data.totalPercentage.toFixed(1)}%)` : "";

  const showUsageSlider = usageConfig && data.maxTokens;
  const isUsageEnabled = usageConfig && usageConfig.threshold < 100;
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
    <div className="flex flex-col gap-3">
      {/* Context Usage display */}
      <div className="flex items-baseline justify-between">
        <span className="text-foreground font-medium">Context Usage</span>
        <span className="text-muted text-xs">
          {totalDisplay}
          {maxDisplay}
          {percentageDisplay}
        </span>
      </div>

      {/* Token meter with threshold slider */}
      <div className="relative w-full overflow-hidden py-2">
        <TokenMeter segments={data.segments} orientation="horizontal" />
        {showUsageSlider && <HorizontalThresholdSlider config={usageConfig} />}
      </div>

      {/* Tick marks */}
      {showUsageSlider && <PercentTickMarks />}

      {/* Auto-Compact Triggers section */}
      <div className="border-separator-light space-y-2 border-t pt-3">
        <div className="text-foreground text-[11px] font-medium">Auto-Compact Triggers</div>

        {/* Usage-based trigger */}
        {usageConfig && data.maxTokens && (
          <div className="bg-background-secondary rounded px-2 py-1.5">
            <div className="flex items-center justify-between">
              <span className="text-foreground text-[11px] font-medium">Usage-based</span>
              <span className="text-muted text-[11px]">
                {isUsageEnabled ? `at ${usageConfig.threshold}%` : "Off"}
              </span>
            </div>
            <div className="text-muted mt-0.5 text-[10px]">Drag threshold on meter above</div>
          </div>
        )}

        {/* Idle-based trigger */}
        {idleConfig && (
          <div className="bg-background-secondary rounded px-2 py-1.5">
            <div className="flex items-center justify-between">
              <span className="text-foreground text-[11px] font-medium">Idle-based</span>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={1}
                  value={idleInputValue}
                  onChange={(e) => setIdleInputValue(e.target.value)}
                  onBlur={handleIdleBlur}
                  disabled={!isIdleEnabled}
                  className={cn(
                    "border-border-medium bg-background focus:border-accent h-5 w-10 rounded border px-1 text-center text-[11px] focus:outline-none",
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
            <div className="text-muted mt-0.5 text-[10px]">Compact after workspace inactivity</div>
          </div>
        )}
      </div>

      {/* Warning for unknown model limits */}
      {!data.maxTokens && (
        <div className="text-subtle text-[10px] italic">
          Unknown model limits - showing relative usage only
        </div>
      )}
    </div>
  );
};

export const ContextUsageIndicatorButton: React.FC<ContextUsageIndicatorButtonProps> = ({
  data,
  autoCompaction,
  idleCompaction,
}) => {
  const [popoverOpen, setPopoverOpen] = React.useState(false);

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

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <Tooltip {...(popoverOpen ? { open: false } : {})}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              aria-label={ariaLabel}
              className="hover:bg-sidebar-hover flex h-6 cursor-pointer items-center gap-1.5 rounded px-1"
              type="button"
            >
              {/* Idle compaction badge - shows hourglass with hours when enabled */}
              {isIdleCompactionEnabled && (
                <div
                  className="text-muted flex items-center gap-0.5 text-[10px]"
                  title={`Auto-compact after ${idleHours}h idle`}
                >
                  <Hourglass className="h-3 w-3" />
                  <span>{idleHours}h</span>
                </div>
              )}
              {/* Show meter when there's usage, or show empty placeholder for settings access */}
              {data.totalTokens > 0 ? (
                <div className="relative h-2 w-20">
                  <TokenMeter
                    segments={data.segments}
                    orientation="horizontal"
                    className="h-2"
                    trackClassName="bg-dark"
                  />
                  {isAutoCompactionEnabled && (
                    <CompactThresholdIndicator threshold={autoCompaction.threshold} />
                  )}
                </div>
              ) : (
                /* Empty meter placeholder - allows access to settings with no usage */
                <div className="bg-dark relative h-2 w-20 rounded-full" />
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" className="w-80">
          <AutoCompactSettings
            data={data}
            usageConfig={autoCompaction}
            idleConfig={idleCompaction}
          />
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        side="bottom"
        align="end"
        className="bg-modal-bg border-separator-light w-80 overflow-visible rounded px-[10px] py-[6px] text-[11px] font-normal shadow-[0_2px_8px_rgba(0,0,0,0.4)]"
      >
        <AutoCompactSettings data={data} usageConfig={autoCompaction} idleConfig={idleCompaction} />
      </PopoverContent>
    </Popover>
  );
};

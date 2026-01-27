import React from "react";
import { Hourglass } from "lucide-react";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover";
import { TokenMeter } from "./RightSidebar/TokenMeter";
import {
  HorizontalThresholdSlider,
  type AutoCompactionConfig,
} from "./RightSidebar/ThresholdSlider";
import { Switch } from "./ui/switch";
import { formatTokens, type TokenMeterData } from "@/common/utils/tokens/tokenMeterUtils";
import { cn } from "@/common/lib/utils";

// Selector for Radix portal wrappers - used to detect when clicks/interactions
// originate from nested Radix components (like Tooltip inside the slider)
const RADIX_PORTAL_WRAPPER_SELECTOR = "[data-radix-popper-content-wrapper]" as const;

/**
 * Prevents Popover from dismissing when interaction occurs within a nested
 * Radix portal (e.g., Tooltip inside the slider). Without this, clicking the
 * slider's drag handle triggers onPointerDownOutside because the Tooltip
 * renders to a separate portal outside the Popover's DOM tree.
 */
function preventDismissForRadixPortals(e: {
  target: EventTarget | null;
  preventDefault: () => void;
}) {
  const target = e.target;
  if (target instanceof HTMLElement && target.closest(RADIX_PORTAL_WRAPPER_SELECTOR)) {
    e.preventDefault();
  }
}

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
}> = ({ data, usageConfig, idleConfig }) => {
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

      {/* Idle-based auto-compact */}
      {idleConfig && (
        <div className="border-separator-light border-t pt-2">
          <div className="flex items-center justify-between">
            <span className="text-foreground text-[11px] font-medium">Idle-based auto-compact</span>
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
          <div className="text-muted mt-0.5 text-[10px]">Compact after workspace inactivity</div>
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
}) => {
  const [isPinned, setIsPinned] = React.useState(false);
  const [isHovering, setIsHovering] = React.useState(false);
  const [isInteracting, setIsInteracting] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const closeTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the compaction slider draggable on hover and click by using a single popover.
  // Hover opens it; click pins it until the user clicks away.
  // Close is delayed to allow pointer to travel between trigger and content.

  // Cleanup timeout on unmount
  React.useEffect(() => {
    return () => {
      if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current);
    };
  }, []);

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

  const isOpen = isPinned || isHovering;

  const cancelPendingClose = () => {
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
  };

  const scheduleClose = () => {
    // Don't close if pinned or actively interacting (e.g., dragging slider)
    if (isPinned || isInteracting) return;
    cancelPendingClose();
    closeTimeoutRef.current = setTimeout(() => {
      setIsHovering(false);
    }, 100); // 100ms grace period for pointer to travel between elements
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      cancelPendingClose();
      setIsPinned(false);
      setIsHovering(false);
      setIsInteracting(false);
    }
  };

  const handleTriggerClick = () => {
    setIsPinned((prev) => !prev);
  };

  const handleTriggerPointerEnter = () => {
    cancelPendingClose();
    setIsHovering(true);
  };

  const handleTriggerPointerLeave = (event: React.PointerEvent<HTMLButtonElement>) => {
    const relatedTarget = event.relatedTarget;
    // Don't schedule close if moving directly to content
    if (relatedTarget instanceof Node && contentRef.current?.contains(relatedTarget)) {
      return;
    }
    scheduleClose();
  };

  const handleContentPointerEnter = () => {
    cancelPendingClose();
    setIsHovering(true);
  };

  const handleContentPointerLeave = (event: React.PointerEvent<HTMLDivElement>) => {
    const relatedTarget = event.relatedTarget;
    // Don't schedule close if moving directly to trigger
    if (relatedTarget instanceof Node && triggerRef.current?.contains(relatedTarget)) {
      return;
    }
    scheduleClose();
  };

  // Track mousedown/mouseup to prevent close during drag interactions
  const handleContentMouseDown = () => setIsInteracting(true);
  const handleContentMouseUp = () => setIsInteracting(false);

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverAnchor asChild>
        <button
          ref={triggerRef}
          aria-label={ariaLabel}
          aria-expanded={isOpen}
          aria-haspopup="dialog"
          className="hover:bg-sidebar-hover flex h-6 cursor-pointer items-center gap-1.5 rounded px-1"
          type="button"
          onClick={handleTriggerClick}
          onPointerEnter={handleTriggerPointerEnter}
          onPointerLeave={handleTriggerPointerLeave}
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
      </PopoverAnchor>

      <PopoverContent
        ref={contentRef}
        side="bottom"
        align="end"
        // Invisible hit-area bridge: before: pseudo-element extends 8px above content
        // to cover the sideOffset gap, preventing pointer-leave when crossing the gap
        className="bg-modal-bg border-separator-light w-80 overflow-visible rounded px-[10px] py-[6px] text-[11px] font-normal shadow-[0_2px_8px_rgba(0,0,0,0.4)] before:pointer-events-auto before:absolute before:-top-2 before:right-0 before:left-0 before:h-2 before:content-['']"
        onPointerEnter={handleContentPointerEnter}
        onPointerLeave={handleContentPointerLeave}
        onPointerDownOutside={preventDismissForRadixPortals}
        onMouseDown={handleContentMouseDown}
        onMouseUp={handleContentMouseUp}
      >
        <AutoCompactSettings data={data} usageConfig={autoCompaction} idleConfig={idleCompaction} />
      </PopoverContent>
    </Popover>
  );
};

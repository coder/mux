import React from "react";
import { TooltipWrapper, Tooltip } from "../Tooltip";
import { TokenMeter } from "./TokenMeter";
import { ThresholdSlider, type AutoCompactionConfig } from "./ThresholdSlider";
import {
  type TokenMeterData,
  formatTokens,
  getSegmentLabel,
} from "@/common/utils/tokens/tokenMeterUtils";

interface VerticalTokenMeterProps {
  data: TokenMeterData;
  /** Auto-compaction settings - if provided, shows threshold slider */
  autoCompaction?: AutoCompactionConfig;
}

const VerticalTokenMeterComponent: React.FC<VerticalTokenMeterProps> = ({
  data,
  autoCompaction,
}) => {
  if (data.segments.length === 0) return null;

  const showThresholdSlider = data.maxTokens && autoCompaction;

  return (
    <div
      className="bg-separator border-border-light flex h-full w-5 flex-col items-center border-l py-3"
      data-component="vertical-token-meter"
    >
      {/* Percentage label at top */}
      {data.maxTokens && (
        <div
          className="font-primary text-foreground mb-1 shrink-0 text-center text-[8px] font-semibold"
          data-label="context-percentage"
        >
          {Math.round(data.totalPercentage)}
        </div>
      )}

      {/* Main meter area - this is where the threshold slider lives */}
      <div
        className="relative flex min-h-0 w-full flex-1 flex-col items-center overflow-visible"
        data-wrapper="meter-wrapper"
      >
        {/* Threshold slider: fills entire meter area so percentage maps correctly */}
        {showThresholdSlider && <ThresholdSlider config={autoCompaction} orientation="vertical" />}

        {/* The actual bar with tooltip */}
        <div className="flex w-full flex-1 flex-col items-center px-[6px]">
          <TooltipWrapper>
            <TokenMeter
              segments={data.segments}
              orientation="vertical"
              data-meter="token-bar"
              data-segment-count={data.segments.length}
            />
            <Tooltip>
              <div className="font-primary flex flex-col gap-2 text-xs">
                <div className="text-foreground text-[13px] font-semibold">Last Request</div>
                <div className="border-border-light my-1 border-t" />
                {data.segments.map((seg, i) => (
                  <div key={i} className="flex justify-between gap-4">
                    <div className="flex items-center gap-1.5">
                      <div
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ background: seg.color }}
                      />
                      <span>{getSegmentLabel(seg.type)}</span>
                    </div>
                    <span className="text-foreground font-medium">{formatTokens(seg.tokens)}</span>
                  </div>
                ))}
                <div className="border-border-light my-1 border-t" />
                <div className="text-muted text-[11px]">
                  Total: {formatTokens(data.totalTokens)}
                  {data.maxTokens && ` / ${formatTokens(data.maxTokens)}`}
                  {data.maxTokens && ` (${data.totalPercentage.toFixed(1)}%)`}
                </div>
                <div className="text-dim mt-2 text-[10px] italic">
                  💡 Expand your viewport to see full details
                </div>
              </div>
            </Tooltip>
          </TooltipWrapper>
        </div>
      </div>
    </div>
  );
};

// Memoize to prevent re-renders when data hasn't changed
export const VerticalTokenMeter = React.memo(VerticalTokenMeterComponent);

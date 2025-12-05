import React from "react";
import { TooltipWrapper, Tooltip } from "../Tooltip";
import { TokenMeter } from "./TokenMeter";
import { VerticalThresholdSlider, type AutoCompactionConfig } from "./ThresholdSlider";
import {
  type TokenMeterData,
  formatTokens,
  getSegmentLabel,
} from "@/common/utils/tokens/tokenMeterUtils";

interface VerticalTokenMeterProps {
  data: TokenMeterData;
  /** Auto-compaction settings for threshold slider */
  autoCompaction?: AutoCompactionConfig;
}

const VerticalTokenMeterComponent: React.FC<VerticalTokenMeterProps> = ({
  data,
  autoCompaction,
}) => {
  if (data.segments.length === 0) return null;

  // Scale the bar based on context window usage (0-100%)
  const usagePercentage = data.maxTokens ? data.totalPercentage : 100;

  return (
    <div
      className="bg-sidebar border-border-light flex h-full w-5 flex-col items-center border-l py-3"
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

      {/* Bar container - relative for slider positioning, flex for proportional scaling */}
      <div className="relative flex min-h-0 w-full flex-1 flex-col items-center">
        {/* Used portion - grows based on usage percentage */}
        <div
          className="flex min-h-[20px] w-full flex-col items-center"
          style={{ flex: usagePercentage }}
        >
          {/* [&>*] selector makes TooltipWrapper span fill available space */}
          <div className="flex h-full w-full flex-col items-center [&>*]:flex [&>*]:h-full [&>*]:flex-col">
            <TooltipWrapper>
              <TokenMeter
                segments={data.segments}
                orientation="vertical"
                data-meter="token-bar"
                data-segment-count={data.segments.length}
              />
              <Tooltip position="left">
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
                      <span className="text-foreground font-medium">
                        {formatTokens(seg.tokens)}
                      </span>
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
        {/* Empty portion - takes remaining space */}
        <div className="w-full" style={{ flex: Math.max(0, 100 - usagePercentage) }} />

        {/* Threshold slider overlay - only when autoCompaction config provided and maxTokens known */}
        {autoCompaction && data.maxTokens && <VerticalThresholdSlider config={autoCompaction} />}
      </div>
    </div>
  );
};

// Memoize to prevent re-renders when data hasn't changed
export const VerticalTokenMeter = React.memo(VerticalTokenMeterComponent);

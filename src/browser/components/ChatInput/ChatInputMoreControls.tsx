import React from "react";
import { MoreHorizontal } from "lucide-react";

import { cn } from "@/common/lib/utils";

import { HoverClickPopover } from "@/browser/components/ui/hover-click-popover";
import { ThinkingSliderComponent } from "@/browser/components/ThinkingSlider";
import { ModelSettings } from "@/browser/components/ModelSettings";
import { AgentModePicker } from "@/browser/components/AgentModePicker";
import { ContextUsageIndicatorButton } from "@/browser/components/ContextUsageIndicatorButton";

import { supports1MContext } from "@/common/utils/ai/models";

type ContextUsageProps = React.ComponentProps<typeof ContextUsageIndicatorButton>;

interface ChatInputMoreControlsProps {
  modelString: string;
  contextUsage?: Pick<ContextUsageProps, "data" | "autoCompaction" | "idleCompaction">;
  onComplete?: () => void;
  className?: string;
}

export const ChatInputMoreControls: React.FC<ChatInputMoreControlsProps> = (props) => {
  const showModelSettings = supports1MContext(props.modelString);

  // Note: PopoverContent is portaled to document.body, so container queries from ChatInput
  // won't apply inside this popover. We intentionally render the full set of "overflow"
  // controls here so they remain accessible even when hidden inline.
  const content = (
    <div className="flex flex-col gap-2">
      <div className="text-muted text-[10px] font-medium">More controls</div>

      <div className="flex items-center justify-between gap-3">
        <div className="text-muted text-[10px]">Thinking</div>
        <ThinkingSliderComponent modelString={props.modelString} />
      </div>

      {showModelSettings && (
        <div className="flex items-center justify-between gap-3">
          <div className="text-muted text-[10px]">Model</div>
          <ModelSettings model={props.modelString} />
        </div>
      )}

      {props.contextUsage && (
        <div className="flex items-center justify-between gap-3">
          <div className="text-muted text-[10px]">Context</div>
          <ContextUsageIndicatorButton
            data={props.contextUsage.data}
            autoCompaction={props.contextUsage.autoCompaction}
            idleCompaction={props.contextUsage.idleCompaction}
          />
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <div className="text-muted text-[10px]">Agent</div>
        <AgentModePicker onComplete={props.onComplete} />
      </div>
    </div>
  );

  return (
    <HoverClickPopover
      content={content}
      side="bottom"
      align="end"
      sideOffset={6}
      interactiveContent
      contentClassName={cn(
        "bg-modal-bg text-foreground border border-separator-light rounded",
        "px-2 py-2 text-[11px] font-normal shadow-[0_2px_8px_rgba(0,0,0,0.4)]",
        "w-72"
      )}
    >
      <button
        type="button"
        aria-label="More controls"
        className={cn(
          "border-border-light text-muted hover:bg-hover hover:text-foreground",
          "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border",
          props.className
        )}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
    </HoverClickPopover>
  );
};

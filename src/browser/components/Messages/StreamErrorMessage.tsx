import React from "react";
import { Bug } from "lucide-react";
import { Button } from "@/browser/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/ui/tooltip";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { cn } from "@/common/lib/utils";
import type { DisplayedMessage } from "@/common/types/message";

interface StreamErrorMessageProps {
  message: DisplayedMessage & { type: "stream-error" };
  className?: string;
}

// Note: RetryBarrier handles retry actions. This component only displays the error.
export const StreamErrorMessage: React.FC<StreamErrorMessageProps> = ({ message, className }) => {
  const debugAction = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.OPEN_DEBUG_LLM_REQUEST));
          }}
          aria-label="Open last LLM request debug modal"
          className="text-error/80 hover:text-error h-6 w-6"
        >
          <Bug className="h-3.5 w-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent align="center">
        <div className="flex items-center gap-2">
          <span>Debug last LLM request</span>
          <code className="bg-foreground/5 text-foreground/80 border-foreground/10 rounded-sm border px-1.5 py-0.5 font-mono text-[10px]">
            /debug-llm-request
          </code>
        </div>
      </TooltipContent>
    </Tooltip>
  );

  // Runtime unavailable gets a distinct, friendlier presentation.
  // This is a permanent failure (container/runtime doesn't exist), not a transient stream error.
  // The backend sends "Container unavailable..." for Docker or "Runtime unavailable..." for others.
  if (message.errorType === "runtime_not_ready") {
    // Extract title from error message (e.g., "Container unavailable" or "Runtime unavailable")
    const title = message.error?.split(".")[0] ?? "Runtime Unavailable";
    return (
      <div className={cn("bg-error-bg border border-error rounded px-5 py-4 my-3", className)}>
        <div className="font-primary text-error mb-2 flex items-center gap-2 text-[13px] font-semibold">
          <span className="text-base leading-none">⚠️</span>
          <span>{title}</span>
          <div className="ml-auto flex items-center">{debugAction}</div>
        </div>
        <div className="text-foreground/80 text-[13px] leading-relaxed">{message.error}</div>
      </div>
    );
  }

  const showCount = message.errorCount !== undefined && message.errorCount > 1;

  return (
    <div className={cn("bg-error-bg border border-error rounded px-5 py-4 my-3", className)}>
      <div className="font-primary text-error mb-3 flex items-center gap-2.5 text-[13px] font-semibold tracking-wide">
        <span className="text-base leading-none">●</span>
        <span>Stream Error</span>
        <code className="bg-foreground/5 text-foreground/80 border-foreground/10 rounded-sm border px-2 py-0.5 font-mono text-[10px] tracking-wider uppercase">
          {message.errorType}
        </code>
        <div className="ml-auto flex items-center gap-2">
          {showCount && (
            <span className="text-error rounded-sm bg-red-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wide">
              ×{message.errorCount}
            </span>
          )}
          {debugAction}
        </div>
      </div>
      <div className="text-foreground font-mono text-[13px] leading-relaxed break-words whitespace-pre-wrap">
        {message.error}
      </div>
    </div>
  );
};

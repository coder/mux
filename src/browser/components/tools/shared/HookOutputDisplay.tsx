import React, { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/common/lib/utils";
import type { WithHookOutput } from "@/common/types/tools";
import { formatDuration } from "./toolUtils";

interface HookOutputDisplayProps {
  output: string;
  durationMs?: number;
  className?: string;
}

/**
 * Type guard to check if an object has hook_output.
 */
function hasHookOutput(result: unknown): result is WithHookOutput & { hook_output: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "hook_output" in result &&
    typeof (result as WithHookOutput).hook_output === "string"
  );
}

/**
 * Extract hook_output from a tool result object.
 * Returns null if no hook output or if the result is not an object with hook_output.
 */
export function extractHookOutput(result: unknown): string | null {
  if (!hasHookOutput(result)) return null;
  return result.hook_output.length > 0 ? result.hook_output : null;
}

/**
 * Extract hook_duration_ms from a tool result object.
 * Returns undefined if no duration or if the result is not an object with hook_duration_ms.
 */
export function extractHookDuration(result: unknown): number | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const duration = (result as WithHookOutput).hook_duration_ms;
  return typeof duration === "number" && Number.isFinite(duration) ? duration : undefined;
}

/**
 * Subtle, expandable display for tool hook output.
 * Only shown when a hook produced output (non-empty).
 */
export const HookOutputDisplay: React.FC<HookOutputDisplayProps> = ({
  output,
  durationMs,
  className,
}) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={cn("mt-1.5 px-3", className)}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={cn(
          "flex items-center gap-1 text-[10px] text-muted-foreground/70 hover:text-muted-foreground",
          "transition-colors cursor-pointer select-none"
        )}
      >
        <ChevronRight
          size={12}
          className={cn("transition-transform duration-150", expanded && "rotate-90")}
        />
        <span className="font-medium">hook output</span>
        {durationMs !== undefined && (
          <span className="text-muted-foreground/50">• {formatDuration(durationMs)}</span>
        )}
      </button>
      {expanded && (
        <pre
          className={cn(
            "mt-1 ml-3 px-2 py-1.5 rounded text-[10px] leading-relaxed",
            "bg-muted/30 text-muted-foreground",
            "whitespace-pre-wrap break-words max-h-[150px] overflow-y-auto",
            "border-l-2 border-muted-foreground/20"
          )}
        >
          {output}
        </pre>
      )}
    </div>
  );
};

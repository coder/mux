import React from "react";
import { NestedToolRenderer } from "./NestedToolRenderer";
import type { ToolStatus } from "./toolUtils";
import type { NestedToolCall } from "./codeExecutionTypes";

interface NestedToolsContainerProps {
  calls: NestedToolCall[];
  /** When true, incomplete tools show as interrupted instead of executing */
  parentInterrupted?: boolean;
}

/**
 * Renders nested tool calls as a list.
 * Parent component provides the container styling (dashed border).
 */
export const NestedToolsContainer: React.FC<NestedToolsContainerProps> = ({
  calls,
  parentInterrupted,
}) => {
  if (calls.length === 0) return null;

  return (
    <div className="-mx-3 space-y-3">
      {calls.map((call) => {
        // Check if the result indicates failure (for tools that return { success: boolean })
        const hasFailedResult =
          call.output &&
          typeof call.output === "object" &&
          "success" in call.output &&
          call.output.success === false;

        // Determine status based on tool completion state:
        // - output-available + success: false → "failed" (tool finished with error)
        // - output-available + success: true → "completed" (tool finished successfully)
        // - input-available + parentInterrupted → "interrupted" (tool never finished)
        // - input-available + !parentInterrupted → "executing" (tool still running)
        const status: ToolStatus =
          call.state === "output-available"
            ? hasFailedResult
              ? "failed"
              : "completed"
            : parentInterrupted
              ? "interrupted"
              : "executing";
        return (
          <NestedToolRenderer
            key={call.toolCallId}
            toolName={call.toolName}
            input={call.input}
            output={call.state === "output-available" ? call.output : undefined}
            status={status}
          />
        );
      })}
    </div>
  );
};

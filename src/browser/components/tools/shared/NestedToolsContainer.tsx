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

        // If parent was interrupted and this tool failed, it was interrupted mid-execution.
        // A tool that succeeded before interruption still shows "completed" ✓.
        const status: ToolStatus =
          call.state === "output-available"
            ? parentInterrupted && hasFailedResult
              ? "interrupted"
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

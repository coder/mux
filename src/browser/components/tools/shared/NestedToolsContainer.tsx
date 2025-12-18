import React from "react";
import { NestedToolRenderer } from "./NestedToolRenderer";
import type { ToolStatus } from "./toolUtils";
import type { NestedToolCall } from "./codeExecutionTypes";

interface NestedToolsContainerProps {
  calls: NestedToolCall[];
}

/**
 * Renders nested tool calls as a list.
 * Parent component provides the container styling (dashed border).
 */
export const NestedToolsContainer: React.FC<NestedToolsContainerProps> = ({ calls }) => {
  if (calls.length === 0) return null;

  return (
    <div className="-mx-3 space-y-3">
      {calls.map((call) => {
        const status: ToolStatus = call.state === "output-available" ? "completed" : "executing";
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

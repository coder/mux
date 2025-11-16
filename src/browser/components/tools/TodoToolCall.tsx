import React from "react";
import type { TodoWriteToolArgs, TodoWriteToolResult } from "@/common/types/tools";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  StatusIndicator,
  ToolDetails,
} from "./shared/ToolPrimitives";
import { useToolExpansion, getStatusDisplay, type ToolStatus } from "./shared/toolUtils";
import { TooltipWrapper, Tooltip } from "../Tooltip";
import { TodoList } from "../TodoList";

interface TodoToolCallProps {
  args: TodoWriteToolArgs;
  result?: TodoWriteToolResult;
  status?: ToolStatus;
}

export const TodoToolCall: React.FC<TodoToolCallProps> = ({
  args,
  result: _result,
  status = "pending",
}) => {
  const { expanded, toggleExpanded } = useToolExpansion(false); // Collapsed by default
  const statusDisplay = getStatusDisplay(status);

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <TooltipWrapper inline>
          <span>📋</span>
          <Tooltip>todo_write</Tooltip>
        </TooltipWrapper>
        <StatusIndicator status={status}>{statusDisplay}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <TodoList todos={args.todos} />
        </ToolDetails>
      )}
    </ToolContainer>
  );
};

import React from "react";

import type { AgentReportToolArgs, AgentReportToolResult } from "@/common/types/tools";

import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  ToolName,
  StatusIndicator,
  ToolDetails,
  ToolIcon,
  ErrorBox,
} from "./shared/ToolPrimitives";
import {
  useToolExpansion,
  getStatusDisplay,
  isToolErrorResult,
  type ToolStatus,
} from "./shared/toolUtils";
import { MarkdownRenderer } from "../Messages/MarkdownRenderer";

interface AgentReportToolCallProps {
  args: AgentReportToolArgs;
  result?: AgentReportToolResult;
  status?: ToolStatus;
}

export const AgentReportToolCall: React.FC<AgentReportToolCallProps> = ({
  args,
  result,
  status = "pending",
}) => {
  // Default to expanded: the report is the entire point of this tool.
  const { expanded, toggleExpanded } = useToolExpansion(true);

  const errorResult = isToolErrorResult(result) ? result : null;

  const title = args.title ?? "Agent report";

  // Show a small preview when collapsed so the card still has some useful context.
  const firstLine = args.reportMarkdown.trim().split("\n")[0] ?? "";
  const preview = firstLine.length > 80 ? firstLine.slice(0, 80).trim() + "…" : firstLine;

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="agent_report" />
        <ToolName>{title}</ToolName>
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <div className="text-[11px]">
            <MarkdownRenderer content={args.reportMarkdown} />
          </div>
          {errorResult && <ErrorBox className="mt-2">{errorResult.error}</ErrorBox>}
        </ToolDetails>
      )}

      {!expanded && preview && (
        <div className="text-muted mt-1 truncate text-[10px]">{preview}</div>
      )}
    </ToolContainer>
  );
};

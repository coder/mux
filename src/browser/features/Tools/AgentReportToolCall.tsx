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
} from "./Shared/ToolPrimitives";
import {
  useToolExpansion,
  getStatusDisplay,
  isToolErrorResult,
  type ToolStatus,
} from "./Shared/toolUtils";
import { MarkdownRenderer } from "../Messages/MarkdownRenderer";

interface LegacyAgentReportFileArgs {
  reportMarkdownPath?: string | null;
  structuredOutputPath?: string | null;
  title?: string | null;
}

type AgentReportRenderableArgs = AgentReportToolArgs | LegacyAgentReportFileArgs;

interface AgentReportToolCallProps {
  args: AgentReportRenderableArgs;
  result?: AgentReportToolResult;
  status?: ToolStatus;
}

function getSubmittedReportMarkdown(
  args: AgentReportRenderableArgs,
  result: AgentReportToolResult | undefined
): string {
  if (result && "success" in result && result.success === true && result.report?.reportMarkdown) {
    return result.report.reportMarkdown;
  }
  if ("reportMarkdown" in args) {
    return args.reportMarkdown;
  }
  return `Report file: ${args.reportMarkdownPath ?? "report.md"}`;
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
  const reportMarkdown = getSubmittedReportMarkdown(args, result);

  // Show a small preview when collapsed so the card still has some useful context.
  const firstLine = reportMarkdown.trim().split("\n")[0] ?? "";
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
          <MarkdownRenderer content={reportMarkdown} className="text-[11px]" />
          {errorResult && <ErrorBox className="mt-2">{errorResult.error}</ErrorBox>}
        </ToolDetails>
      )}

      {!expanded && preview && (
        <div className="text-muted mt-1 truncate text-[10px]">{preview}</div>
      )}
    </ToolContainer>
  );
};

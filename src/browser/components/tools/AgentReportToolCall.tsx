import React from "react";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  ToolName,
  StatusIndicator,
  ToolDetails,
} from "./shared/ToolPrimitives";
import { getStatusDisplay, useToolExpansion, type ToolStatus } from "./shared/toolUtils";
import { CompactingMessageContent } from "../Messages/CompactingMessageContent";
import { MarkdownRenderer } from "../Messages/MarkdownRenderer";

interface AgentReportToolCallProps {
  args?: unknown;
  result?: unknown;
  status?: ToolStatus;
}

function extractAgentReportFields(args: unknown): { reportMarkdown: string; title?: string } {
  if (typeof args !== "object" || args === null) {
    return { reportMarkdown: "" };
  }

  const maybe = args as { reportMarkdown?: unknown; title?: unknown };
  const reportMarkdown = typeof maybe.reportMarkdown === "string" ? maybe.reportMarkdown : "";
  const title =
    typeof maybe.title === "string" && maybe.title.trim().length > 0 ? maybe.title : undefined;

  return { reportMarkdown, title };
}

function inferTitleFromMarkdown(markdown: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(markdown);
  const title = match?.[1]?.trim();
  return title && title.length > 0 ? title : undefined;
}

export const AgentReportToolCall: React.FC<AgentReportToolCallProps> = ({
  args,
  result: _result,
  status = "pending",
}) => {
  const { reportMarkdown, title: titleFromArgs } = extractAgentReportFields(args);
  const title = titleFromArgs ?? inferTitleFromMarkdown(reportMarkdown) ?? "Report";

  // Expand by default while executing so the user sees the report being written.
  const { expanded, toggleExpanded } = useToolExpansion(status === "executing");
  const statusDisplay = getStatusDisplay(status);

  const hasContent = reportMarkdown.trim().length > 0;

  const content =
    status === "executing" ? (
      <CompactingMessageContent>
        {hasContent ? (
          <pre className="bg-code-bg m-0 rounded-sm p-2 text-[11px] leading-relaxed break-words whitespace-pre-wrap">
            {reportMarkdown}
          </pre>
        ) : (
          <div className="font-primary text-secondary italic">Writing report...</div>
        )}
      </CompactingMessageContent>
    ) : hasContent ? (
      <MarkdownRenderer content={reportMarkdown} />
    ) : (
      <div className="font-primary text-secondary italic">No report content</div>
    );

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolName>agent_report</ToolName>
        <StatusIndicator status={status}>{statusDisplay}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <div className="mb-2 text-[11px] font-medium">{title}</div>
          {content}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};

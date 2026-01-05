import React from "react";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  StatusIndicator,
  ToolDetails,
  DetailSection,
  DetailLabel,
  LoadingDots,
  ToolIcon,
} from "./shared/ToolPrimitives";
import { useToolExpansion, getStatusDisplay, type ToolStatus } from "./shared/toolUtils";
import { JsonHighlight } from "./shared/HighlightedCode";

interface WebSearchToolCallProps {
  args: { query: string };
  result?: unknown;
  status?: ToolStatus;
}

/**
 * Check if results contain encrypted content (Anthropic's web_search returns encrypted results)
 */
function isEncryptedResult(result: unknown): boolean {
  if (!Array.isArray(result)) return false;
  return result.some(
    (item) =>
      item !== null &&
      typeof item === "object" &&
      "encryptedContent" in item &&
      typeof (item as Record<string, unknown>).encryptedContent === "string"
  );
}

export const WebSearchToolCall: React.FC<WebSearchToolCallProps> = ({
  args,
  result,
  status = "pending",
}) => {
  const { expanded, toggleExpanded } = useToolExpansion();
  const encrypted = isEncryptedResult(result);
  const resultCount = Array.isArray(result) ? result.length : 0;

  return (
    <ToolContainer expanded={expanded} className="@container">
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon emoji="🌐" toolName="web_search" />
        <div className="text-text flex max-w-96 min-w-0 items-center gap-1.5">
          <span className="font-monospace truncate">{args.query}</span>
        </div>
        {result !== undefined && resultCount > 0 && (
          <span className="text-secondary ml-2 text-[10px] whitespace-nowrap">
            {resultCount} result{resultCount !== 1 ? "s" : ""}
            {encrypted && " (encrypted)"}
          </span>
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <DetailSection>
            <div className="bg-code-bg flex flex-wrap gap-4 rounded px-2 py-1.5 text-[11px] leading-[1.4]">
              <div className="flex min-w-0 gap-1.5">
                <span className="text-secondary font-medium">Query:</span>
                <span className="text-text">{args.query}</span>
              </div>
            </div>
          </DetailSection>

          {result !== undefined && !encrypted && (
            <DetailSection>
              <DetailLabel>Results</DetailLabel>
              <div className="bg-code-bg max-h-[300px] overflow-y-auto rounded px-3 py-2 text-[12px]">
                <JsonHighlight value={result} />
              </div>
            </DetailSection>
          )}



          {status === "executing" && !result && (
            <DetailSection>
              <div className="text-secondary text-[11px]">
                Searching
                <LoadingDots />
              </div>
            </DetailSection>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};

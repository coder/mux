import React from "react";
import type { WebFetchToolArgs, WebFetchToolResult } from "@/common/types/tools";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  StatusIndicator,
  ToolDetails,
  DetailSection,
  DetailLabel,
  LoadingDots,
} from "./shared/ToolPrimitives";
import { useToolExpansion, getStatusDisplay, type ToolStatus } from "./shared/toolUtils";
import { TooltipWrapper, Tooltip } from "../Tooltip";
import { MarkdownRenderer } from "../Messages/MarkdownRenderer";

interface WebFetchToolCallProps {
  args: WebFetchToolArgs;
  result?: WebFetchToolResult;
  status?: ToolStatus;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Extract domain from URL for compact display
 */
function getDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return url;
  }
}

export const WebFetchToolCall: React.FC<WebFetchToolCallProps> = ({
  args,
  result,
  status = "pending",
}) => {
  const { expanded, toggleExpanded } = useToolExpansion();

  const domain = getDomain(args.url);

  return (
    <ToolContainer expanded={expanded} className="@container">
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <TooltipWrapper inline>
          <span>🌐</span>
          <Tooltip>web_fetch</Tooltip>
        </TooltipWrapper>
        <div className="text-text flex max-w-96 min-w-0 items-center gap-1.5">
          <span className="font-monospace truncate">{domain}</span>
        </div>
        {result && result.success && (
          <span className="text-secondary ml-2 text-[10px] whitespace-nowrap">
            <span className="hidden @sm:inline">fetched </span>
            {formatBytes(result.length)}
          </span>
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <DetailSection>
            <div className="bg-code-bg flex flex-wrap gap-4 rounded px-2 py-1.5 text-[11px] leading-[1.4]">
              <div className="flex min-w-0 gap-1.5">
                <span className="text-secondary font-medium">URL:</span>
                <a
                  href={args.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-link font-monospace truncate hover:underline"
                >
                  {args.url}
                </a>
              </div>
              {result && result.success && result.title && (
                <div className="flex min-w-0 gap-1.5">
                  <span className="text-secondary font-medium">Title:</span>
                  <span className="text-text truncate">{result.title}</span>
                </div>
              )}
            </div>
          </DetailSection>

          {result && (
            <>
              {result.success === false && result.error && (
                <DetailSection>
                  <DetailLabel>Error</DetailLabel>
                  <div className="text-danger bg-danger-overlay border-danger rounded border-l-2 px-2 py-1.5 text-[11px]">
                    {result.error}
                  </div>
                </DetailSection>
              )}

              {result.success && result.content && (
                <DetailSection>
                  <DetailLabel>Content</DetailLabel>
                  <div className="bg-code-bg max-h-[300px] overflow-y-auto rounded px-3 py-2 text-[12px]">
                    <MarkdownRenderer content={result.content} />
                  </div>
                </DetailSection>
              )}
            </>
          )}

          {status === "executing" && !result && (
            <DetailSection>
              <div className="text-secondary text-[11px]">
                Fetching page
                <LoadingDots />
              </div>
            </DetailSection>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};

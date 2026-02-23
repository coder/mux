import React from "react";
import type { WebFetchToolArgs } from "@/common/types/tools";
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
  ErrorBox,
} from "./shared/ToolPrimitives";
import { useToolExpansion, getStatusDisplay, type ToolStatus } from "./shared/toolUtils";
import { MarkdownRenderer } from "../Messages/MarkdownRenderer";

interface WebFetchToolCallProps {
  args: WebFetchToolArgs;
  // result is unknown because we handle two formats:
  //   1. Built-in:  { success: boolean, title?, content?, length?, error? }
  //   2. Anthropic native success:  { type: 'web_fetch_result', url, content: { title, source: { data } } }
  //   3. Anthropic native error:    { type: 'web_fetch_tool_result_error', errorCode: string }
  result?: unknown;
  status?: ToolStatus;
}

/** Normalized display data extracted from any web_fetch result format */
interface NormalizedResult {
  success: boolean;
  title?: string;
  content?: string;
  length?: number;
  error?: string;
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

/**
 * Unwrap JSON container from streamManager's stripEncryptedContent.
 * Results arrive as { type: "json", value: [...] } or direct object.
 */
function unwrapResult(result: unknown): unknown {
  if (
    result !== null &&
    typeof result === "object" &&
    "type" in result &&
    (result as { type: string }).type === "json" &&
    "value" in result
  ) {
    return (result as { value: unknown }).value;
  }
  return result;
}

/**
 * Normalize any web_fetch result to a display-friendly format.
 * Handles both our built-in format and Anthropic's native web_fetch format.
 */
function normalizeResult(result: unknown): NormalizedResult | null {
  if (result == null) return null;
  const r = unwrapResult(result);
  if (r == null || typeof r !== "object") return null;
  const obj = r as Record<string, unknown>;

  // Anthropic native success: { type: 'web_fetch_result', url, content: { title, source: { data } } }
  if (obj.type === "web_fetch_result") {
    const contentBlock = obj.content as Record<string, unknown> | undefined;
    const source = contentBlock?.source as Record<string, unknown> | undefined;
    // Only text sources have readable content; PDFs (base64) are not rendered
    const text = source?.type === "text" ? (source.data as string) : undefined;
    return {
      success: true,
      title: (contentBlock?.title as string | null | undefined) ?? undefined,
      content: text,
      length: text?.length,
    };
  }

  // Anthropic native error: { type: 'web_fetch_tool_result_error', errorCode: string }
  if (obj.type === "web_fetch_tool_result_error") {
    const errorCode = obj.errorCode as string | undefined;
    return {
      success: false,
      error: errorCode ? `Fetch failed (${errorCode})` : "Fetch failed",
    };
  }

  // Built-in format: { success: boolean, title?, content?, length?, error? }
  if (typeof obj.success === "boolean") {
    return {
      success: obj.success,
      title: obj.title as string | undefined,
      content: obj.content as string | undefined,
      length: obj.length as number | undefined,
      error: obj.error as string | undefined,
    };
  }

  return null;
}

export const WebFetchToolCall: React.FC<WebFetchToolCallProps> = ({
  args,
  result,
  status = "pending",
}) => {
  const { expanded, toggleExpanded } = useToolExpansion();
  const normalized = normalizeResult(result);

  const domain = getDomain(args.url);

  return (
    <ToolContainer expanded={expanded} className="@container">
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="web_fetch" />
        <div className="text-text flex max-w-96 min-w-0 items-center gap-1.5">
          <span className="font-monospace truncate">{domain}</span>
        </div>
        {normalized?.success && normalized.length != null && (
          <span className="text-secondary ml-2 text-[10px] whitespace-nowrap">
            <span className="hidden @sm:inline">fetched </span>
            {formatBytes(normalized.length)}
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
              {normalized?.success && normalized.title && (
                <div className="flex min-w-0 gap-1.5">
                  <span className="text-secondary font-medium">Title:</span>
                  <span className="text-text truncate">{normalized.title}</span>
                </div>
              )}
            </div>
          </DetailSection>

          {normalized && (
            <>
              {normalized.success === false && normalized.error && (
                <DetailSection>
                  <DetailLabel>Error</DetailLabel>
                  <ErrorBox>{normalized.error}</ErrorBox>
                </DetailSection>
              )}

              {/* Show content for both success and error responses (error pages may have parsed content) */}
              {normalized.content && (
                <DetailSection>
                  <DetailLabel>{normalized.success ? "Content" : "Error Page Content"}</DetailLabel>
                  <div className="bg-code-bg max-h-[300px] overflow-y-auto rounded px-3 py-2 text-[12px]">
                    <MarkdownRenderer content={normalized.content} />
                  </div>
                </DetailSection>
              )}
            </>
          )}

          {status === "executing" && !normalized && (
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

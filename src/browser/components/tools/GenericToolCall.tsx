import React from "react";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  ToolIcon,
  TOOL_NAME_TO_ICON,
  ToolName,
  StatusIndicator,
  ToolDetails,
  DetailSection,
  DetailLabel,
  DetailContent,
  LoadingDots,
} from "./shared/ToolPrimitives";
import { useToolExpansion, getStatusDisplay, type ToolStatus } from "./shared/toolUtils";
import { JsonHighlight } from "./shared/HighlightedCode";
import { ToolResultImages, extractImagesFromToolResult } from "./shared/ToolResultImages";

interface GenericToolCallProps {
  toolName: string;
  args?: unknown;
  result?: unknown;
  status?: ToolStatus;
}

/**
 * Filter out image data from result for JSON display (to avoid showing huge base64 strings).
 * Replaces media content with a placeholder indicator.
 */
function filterResultForDisplay(result: unknown): unknown {
  if (typeof result !== "object" || result === null) return result;

  const contentResult = result as { type?: string; value?: unknown[] };
  if (contentResult.type !== "content" || !Array.isArray(contentResult.value)) return result;

  // Replace media entries with placeholder
  const filteredValue = contentResult.value.map((item) => {
    if (typeof item === "object" && item !== null && (item as { type?: string }).type === "media") {
      const mediaItem = item as { mediaType?: string };
      return { type: "media", mediaType: mediaItem.mediaType, data: "[image data]" };
    }
    return item;
  });

  return { ...contentResult, value: filteredValue };
}

export const GenericToolCall: React.FC<GenericToolCallProps> = ({
  toolName,
  args,
  result,
  status = "pending",
}) => {
  const { expanded, toggleExpanded } = useToolExpansion();

  const hasDetails = args !== undefined || result !== undefined;
  const images = extractImagesFromToolResult(result);
  const hasImages = images.length > 0;

  // Auto-expand if there are images to show
  const shouldShowDetails = expanded || hasImages;

  return (
    <ToolContainer expanded={shouldShowDetails}>
      <ToolHeader onClick={() => hasDetails && toggleExpanded()}>
        {hasDetails && <ExpandIcon expanded={shouldShowDetails}>▶</ExpandIcon>}
        {TOOL_NAME_TO_ICON[toolName] && <ToolIcon toolName={toolName} />}
        <ToolName>{toolName}</ToolName>
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {/* Always show images if present */}
      {hasImages && <ToolResultImages result={result} />}

      {expanded && hasDetails && (
        <ToolDetails>
          {args !== undefined && (
            <DetailSection>
              <DetailLabel>Arguments</DetailLabel>
              <DetailContent>
                <JsonHighlight value={args} />
              </DetailContent>
            </DetailSection>
          )}

          {result !== undefined && (
            <DetailSection>
              <DetailLabel>Result</DetailLabel>
              <DetailContent>
                <JsonHighlight value={filterResultForDisplay(result)} />
              </DetailContent>
            </DetailSection>
          )}

          {status === "executing" && !result && (
            <DetailSection>
              <DetailContent>
                Waiting for result
                <LoadingDots />
              </DetailContent>
            </DetailSection>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};

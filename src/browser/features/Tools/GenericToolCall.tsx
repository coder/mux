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
} from "./Shared/ToolPrimitives";
import { useToolExpansion, getStatusDisplay, type ToolStatus } from "./Shared/toolUtils";
import { JsonHighlight } from "./Shared/HighlightedCode";
import { redactToolResultAttachmentsForDisplay } from "./Shared/toolResultDisplay";
import { ToolResultImages, extractImagesFromToolResult } from "./Shared/ToolResultImages";

interface GenericToolCallProps {
  toolName: string;
  args?: unknown;
  result?: unknown;
  status?: ToolStatus;
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
                <JsonHighlight value={redactToolResultAttachmentsForDisplay(result)} />
              </DetailContent>
            </DetailSection>
          )}

          {status === "executing" && result === undefined && (
            <DetailSection>
              <DetailContent>
                Waiting for result
                <LoadingDots />
              </DetailContent>
            </DetailSection>
          )}
          {status === "redacted" && (
            <DetailSection>
              <DetailContent className="text-muted italic">
                Output excluded from shared transcript
              </DetailContent>
            </DetailSection>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};

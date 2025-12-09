import React from "react";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
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

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={() => hasDetails && toggleExpanded()}>
        {hasDetails && <ExpandIcon expanded={expanded}>▶</ExpandIcon>}
        <ToolName>{toolName}</ToolName>
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

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
                <JsonHighlight value={result} />
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

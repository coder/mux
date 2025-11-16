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
import {
  useToolExpansion,
  getStatusDisplay,
  formatValue,
  type ToolStatus,
} from "./shared/toolUtils";

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

  // Check if result contains an error
  // Handles two formats:
  // 1. Tool implementation errors: { success: false, error: "..." }
  // 2. AI SDK tool-error events: { error: "..." }
  const hasError =
    result &&
    typeof result === "object" &&
    "error" in result &&
    typeof result.error === "string" &&
    result.error.length > 0 &&
    (!("success" in result) || result.success === false);

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
              <DetailContent>{formatValue(args)}</DetailContent>
            </DetailSection>
          )}

          {hasError ? (
            <DetailSection>
              <DetailLabel>Error</DetailLabel>
              <div className="text-danger bg-danger-overlay border-danger rounded border-l-2 px-2 py-1.5 text-[11px]">
                {String((result as { error: string }).error)}
              </div>
            </DetailSection>
          ) : null}

          {result !== undefined && !hasError && (
            <DetailSection>
              <DetailLabel>Result</DetailLabel>
              <DetailContent>{formatValue(result)}</DetailContent>
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

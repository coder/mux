import React from "react";
import { AlertTriangle } from "lucide-react";

import { MarkdownRenderer } from "../Messages/MarkdownRenderer";
import { cn } from "@/common/lib/utils";
import {
  type AdvisorLivePhaseState,
  useAdvisorToolLivePhase,
} from "@/browser/stores/WorkspaceStore";
import { formatModelDisplayName } from "@/common/utils/ai/modelDisplay";
import { getModelName } from "@/common/utils/ai/models";
import { JsonHighlight } from "./Shared/HighlightedCode";
import { ElapsedTimeDisplay } from "./Shared/ElapsedTimeDisplay";
import {
  DetailContent,
  DetailLabel,
  DetailSection,
  ErrorBox,
  ExpandIcon,
  LoadingDots,
  StatusIndicator,
  ToolContainer,
  ToolDetails,
  ToolHeader,
  ToolIcon,
  ToolName,
} from "./Shared/ToolPrimitives";
import { getStatusDisplay, type ToolStatus, useToolExpansion } from "./Shared/toolUtils";

interface AdvisorToolCallProps {
  args: Record<string, unknown>;
  result?: unknown;
  status?: string;
  workspaceId?: string;
  toolCallId?: string;
  startedAt?: number;
}

type AdvisorToolResult =
  | {
      type: "advice";
      advice: string;
      advisorModel: string;
      reasoningLevel?: string;
      remainingUses: number | null;
    }
  | {
      type: "limit_reached";
      advisorModel: string;
      reasoningLevel?: string;
      message: string;
    }
  | {
      type: "error";
      message: string;
    };

interface AdvisorStatusPresentation {
  status: ToolStatus;
  className?: string;
  content: React.ReactNode;
}

const TRAILING_MODEL_DATE_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;
const ADVISOR_PHASE_LABELS: Record<AdvisorLivePhaseState["phase"], string> = {
  preparing_context: "Preparing context",
  waiting_for_response: "Waiting for response",
  finalizing_result: "Finalizing result",
};

function isToolStatus(value: string | undefined): value is ToolStatus {
  switch (value) {
    case "pending":
    case "executing":
    case "completed":
    case "failed":
    case "interrupted":
    case "backgrounded":
    case "redacted":
      return true;
    default:
      return false;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRemainingUses(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

function isAdvisorToolResult(value: unknown): value is AdvisorToolResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const reasoningLevel = record.reasoningLevel;
  const hasValidReasoningLevel = reasoningLevel === undefined || isNonEmptyString(reasoningLevel);

  switch (record.type) {
    case "advice":
      return (
        isNonEmptyString(record.advice) &&
        isNonEmptyString(record.advisorModel) &&
        hasValidReasoningLevel &&
        isRemainingUses(record.remainingUses)
      );
    case "limit_reached":
      return (
        isNonEmptyString(record.advisorModel) &&
        hasValidReasoningLevel &&
        isNonEmptyString(record.message)
      );
    case "error":
      return isNonEmptyString(record.message);
    default:
      return false;
  }
}

function formatAdvisorModel(advisorModel: string): { displayName: string; rawModel: string } {
  const rawModel = advisorModel.trim();
  const prettyModelName = formatModelDisplayName(
    getModelName(rawModel).replace(TRAILING_MODEL_DATE_SUFFIX, "")
  );

  return {
    displayName: prettyModelName,
    rawModel,
  };
}

function getAdvisorStatusPresentation(
  result: AdvisorToolResult | null,
  fallbackStatus: ToolStatus
): AdvisorStatusPresentation {
  switch (result?.type) {
    case "advice":
      return {
        status: "completed",
        content: getStatusDisplay("completed"),
      };
    case "limit_reached":
      return {
        status: "completed",
        className: "text-warning",
        content: (
          <>
            <AlertTriangle aria-hidden="true" className="mr-1 inline-block h-3 w-3 align-[-2px]" />
            <span className="status-text">limit reached</span>
          </>
        ),
      };
    case "error":
      return {
        status: "failed",
        content: getStatusDisplay("failed"),
      };
    default:
      return {
        status: fallbackStatus,
        content: getStatusDisplay(fallbackStatus),
      };
  }
}

const MetadataBadge: React.FC<React.HTMLAttributes<HTMLSpanElement>> = ({
  className,
  ...props
}) => (
  <span
    className={cn(
      "inline-flex items-center gap-1 rounded-full border border-white/10 bg-code-bg px-2 py-0.5 text-[10px] leading-none text-secondary",
      className
    )}
    {...props}
  />
);

const AdvisorMetadata: React.FC<{ advisorModel: string; reasoningLevel?: string }> = ({
  advisorModel,
  reasoningLevel,
}) => {
  const model = formatAdvisorModel(advisorModel);

  return (
    <DetailSection>
      <DetailLabel>Model</DetailLabel>
      <div className="flex flex-wrap items-center gap-1.5">
        <MetadataBadge className="text-foreground">{model.displayName}</MetadataBadge>
        {reasoningLevel && <MetadataBadge>reasoning: {reasoningLevel}</MetadataBadge>}
      </div>
      {model.rawModel !== model.displayName && (
        <div className="text-foreground-secondary mt-1 font-mono text-[10px] break-all">
          {model.rawModel}
        </div>
      )}
    </DetailSection>
  );
};

export const AdvisorToolCall: React.FC<AdvisorToolCallProps> = ({
  args: _args,
  result,
  status,
  workspaceId,
  toolCallId,
  startedAt,
}) => {
  const { expanded, toggleExpanded } = useToolExpansion();
  const toolStatus = isToolStatus(status) ? status : "pending";
  const livePhase = useAdvisorToolLivePhase(workspaceId, toolCallId);
  const advisorResult = isAdvisorToolResult(result) ? result : null;
  const hasUnrecognizedResult = result !== undefined && result !== null && advisorResult === null;
  const detailsText =
    advisorResult?.type === "advice"
      ? advisorResult.advice
      : advisorResult?.type === "limit_reached" || advisorResult?.type === "error"
        ? advisorResult.message
        : undefined;
  const statusPresentation = hasUnrecognizedResult
    ? {
        status: "failed" as const,
        content: getStatusDisplay("failed"),
      }
    : getAdvisorStatusPresentation(advisorResult, toolStatus);
  const isExecutingWithoutResult =
    toolStatus === "executing" && advisorResult === null && !hasUnrecognizedResult;
  const executingStatusLabel = livePhase ? ADVISOR_PHASE_LABELS[livePhase.phase] : "Running";
  const headerStatusContent = isExecutingWithoutResult ? (
    <>
      <span>{executingStatusLabel}</span>
      <ElapsedTimeDisplay startedAt={startedAt} isActive={true} />
    </>
  ) : (
    statusPresentation.content
  );

  return (
    <ToolContainer expanded={expanded} className="@container">
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="advisor" />
        <ToolName>advisor</ToolName>
        <StatusIndicator
          status={statusPresentation.status}
          className={statusPresentation.className}
        >
          {headerStatusContent}
        </StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails text={detailsText}>
          {advisorResult?.type === "advice" && (
            <>
              <AdvisorMetadata
                advisorModel={advisorResult.advisorModel}
                reasoningLevel={advisorResult.reasoningLevel}
              />

              <DetailSection>
                <DetailLabel>Advice</DetailLabel>
                <div className="bg-code-bg rounded px-3 py-2 text-[12px] leading-relaxed">
                  <MarkdownRenderer content={advisorResult.advice} preserveLineBreaks />
                </div>
              </DetailSection>

              {advisorResult.remainingUses !== null && (
                <DetailSection>
                  <div className="text-secondary text-[10px]">
                    {advisorResult.remainingUses} remaining use
                    {advisorResult.remainingUses === 1 ? "" : "s"} this turn.
                  </div>
                </DetailSection>
              )}
            </>
          )}

          {advisorResult?.type === "limit_reached" && (
            <>
              <AdvisorMetadata
                advisorModel={advisorResult.advisorModel}
                reasoningLevel={advisorResult.reasoningLevel}
              />

              <DetailSection>
                <DetailLabel>Limit</DetailLabel>
                <div className="bg-warning/10 border-warning/30 text-warning flex items-start gap-2 rounded border px-3 py-2 text-[11px]">
                  <AlertTriangle aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
                  <span>{advisorResult.message}</span>
                </div>
              </DetailSection>
            </>
          )}

          {advisorResult?.type === "error" && (
            <DetailSection>
              <DetailLabel>Error</DetailLabel>
              <ErrorBox>{advisorResult.message}</ErrorBox>
            </DetailSection>
          )}

          {hasUnrecognizedResult && (
            <>
              <DetailSection>
                <DetailLabel>Error</DetailLabel>
                <ErrorBox>Unrecognized advisor tool output shape</ErrorBox>
              </DetailSection>
              <DetailSection>
                <DetailLabel>Result</DetailLabel>
                <DetailContent>
                  <JsonHighlight value={result} />
                </DetailContent>
              </DetailSection>
            </>
          )}

          {isExecutingWithoutResult && (
            <DetailSection>
              <div className="text-secondary text-[11px]">
                {executingStatusLabel}
                <LoadingDots />
                <ElapsedTimeDisplay startedAt={startedAt} isActive={true} />
              </div>
            </DetailSection>
          )}

          {toolStatus === "redacted" && result === undefined && (
            <DetailSection>
              <div className="text-muted text-[11px] italic">
                Output excluded from shared transcript
              </div>
            </DetailSection>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};

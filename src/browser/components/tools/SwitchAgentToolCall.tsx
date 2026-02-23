import React from "react";
import { formatAgentIdLabel } from "@/browser/components/AgentModePicker";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  StatusIndicator,
  ToolDetails,
  DetailSection,
  DetailLabel,
  DetailContent,
  ToolIcon,
} from "./shared/ToolPrimitives";
import { useToolExpansion, getStatusDisplay, type ToolStatus } from "./shared/toolUtils";

interface SwitchAgentToolCallProps {
  args: {
    agentId: string;
    reason?: string | null;
    followUp?: string | null;
  };
  status?: ToolStatus;
}

function getAgentTextColorClass(agentId: string): string {
  switch (agentId) {
    case "plan":
    case "explore":
      return "text-plan-mode";
    case "exec":
      return "text-exec-mode";
    case "auto":
      return "text-auto-mode";
    case "ask":
      return "text-ask-mode";
    default:
      return "text-muted-foreground";
  }
}

export const SwitchAgentToolCall: React.FC<SwitchAgentToolCallProps> = (props) => {
  const { expanded, toggleExpanded } = useToolExpansion(false);
  const status = props.status ?? "pending";
  const hasReason = typeof props.args.reason === "string" && props.args.reason.trim().length > 0;
  const statusDisplay = getStatusDisplay(status);
  const targetAgentLabel = formatAgentIdLabel(props.args.agentId);
  const targetAgentColorClass = getAgentTextColorClass(props.args.agentId);
  const handoffLabel =
    status === "completed"
      ? "Switched to"
      : status === "executing" || status === "pending"
        ? "Delegating to"
        : "Switch to";

  // followUp is intentionally omitted from this tool card because it is
  // already injected as the synthetic follow-up message in the transcript.
  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={hasReason ? toggleExpanded : undefined}>
        {hasReason && <ExpandIcon expanded={expanded}>▶</ExpandIcon>}
        <ToolIcon toolName="switch_agent" />
        <span className="text-muted-foreground italic">
          {handoffLabel}: <span className={targetAgentColorClass}>{targetAgentLabel}</span>
        </span>
        <StatusIndicator status={status}>{statusDisplay}</StatusIndicator>
      </ToolHeader>

      {expanded && hasReason && (
        <ToolDetails>
          <DetailSection>
            <DetailLabel>Reason</DetailLabel>
            <DetailContent className="text-muted-foreground px-2 py-1.5 italic">
              {props.args.reason}
            </DetailContent>
          </DetailSection>
        </ToolDetails>
      )}
    </ToolContainer>
  );
};

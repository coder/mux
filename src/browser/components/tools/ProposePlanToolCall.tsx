import React, { useState } from "react";
import type { ProposePlanToolArgs, ProposePlanToolResult } from "@/common/types/tools";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  ToolName,
  StatusIndicator,
  ToolDetails,
} from "./shared/ToolPrimitives";
import { useToolExpansion, getStatusDisplay, type ToolStatus } from "./shared/toolUtils";
import { MarkdownRenderer } from "../Messages/MarkdownRenderer";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { useStartHere } from "@/browser/hooks/useStartHere";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { TooltipWrapper, Tooltip } from "../Tooltip";
import { cn } from "@/common/lib/utils";

interface ProposePlanToolCallProps {
  args: ProposePlanToolArgs;
  result?: ProposePlanToolResult;
  status?: ToolStatus;
  workspaceId?: string;
}

export const ProposePlanToolCall: React.FC<ProposePlanToolCallProps> = ({
  args,
  result: _result,
  status = "pending",
  workspaceId,
}) => {
  const { expanded, toggleExpanded } = useToolExpansion(true); // Expand by default
  const [showRaw, setShowRaw] = useState(false);

  // Format: Title as H1 + plan content for "Start Here" functionality
  const startHereContent = `# ${args.title}\n\n${args.plan}`;
  const {
    openModal,
    buttonLabel,
    buttonEmoji,
    disabled: startHereDisabled,
    modal,
  } = useStartHere(
    workspaceId,
    startHereContent,
    false // Plans are never already compacted
  );

  // Copy to clipboard with feedback
  const { copied, copyToClipboard } = useCopyToClipboard();

  const [isHovered, setIsHovered] = useState(false);

  const controlButtonClasses =
    "px-2 py-1 text-[10px] font-mono rounded-sm cursor-pointer transition-all duration-150 active:translate-y-px";
  const statusDisplay = getStatusDisplay(status);

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolName>propose_plan</ToolName>
        <StatusIndicator status={status}>{statusDisplay}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <div className="plan-surface rounded-md p-3 shadow-md">
            <div className="plan-divider mb-3 flex items-center gap-2 border-b pb-2">
              <div className="flex flex-1 items-center gap-2">
                <div className="text-base">📋</div>
                <div className="text-plan-mode font-mono text-[13px] font-semibold">
                  {args.title}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                {workspaceId && (
                  <TooltipWrapper inline>
                    <button
                      onClick={openModal}
                      disabled={startHereDisabled}
                      className={cn(
                        controlButtonClasses,
                        "plan-chip",
                        startHereDisabled
                          ? "cursor-not-allowed opacity-50"
                          : "hover:plan-chip-hover active:plan-chip-active"
                      )}
                      onMouseEnter={() => {
                        if (!startHereDisabled) {
                          setIsHovered(true);
                        }
                      }}
                      onMouseLeave={() => setIsHovered(false)}
                    >
                      {isHovered && <span className="mr-1">{buttonEmoji}</span>}
                      {buttonLabel}
                    </button>
                    <Tooltip align="center">Replace all chat history with this plan</Tooltip>
                  </TooltipWrapper>
                )}
                <button
                  onClick={() => void copyToClipboard(args.plan)}
                  className={cn(
                    controlButtonClasses,
                    "plan-chip-ghost hover:plan-chip-ghost-hover"
                  )}
                >
                  {copied ? "✓ Copied" : "Copy"}
                </button>
                <button
                  onClick={() => setShowRaw(!showRaw)}
                  className={cn(
                    controlButtonClasses,
                    showRaw
                      ? "plan-chip hover:plan-chip-hover active:plan-chip-active"
                      : "plan-chip-ghost text-muted hover:plan-chip-ghost-hover"
                  )}
                >
                  {showRaw ? "Show Markdown" : "Show Text"}
                </button>
              </div>
            </div>

            {showRaw ? (
              <pre className="text-text bg-code-bg m-0 rounded-sm p-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
                {args.plan}
              </pre>
            ) : (
              <div className="plan-content">
                <MarkdownRenderer content={args.plan} />
              </div>
            )}

            {status === "completed" && (
              <div className="plan-divider text-muted mt-3 border-t pt-3 text-[11px] leading-normal italic">
                Respond with revisions or switch to Exec mode (
                <span className="font-primary not-italic">
                  {formatKeybind(KEYBINDS.TOGGLE_MODE)}
                </span>
                ) and ask to implement.
              </div>
            )}
          </div>
        </ToolDetails>
      )}

      {modal}
    </ToolContainer>
  );
};

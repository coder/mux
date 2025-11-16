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
          <div
            className="rounded-md p-3 shadow-md"
            style={{
              background:
                "linear-gradient(135deg, color-mix(in srgb, var(--color-plan-mode), transparent 92%) 0%, color-mix(in srgb, var(--color-plan-mode), transparent 95%) 100%)",
              border: "1px solid color-mix(in srgb, var(--color-plan-mode), transparent 70%)",
            }}
          >
            <div
              className="mb-3 flex items-center gap-2 pb-2"
              style={{
                borderBottom:
                  "1px solid color-mix(in srgb, var(--color-plan-mode), transparent 80%)",
              }}
            >
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
                        "px-2 py-1 text-[10px] font-mono rounded-sm cursor-pointer transition-all duration-150",
                        "active:translate-y-px",
                        startHereDisabled ? "opacity-50 cursor-not-allowed" : "hover:text-plan-mode"
                      )}
                      style={{
                        color: "var(--color-plan-mode)",
                        background: "color-mix(in srgb, var(--color-plan-mode), transparent 90%)",
                        border:
                          "1px solid color-mix(in srgb, var(--color-plan-mode), transparent 70%)",
                      }}
                      onMouseEnter={(e) => {
                        if (!startHereDisabled) {
                          setIsHovered(true);
                          (e.currentTarget as HTMLButtonElement).style.background =
                            "color-mix(in srgb, var(--color-plan-mode), transparent 85%)";
                          (e.currentTarget as HTMLButtonElement).style.borderColor =
                            "color-mix(in srgb, var(--color-plan-mode), transparent 60%)";
                        }
                      }}
                      onMouseLeave={(e) => {
                        setIsHovered(false);
                        if (!startHereDisabled) {
                          (e.currentTarget as HTMLButtonElement).style.background =
                            "color-mix(in srgb, var(--color-plan-mode), transparent 90%)";
                          (e.currentTarget as HTMLButtonElement).style.borderColor =
                            "color-mix(in srgb, var(--color-plan-mode), transparent 70%)";
                        }
                      }}
                    >
                      {isHovered && <span className="mr-1">{buttonEmoji}</span>}
                      {buttonLabel}
                    </button>
                    <Tooltip align="center">Replace all chat history with this plan</Tooltip>
                  </TooltipWrapper>
                )}
                <button
                  onClick={() => void copyToClipboard(args.plan)}
                  className="text-muted hover:text-plan-mode cursor-pointer rounded-sm bg-transparent px-2 py-1 font-mono text-[10px] transition-all duration-150 active:translate-y-px"
                  style={{
                    border: "1px solid rgba(136, 136, 136, 0.3)",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background =
                      "color-mix(in srgb, var(--color-plan-mode), transparent 85%)";
                    (e.currentTarget as HTMLButtonElement).style.borderColor =
                      "color-mix(in srgb, var(--color-plan-mode), transparent 60%)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                    (e.currentTarget as HTMLButtonElement).style.borderColor =
                      "rgba(136, 136, 136, 0.3)";
                  }}
                >
                  {copied ? "✓ Copied" : "Copy"}
                </button>
                <button
                  onClick={() => setShowRaw(!showRaw)}
                  className={cn(
                    "px-2 py-1 text-[10px] font-mono rounded-sm cursor-pointer transition-all duration-150 active:translate-y-px hover:text-plan-mode"
                  )}
                  style={{
                    color: showRaw ? "var(--color-plan-mode)" : "#888",
                    background: showRaw
                      ? "color-mix(in srgb, var(--color-plan-mode), transparent 90%)"
                      : "transparent",
                    border: showRaw
                      ? "1px solid color-mix(in srgb, var(--color-plan-mode), transparent 70%)"
                      : "1px solid rgba(136, 136, 136, 0.3)",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background =
                      "color-mix(in srgb, var(--color-plan-mode), transparent 85%)";
                    (e.currentTarget as HTMLButtonElement).style.borderColor =
                      "color-mix(in srgb, var(--color-plan-mode), transparent 60%)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background = showRaw
                      ? "color-mix(in srgb, var(--color-plan-mode), transparent 90%)"
                      : "transparent";
                    (e.currentTarget as HTMLButtonElement).style.borderColor = showRaw
                      ? "color-mix(in srgb, var(--color-plan-mode), transparent 70%)"
                      : "rgba(136, 136, 136, 0.3)";
                  }}
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
              <div
                className="text-muted mt-3 pt-3 text-[11px] leading-normal italic"
                style={{
                  borderTop:
                    "1px solid color-mix(in srgb, var(--color-plan-mode), transparent 80%)",
                }}
              >
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

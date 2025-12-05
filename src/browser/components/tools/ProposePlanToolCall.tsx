import React, { useState, useEffect } from "react";
import type {
  ProposePlanToolResult,
  ProposePlanToolError,
  LegacyProposePlanToolArgs,
  LegacyProposePlanToolResult,
} from "@/common/types/tools";
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
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";
import { cn } from "@/common/lib/utils";
import { useAPI } from "@/browser/contexts/API";

/**
 * Check if the result is from the new file-based propose_plan tool
 */
function isNewProposePlanResult(result: unknown): result is ProposePlanToolResult {
  return (
    result !== null &&
    typeof result === "object" &&
    "success" in result &&
    result.success === true &&
    "planContent" in result &&
    "planPath" in result
  );
}

/**
 * Check if the result is an error from propose_plan tool
 */
function isProposePlanError(result: unknown): result is ProposePlanToolError {
  return (
    result !== null &&
    typeof result === "object" &&
    "success" in result &&
    result.success === false &&
    "error" in result
  );
}

/**
 * Check if the result is from the legacy propose_plan tool
 */
function isLegacyProposePlanResult(result: unknown): result is LegacyProposePlanToolResult {
  return (
    result !== null &&
    typeof result === "object" &&
    "success" in result &&
    result.success === true &&
    "title" in result &&
    "plan" in result
  );
}

/**
 * Check if args are from the legacy propose_plan tool
 */
function isLegacyProposePlanArgs(args: unknown): args is LegacyProposePlanToolArgs {
  return args !== null && typeof args === "object" && "title" in args && "plan" in args;
}

interface ProposePlanToolCallProps {
  args: Record<string, unknown>;
  result?: unknown;
  status?: ToolStatus;
  workspaceId?: string;
  /** Whether this is the latest propose_plan in the conversation */
  isLatest?: boolean;
  /** When true, renders as ephemeral preview (no tool wrapper, shows close button) */
  isEphemeralPreview?: boolean;
  /** Callback when user closes ephemeral preview */
  onClose?: () => void;
  /** Direct content for ephemeral preview (bypasses args/result extraction) */
  content?: string;
  /** Direct path for ephemeral preview */
  path?: string;
  /** Optional className for the outer wrapper */
  className?: string;
}

export const ProposePlanToolCall: React.FC<ProposePlanToolCallProps> = (props) => {
  const {
    args,
    result,
    status = "pending",
    workspaceId,
    isLatest,
    isEphemeralPreview,
    onClose,
    content: directContent,
    path: directPath,
    className,
  } = props;
  const { expanded, toggleExpanded } = useToolExpansion(true); // Expand by default
  const [showRaw, setShowRaw] = useState(false);
  const { api } = useAPI();

  // Fresh content from disk for the latest plan (external edit detection)
  // Skip for ephemeral previews which already have fresh content
  const [freshContent, setFreshContent] = useState<string | null>(null);
  const [freshPath, setFreshPath] = useState<string | null>(null);

  // Check if an editor is available (hides Edit button if not)
  const [canEdit, setCanEdit] = useState(false);

  useEffect(() => {
    if (!api) return;
    void api.general.canOpenInEditor().then((result) => {
      setCanEdit(result.method !== "none");
    });
  }, [api]);

  // Fetch fresh plan content for the latest plan
  // Re-fetches on mount and when window regains focus (after user edits in external editor)
  useEffect(() => {
    if (isEphemeralPreview || !isLatest || !workspaceId || !api) return;

    const fetchPlan = async () => {
      try {
        const res = await api.workspace.getPlanContent({ workspaceId });
        if (res.success) {
          setFreshContent(res.data.content);
          setFreshPath(res.data.path);
        }
      } catch {
        // Fetch failed, use cached content from result
      }
    };

    // Fetch immediately on mount
    void fetchPlan();

    // Re-fetch when window regains focus (user returns from external editor)
    const handleFocus = () => {
      void fetchPlan();
    };
    window.addEventListener("focus", handleFocus);

    return () => {
      window.removeEventListener("focus", handleFocus);
    };
  }, [api, workspaceId, isLatest, isEphemeralPreview]);

  // Determine plan content and title based on result type (prefer result over args)
  // For ephemeral previews, use direct content/path props
  // For the latest plan, prefer fresh content from disk (external edit support)
  let planContent: string;
  let planTitle: string;
  let planPath: string | undefined;
  let errorMessage: string | undefined;

  if (isEphemeralPreview && directContent !== undefined) {
    // Ephemeral preview mode: use direct props
    planContent = directContent;
    planPath = directPath;
    const titleMatch = /^#\s+(.+)$/m.exec(directContent);
    planTitle = titleMatch ? titleMatch[1] : "Plan";
  } else if (isLatest && freshContent !== null) {
    planContent = freshContent;
    planPath = freshPath ?? undefined;
    // Extract title from first markdown heading or use filename
    const titleMatch = /^#\s+(.+)$/m.exec(freshContent);
    planTitle = titleMatch ? titleMatch[1] : (planPath?.split("/").pop() ?? "Plan");
  } else if (isNewProposePlanResult(result)) {
    planContent = result.planContent;
    planPath = result.planPath;
    // Extract title from first markdown heading or use filename
    const titleMatch = /^#\s+(.+)$/m.exec(result.planContent);
    planTitle = titleMatch ? titleMatch[1] : (planPath.split("/").pop() ?? "Plan");
  } else if (isLegacyProposePlanResult(result)) {
    planContent = result.plan;
    planTitle = result.title;
  } else if (isProposePlanError(result)) {
    // Error from backend (e.g., plan file missing or empty)
    planContent = "";
    planTitle = "Plan Error";
    errorMessage = result.error;
  } else if (isLegacyProposePlanArgs(args)) {
    // Fallback to args for backwards compatibility
    planContent = args.plan;
    planTitle = args.title;
  } else {
    // No valid plan data available
    planContent = "";
    planTitle = "Plan";
  }

  // Format: Title as H1 + plan content for "Start Here" functionality
  const startHereContent = `# ${planTitle}\n\n${planContent}`;
  const {
    openModal,
    buttonLabel,
    disabled: startHereDisabled,
    modal,
  } = useStartHere(
    workspaceId,
    startHereContent,
    false // Plans are never already compacted
  );

  // Copy to clipboard with feedback
  const { copied, copyToClipboard } = useCopyToClipboard();

  const handleOpenInEditor = async () => {
    if (!planPath || !api) {
      return;
    }
    try {
      const result = await api.general.openInEditor({
        filePath: planPath,
        workspaceId,
      });
      if (!result.success) {
        console.error("Failed to open plan in editor:", result.error);
        return;
      }
      // If opened in embedded terminal (server mode), open terminal window
      if (
        result.data.openedInEmbeddedTerminal &&
        result.data.workspaceId &&
        result.data.sessionId
      ) {
        const isBrowser = !window.api;
        if (isBrowser) {
          const url = `/terminal.html?workspaceId=${encodeURIComponent(result.data.workspaceId)}&sessionId=${encodeURIComponent(result.data.sessionId)}`;
          window.open(
            url,
            `terminal-editor-${result.data.sessionId}`,
            "width=1000,height=600,popup=yes"
          );
        }
      }
    } catch (err) {
      console.error("openInEditor threw error:", err);
    }
  };

  const controlButtonClasses =
    "px-2 py-1 text-[10px] font-mono rounded-sm cursor-pointer transition-all duration-150 active:translate-y-px";
  const statusDisplay = getStatusDisplay(status);

  // Shared plan UI content (used in both tool call and ephemeral preview modes)
  const planUI = (
    <div className="plan-surface rounded-md p-3 shadow-md">
      <div className="plan-divider mb-3 flex items-center gap-2 border-b pb-2">
        <div className="flex flex-1 items-center gap-2">
          <div className="text-base">📋</div>
          <div className="text-plan-mode font-mono text-[13px] font-semibold">{planTitle}</div>
          {isEphemeralPreview && (
            <div className="text-muted font-mono text-[10px] italic">preview only</div>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {/* Edit button: show for ephemeral preview OR latest tool call, only if editor available */}
          {(isEphemeralPreview ?? isLatest) && planPath && api && canEdit && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => void handleOpenInEditor()}
                  className={cn(
                    controlButtonClasses,
                    "plan-chip-ghost hover:plan-chip-ghost-hover"
                  )}
                >
                  Edit
                </button>
              </TooltipTrigger>
              <TooltipContent align="center">Open plan in external editor</TooltipContent>
            </Tooltip>
          )}
          {/* Start Here button: only for tool calls, not ephemeral previews */}
          {!isEphemeralPreview && workspaceId && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={openModal}
                  disabled={startHereDisabled}
                  className={cn(
                    controlButtonClasses,
                    "plan-chip-ghost",
                    startHereDisabled
                      ? "cursor-not-allowed opacity-50"
                      : "hover:plan-chip-ghost-hover"
                  )}
                >
                  {buttonLabel}
                </button>
              </TooltipTrigger>
              <TooltipContent align="center">
                Replace all chat history with this plan
              </TooltipContent>
            </Tooltip>
          )}
          <button
            onClick={() => void copyToClipboard(planContent)}
            className={cn(controlButtonClasses, "plan-chip-ghost hover:plan-chip-ghost-hover")}
          >
            {copied ? "Copied" : "Copy"}
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
          {/* Close button: only for ephemeral previews */}
          {isEphemeralPreview && onClose && (
            <button
              onClick={onClose}
              className={cn(controlButtonClasses, "plan-chip-ghost hover:plan-chip-ghost-hover")}
              title="Close preview"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {errorMessage ? (
        <div className="text-error rounded-sm p-2 font-mono text-xs">{errorMessage}</div>
      ) : showRaw ? (
        <pre className="text-text bg-code-bg m-0 rounded-sm p-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
          {planContent}
        </pre>
      ) : (
        <div className="plan-content">
          <MarkdownRenderer content={planContent} />
        </div>
      )}

      {/* Completion guidance: only for completed tool calls without errors, not ephemeral previews */}
      {!isEphemeralPreview && status === "completed" && !errorMessage && (
        <div className="plan-divider text-muted mt-3 border-t pt-3 text-[11px] leading-normal italic">
          Respond with revisions or switch to Exec mode (
          <span className="font-primary not-italic">{formatKeybind(KEYBINDS.TOGGLE_MODE)}</span>)
          and ask to implement.
        </div>
      )}
    </div>
  );

  // Ephemeral preview mode: simple wrapper without tool container
  if (isEphemeralPreview) {
    return <div className={cn("px-4 py-2", className)}>{planUI}</div>;
  }

  // Tool call mode: full tool container with header
  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolName>propose_plan</ToolName>
        <StatusIndicator status={status}>{statusDisplay}</StatusIndicator>
      </ToolHeader>

      {expanded && <ToolDetails>{planUI}</ToolDetails>}

      {modal}
    </ToolContainer>
  );
};

import React, { useState, useEffect, useRef } from "react";
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
import { Button } from "../ui/button";
import { IconActionButton, type ButtonConfig } from "../Messages/MessageWindow";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { useStartHere } from "@/browser/hooks/useStartHere";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { cn } from "@/common/lib/utils";
import { useAPI } from "@/browser/contexts/API";
import { useOpenInEditor } from "@/browser/hooks/useOpenInEditor";
import { useOptionalWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { usePopoverError } from "@/browser/hooks/usePopoverError";
import { PopoverError } from "../PopoverError";
import { getAgentIdKey, getPlanContentKey } from "@/common/constants/storage";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { buildSendMessageOptions } from "@/browser/hooks/useSendMessageOptions";
import {
  Clipboard,
  ClipboardCheck,
  ClipboardList,
  FileText,
  ListStart,
  Pencil,
  Play,
  X,
} from "lucide-react";
import { ShareMessagePopover } from "../ShareMessagePopover";

/**
 * Check if the result is a successful file-based propose_plan result.
 * Note: planContent may be absent in newer results (context optimization).
 */
function isProposePlanResult(result: unknown): result is ProposePlanToolResult {
  return (
    result !== null &&
    typeof result === "object" &&
    "success" in result &&
    result.success === true &&
    "planPath" in result
  );
}

/**
 * Result type that may have planContent (for backwards compatibility with old chat history)
 */
interface ProposePlanResultWithContent extends ProposePlanToolResult {
  planContent?: string;
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
 * Check if the result is from the legacy propose_plan tool (title + plan params)
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
  const [isImplementing, setIsImplementing] = useState(false);
  const isImplementingRef = useRef(false);
  const { api } = useAPI();
  const openInEditor = useOpenInEditor();
  const workspaceContext = useOptionalWorkspaceContext();
  const editorError = usePopoverError();
  const editButtonRef = useRef<HTMLDivElement>(null);

  // Get runtimeConfig and name for the workspace (needed for SSH-aware editor opening and share filename)
  const workspaceMetadata = workspaceId
    ? workspaceContext?.workspaceMetadata.get(workspaceId)
    : undefined;
  const runtimeConfig = workspaceMetadata?.runtimeConfig;
  const workspaceName = workspaceMetadata?.name;

  // Fresh content from disk for the latest plan (external edit detection)
  // Only use cache for completed tools (page reload case) - not for in-flight tools
  // which may have stale cache from a previous propose_plan call
  const cacheKey = workspaceId ? getPlanContentKey(workspaceId) : "";
  const shouldUseCache = workspaceId && isLatest && !isEphemeralPreview && status === "completed";
  const cached = shouldUseCache
    ? readPersistedState<{ content: string; path: string } | null>(cacheKey, null)
    : null;

  const [freshContent, setFreshContent] = useState<string | null>(cached?.content ?? null);
  const [freshPath, setFreshPath] = useState<string | null>(cached?.path ?? null);

  // Fetch fresh plan content for the latest plan
  // Re-fetches on mount, when window regains focus, and when tool completes
  useEffect(() => {
    if (isEphemeralPreview || !isLatest || !workspaceId || !api) return;

    const fetchPlan = async () => {
      try {
        const res = await api.workspace.getPlanContent({ workspaceId });
        if (res.success) {
          setFreshContent(res.data.content);
          setFreshPath(res.data.path);
          // Update cache for page reload (only useful when tool is completed)
          updatePersistedState(cacheKey, { content: res.data.content, path: res.data.path });
        }
      } catch {
        // Fetch failed, keep existing content
      }
    };

    // Fetch immediately on mount
    void fetchPlan();

    // Re-fetch when window regains focus (user returns from external editor)
    const handleFocus = () => void fetchPlan();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
    // status in deps ensures refetch when tool completes (captures final file state)
  }, [api, workspaceId, isLatest, isEphemeralPreview, cacheKey, status]);

  // Determine plan content and title based on result type
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
  } else if (isProposePlanResult(result)) {
    // New format: planContent may be absent (context optimization)
    // For backwards compatibility, check if planContent exists in old chat history
    const resultWithContent = result as ProposePlanResultWithContent;
    planPath = result.planPath;
    if (resultWithContent.planContent) {
      // Old result with embedded content (backwards compatibility)
      planContent = resultWithContent.planContent;
      const titleMatch = /^#\s+(.+)$/m.exec(resultWithContent.planContent);
      planTitle = titleMatch ? titleMatch[1] : (planPath.split("/").pop() ?? "Plan");
    } else {
      // New result without content - show path info, content is fetched for latest
      planContent = `*Plan saved to ${planPath}*`;
      planTitle = planPath.split("/").pop() ?? "Plan";
    }
  } else if (isLegacyProposePlanResult(result)) {
    // Legacy format: title + plan passed directly (no file)
    planContent = result.plan;
    planTitle = result.title;
  } else if (isProposePlanError(result)) {
    // Error from backend (e.g., plan file missing or empty)
    planContent = "";
    planTitle = "Plan Error";
    errorMessage = result.error;
  } else if (isLegacyProposePlanArgs(args)) {
    // Fallback to args for legacy format (streaming state before result)
    planContent = args.plan;
    planTitle = args.title;
  } else {
    // No valid plan data available (e.g., pending state)
    planContent = "";
    planTitle = "Plan";
  }

  // Format: Title as H1 + plan content for "Start Here" functionality.
  // Note: we intentionally preserve the plan file on disk when starting here so it can be
  // referenced later (e.g., via post-compaction attachments).
  const planPathNote = planPath ? `\n\n---\n\n*Plan file preserved at:* \`${planPath}\`` : "";
  const startHereContent = `# ${planTitle}\n\n${planContent}${planPathNote}`;
  const {
    openModal,
    buttonLabel,
    disabled: startHereDisabled,
    modal,
  } = useStartHere(workspaceId, startHereContent, false, {
    // Preserve the source mode so exec mode can detect a plan→exec transition
    // even after replacing chat history.
    sourceMode: "plan",
  });

  const handleImplement = () => {
    if (!workspaceId || !api) return;
    if (isImplementingRef.current) return;

    isImplementingRef.current = true;
    setIsImplementing(true);

    // Switch to exec before sending so send options (agentId/mode) match.
    updatePersistedState(getAgentIdKey(workspaceId), "exec");

    api.workspace
      .sendMessage({
        workspaceId,
        message: "Implement the plan",
        options: buildSendMessageOptions(workspaceId),
      })
      .catch(() => {
        // Best-effort: user can retry manually if sending fails.
      })
      .finally(() => {
        isImplementingRef.current = false;
        setIsImplementing(false);
      });
  };
  // Copy to clipboard with feedback
  const { copied, copyToClipboard } = useCopyToClipboard();

  const handleOpenInEditor = async () => {
    if (!planPath || !workspaceId) return;

    // Capture positioning from the ref for error popover placement
    const anchorPosition = editButtonRef.current
      ? (() => {
          const { bottom, left } = editButtonRef.current.getBoundingClientRect();
          return { top: bottom + 8, left };
        })()
      : { top: 100, left: 100 };

    try {
      const result = await openInEditor(workspaceId, planPath, runtimeConfig, { isFile: true });
      if (!result.success && result.error) {
        editorError.showError("plan-editor", result.error, anchorPosition);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      editorError.showError("plan-editor", message, anchorPosition);
    }
  };

  const statusDisplay = getStatusDisplay(status);

  // Build action buttons array (similar to AssistantMessage)
  const copyButton: ButtonConfig = {
    label: copied ? "Copied" : "Copy",
    onClick: () => void copyToClipboard(planContent),
    icon: copied ? <ClipboardCheck /> : <Clipboard />,
  };

  const actionButtons: ButtonConfig[] = [
    copyButton,
    {
      label: "Share",
      component: (
        <ShareMessagePopover
          content={planContent}
          disabled={!planContent}
          workspaceName={workspaceName}
        />
      ),
    },
  ];

  // Edit button config (rendered separately with ref for error positioning)
  const showEditButton = (isEphemeralPreview ?? isLatest) && planPath && workspaceId;
  const editButton: ButtonConfig | null = showEditButton
    ? {
        label: "Edit",
        onClick: () => void handleOpenInEditor(),
        icon: <Pencil />,
        tooltip: "Open plan in external editor",
      }
    : null;

  // Start Here button: only for tool calls, not ephemeral previews
  if (!isEphemeralPreview && workspaceId) {
    actionButtons.push({
      label: buttonLabel,
      onClick: openModal,
      disabled: startHereDisabled,
      icon: <ListStart />,
      tooltip: "Replace all chat history with this plan",
    });

    if (status === "completed" && !errorMessage && isLatest) {
      actionButtons.push({
        label: "Implement",
        onClick: handleImplement,
        disabled: !api || isImplementing,
        icon: <Play />,
        tooltip: "Switch to Exec and start implementing",
      });
    }
  }

  // Show raw toggle
  actionButtons.push({
    label: showRaw ? "Show Markdown" : "Show Text",
    onClick: () => setShowRaw(!showRaw),
    active: showRaw,
    icon: <FileText />,
  });

  // Close button: only for ephemeral previews
  if (isEphemeralPreview && onClose) {
    actionButtons.push({
      label: "Close",
      onClick: onClose,
      icon: <X />,
      tooltip: "Close preview",
    });
  }

  // Shared plan UI content (used in both tool call and ephemeral preview modes)
  const planUI = (
    <div className="plan-surface rounded-md p-3 shadow-md">
      {/* Header: title only */}
      <div className="plan-divider mb-3 flex items-center gap-2 border-b pb-2">
        <ClipboardList aria-hidden="true" className="h-4 w-4" />
        <div className="text-plan-mode font-mono text-[13px] font-semibold">{planTitle}</div>
        {isEphemeralPreview && (
          <div className="text-muted font-mono text-[10px] italic">preview only</div>
        )}
      </div>

      {/* Content */}
      {errorMessage ? (
        <div className="text-error rounded-sm p-2 font-mono text-xs">{errorMessage}</div>
      ) : showRaw ? (
        <div className="relative">
          <pre className="text-text bg-code-bg m-0 rounded-sm p-2 pb-8 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
            {planContent}
          </pre>
          <div className="absolute right-2 bottom-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px] [&_svg]:size-3.5"
              onClick={() => void copyToClipboard(planContent)}
            >
              {copied ? <ClipboardCheck /> : <Clipboard />}
              {copied ? "Copied" : "Copy to clipboard"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="plan-content">
          <MarkdownRenderer content={planContent} />
        </div>
      )}

      {/* Completion guidance: only for completed tool calls without errors, not ephemeral previews */}
      {!isEphemeralPreview && status === "completed" && !errorMessage && (
        <div className="plan-divider text-muted mt-3 border-t pt-3 text-[11px] leading-normal italic">
          Respond with revisions or switch to the Exec agent (
          <span className="font-primary not-italic">{formatKeybind(KEYBINDS.CYCLE_AGENT)}</span> to
          cycle) and ask to implement.
        </div>
      )}

      {/* Actions row at the bottom (matching MessageWindow style) */}
      <div className="mt-3 flex items-center gap-0.5">
        {actionButtons.map((button, index) => (
          <IconActionButton key={index} button={button} />
        ))}
        {/* Edit button rendered with ref for error popover positioning */}
        {editButton && (
          <div ref={editButtonRef}>
            <IconActionButton button={editButton} />
          </div>
        )}
      </div>
    </div>
  );

  // Ephemeral preview mode: simple wrapper without tool container
  if (isEphemeralPreview) {
    return (
      <>
        <div className={cn("px-4 py-2", className)}>{planUI}</div>
        <PopoverError error={editorError.error} prefix="Failed to open editor" />
      </>
    );
  }

  // Tool call mode: full tool container with header
  return (
    <>
      <ToolContainer expanded={expanded}>
        <ToolHeader onClick={toggleExpanded}>
          <ExpandIcon expanded={expanded}>▶</ExpandIcon>
          <ToolName>propose_plan</ToolName>
          <StatusIndicator status={status}>{statusDisplay}</StatusIndicator>
        </ToolHeader>

        {expanded && <ToolDetails>{planUI}</ToolDetails>}

        {modal}
      </ToolContainer>
      <PopoverError error={editorError.error} prefix="Failed to open editor" />
    </>
  );
};

import React, { useState, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { cn } from "@/common/lib/utils";
import { MessageRenderer } from "./Messages/MessageRenderer";
import { InterruptedBarrier } from "./Messages/ChatBarrier/InterruptedBarrier";
import { StreamingBarrier } from "./Messages/ChatBarrier/StreamingBarrier";
import { RetryBarrier } from "./Messages/ChatBarrier/RetryBarrier";
import { PinnedTodoList } from "./PinnedTodoList";
import { getAutoRetryKey, VIM_ENABLED_KEY } from "@/common/constants/storage";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { ChatInput, type ChatInputAPI } from "./ChatInput/index";
import { RightSidebar, type TabType } from "./RightSidebar";
import { useResizableSidebar } from "@/browser/hooks/useResizableSidebar";
import {
  shouldShowInterruptedBarrier,
  mergeConsecutiveStreamErrors,
} from "@/browser/utils/messages/messageUtils";
import { hasInterruptedStream } from "@/browser/utils/messages/retryEligibility";
import { ThinkingProvider } from "@/browser/contexts/ThinkingContext";
import { ModeProvider } from "@/browser/contexts/ModeContext";
import { ProviderOptionsProvider } from "@/browser/contexts/ProviderOptionsContext";

import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { useAutoScroll } from "@/browser/hooks/useAutoScroll";
import { useOpenTerminal } from "@/browser/hooks/useOpenTerminal";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useThinking } from "@/browser/contexts/ThinkingContext";
import {
  useWorkspaceState,
  useWorkspaceAggregator,
  useWorkspaceUsage,
} from "@/browser/stores/WorkspaceStore";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { getModelName } from "@/common/utils/ai/models";
import type { DisplayedMessage } from "@/common/types/message";
import type { RuntimeConfig } from "@/common/types/runtime";
import { useAIViewKeybinds } from "@/browser/hooks/useAIViewKeybinds";
import { evictModelFromLRU } from "@/browser/hooks/useModelLRU";
import { QueuedMessage } from "./Messages/QueuedMessage";
import { CompactionWarning } from "./CompactionWarning";
import { ConcurrentLocalWarning } from "./ConcurrentLocalWarning";
import { checkAutoCompaction } from "@/browser/utils/compaction/autoCompactionCheck";
import { executeCompaction } from "@/browser/utils/chatCommands";
import { useProviderOptions } from "@/browser/hooks/useProviderOptions";
import { useAutoCompactionSettings } from "../hooks/useAutoCompactionSettings";
import { useSendMessageOptions } from "@/browser/hooks/useSendMessageOptions";
import { useAPI } from "@/browser/contexts/API";

interface AIViewProps {
  workspaceId: string;
  projectPath: string;
  projectName: string;
  branch: string;
  namedWorkspacePath: string; // User-friendly path for display and terminal
  runtimeConfig?: RuntimeConfig;
  className?: string;
  /** If set, workspace is incompatible (from newer mux version) and this error should be displayed */
  incompatibleRuntime?: string;
  /** If 'creating', workspace is still being set up (git operations in progress) */
  status?: "creating";
}

const AIViewInner: React.FC<AIViewProps> = ({
  workspaceId,
  projectPath,
  projectName,
  branch,
  namedWorkspacePath,
  runtimeConfig,
  className,
  status,
}) => {
  const { api } = useAPI();
  const chatAreaRef = useRef<HTMLDivElement>(null);

  // Track active tab to conditionally enable resize functionality
  // RightSidebar notifies us of tab changes via onTabChange callback
  const [activeTab, setActiveTab] = useState<TabType>("costs");

  const isReviewTabActive = activeTab === "review";

  // Resizable sidebar for Review tab only
  // Hook encapsulates all drag logic, persistence, and constraints
  // Returns width to apply to RightSidebar and startResize for handle's onMouseDown
  const {
    width: sidebarWidth,
    isResizing,
    startResize,
  } = useResizableSidebar({
    enabled: isReviewTabActive, // Only active on Review tab
    defaultWidth: 600, // Initial width or fallback
    minWidth: 300, // Can't shrink smaller
    maxWidth: 1200, // Can't grow larger
    storageKey: "review-sidebar-width", // Persists across sessions
  });

  const workspaceState = useWorkspaceState(workspaceId);
  const aggregator = useWorkspaceAggregator(workspaceId);
  const workspaceUsage = useWorkspaceUsage(workspaceId);
  const { options } = useProviderOptions();
  const use1M = options.anthropic?.use1MContext ?? false;
  // Get pending model for auto-compaction settings (threshold is per-model)
  const pendingSendOptions = useSendMessageOptions(workspaceId);
  const pendingModel = pendingSendOptions.model;

  const { threshold: autoCompactionThreshold } = useAutoCompactionSettings(
    workspaceId,
    pendingModel
  );
  const handledModelErrorsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    handledModelErrorsRef.current.clear();
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceState) {
      return;
    }

    for (const message of workspaceState.messages) {
      if (message.type !== "stream-error") {
        continue;
      }
      if (message.errorType !== "model_not_found") {
        continue;
      }
      if (handledModelErrorsRef.current.has(message.id)) {
        continue;
      }
      handledModelErrorsRef.current.add(message.id);
      if (message.model) {
        evictModelFromLRU(message.model);
      }
    }
  }, [workspaceState, workspaceId]);

  const [editingMessage, setEditingMessage] = useState<{ id: string; content: string } | undefined>(
    undefined
  );

  // Track if we've already triggered force compaction for this stream
  const forceCompactionTriggeredRef = useRef<string | null>(null);

  // Extract state from workspace state
  const { messages, canInterrupt, isCompacting, loading, currentModel } = workspaceState;

  // Get active stream message ID for token counting
  const activeStreamMessageId = aggregator?.getActiveStreamMessageId();

  const autoCompactionResult = checkAutoCompaction(
    workspaceUsage,
    pendingModel,
    use1M,
    autoCompactionThreshold / 100
  );

  // Show warning when: shouldShowWarning flag is true AND not currently compacting
  const shouldShowCompactionWarning = !isCompacting && autoCompactionResult.shouldShowWarning;

  // Force compaction when live usage shows we're about to hit context limit
  useEffect(() => {
    if (
      !autoCompactionResult.shouldForceCompact ||
      !canInterrupt ||
      isCompacting ||
      forceCompactionTriggeredRef.current === activeStreamMessageId
    ) {
      return;
    }

    forceCompactionTriggeredRef.current = activeStreamMessageId ?? null;
    if (!api) return;
    void executeCompaction({
      api,
      workspaceId,
      sendMessageOptions: pendingSendOptions,
      continueMessage: { text: "Continue with the current task" },
    });
  }, [
    autoCompactionResult.shouldForceCompact,
    canInterrupt,
    isCompacting,
    activeStreamMessageId,
    workspaceId,
    pendingSendOptions,
    api,
  ]);

  // Reset force compaction trigger when stream ends
  useEffect(() => {
    if (!canInterrupt) {
      forceCompactionTriggeredRef.current = null;
    }
  }, [canInterrupt]);

  // Auto-retry state - minimal setter for keybinds and message sent handler
  // RetryBarrier manages its own state, but we need this for interrupt keybind
  const [, setAutoRetry] = usePersistedState<boolean>(
    getAutoRetryKey(workspaceId),
    WORKSPACE_DEFAULTS.autoRetry,
    {
      listener: true,
    }
  );

  // Vim mode state - needed for keybind selection (Ctrl+C in vim, Esc otherwise)
  const [vimEnabled] = usePersistedState<boolean>(VIM_ENABLED_KEY, false, { listener: true });

  // Use auto-scroll hook for scroll management
  const {
    contentRef,
    innerRef,
    autoScroll,
    setAutoScroll,
    performAutoScroll,
    jumpToBottom,
    handleScroll,
    markUserInteraction,
  } = useAutoScroll();

  // ChatInput API for focus management
  const chatInputAPI = useRef<ChatInputAPI | null>(null);
  const handleChatInputReady = useCallback((api: ChatInputAPI) => {
    chatInputAPI.current = api;
  }, []);

  // Handler for review notes from Code Review tab
  const handleReviewNote = useCallback((note: string) => {
    chatInputAPI.current?.appendText(note);
  }, []);

  // Handler for manual compaction from CompactionWarning click
  const handleCompactClick = useCallback(() => {
    chatInputAPI.current?.prependText("/compact\n");
  }, []);

  // Thinking level state from context
  const { thinkingLevel: currentWorkspaceThinking, setThinkingLevel } = useThinking();

  // Handlers for editing messages
  const handleEditUserMessage = useCallback((messageId: string, content: string) => {
    setEditingMessage({ id: messageId, content });
  }, []);

  const handleEditQueuedMessage = useCallback(async () => {
    const queuedMessage = workspaceState?.queuedMessage;
    if (!queuedMessage) return;

    await api?.workspace.clearQueue({ workspaceId });
    chatInputAPI.current?.restoreText(queuedMessage.content);

    // Restore images if present
    if (queuedMessage.imageParts && queuedMessage.imageParts.length > 0) {
      chatInputAPI.current?.restoreImages(queuedMessage.imageParts);
    }
  }, [api, workspaceId, workspaceState?.queuedMessage, chatInputAPI]);

  // Handler for sending queued message immediately (interrupt + send)
  const handleSendQueuedImmediately = useCallback(async () => {
    if (!workspaceState?.queuedMessage || !workspaceState.canInterrupt) return;
    await api?.workspace.interruptStream({
      workspaceId,
      options: { sendQueuedImmediately: true },
    });
  }, [api, workspaceId, workspaceState?.queuedMessage, workspaceState?.canInterrupt]);

  const handleEditLastUserMessage = useCallback(async () => {
    if (!workspaceState) return;

    if (workspaceState.queuedMessage) {
      await handleEditQueuedMessage();
      return;
    }

    // Otherwise, edit last user message
    const mergedMessages = mergeConsecutiveStreamErrors(workspaceState.messages);
    const lastUserMessage = [...mergedMessages]
      .reverse()
      .find((msg): msg is Extract<DisplayedMessage, { type: "user" }> => msg.type === "user");
    if (lastUserMessage) {
      setEditingMessage({ id: lastUserMessage.historyId, content: lastUserMessage.content });
      setAutoScroll(false); // Show jump-to-bottom indicator

      // Scroll to the message being edited
      requestAnimationFrame(() => {
        const element = contentRef.current?.querySelector(
          `[data-message-id="${lastUserMessage.historyId}"]`
        );
        element?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
  }, [workspaceState, contentRef, setAutoScroll, handleEditQueuedMessage]);

  const handleCancelEdit = useCallback(() => {
    setEditingMessage(undefined);
  }, []);

  const handleMessageSent = useCallback(() => {
    // Enable auto-scroll when user sends a message
    setAutoScroll(true);

    // Reset autoRetry when user sends a message
    // User action = clear intent: "I'm actively using this workspace"
    setAutoRetry(true);
  }, [setAutoScroll, setAutoRetry]);

  const handleClearHistory = useCallback(
    async (percentage = 1.0) => {
      // Enable auto-scroll after clearing
      setAutoScroll(true);

      // Truncate history in backend
      await api?.workspace.truncateHistory({ workspaceId, percentage });
    },
    [workspaceId, setAutoScroll, api]
  );

  const handleProviderConfig = useCallback(
    async (provider: string, keyPath: string[], value: string) => {
      if (!api) throw new Error("API not connected");
      const result = await api.providers.setProviderConfig({ provider, keyPath, value });
      if (!result.success) {
        throw new Error(result.error);
      }
    },
    [api]
  );

  const openTerminal = useOpenTerminal();
  const handleOpenTerminal = useCallback(() => {
    openTerminal(workspaceId);
  }, [workspaceId, openTerminal]);

  // Auto-scroll when messages or todos update (during streaming)
  useEffect(() => {
    if (workspaceState && autoScroll) {
      performAutoScroll();
    }
  }, [
    workspaceState?.messages,
    workspaceState?.todos,
    autoScroll,
    performAutoScroll,
    workspaceState,
  ]);

  // Scroll to bottom when workspace loads or changes
  // useLayoutEffect ensures scroll happens synchronously after DOM mutations
  // but before browser paint - critical for Chromatic snapshot consistency
  useLayoutEffect(() => {
    if (workspaceState && !workspaceState.loading && workspaceState.messages.length > 0) {
      jumpToBottom();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, workspaceState?.loading]);

  // Compute showRetryBarrier once for both keybinds and UI
  // Track if last message was interrupted or errored (for RetryBarrier)
  // Uses same logic as useResumeManager for DRY
  const showRetryBarrier = workspaceState
    ? !workspaceState.canInterrupt &&
      hasInterruptedStream(workspaceState.messages, workspaceState.pendingStreamStartTime)
    : false;

  // Handle keyboard shortcuts (using optional refs that are safe even if not initialized)
  useAIViewKeybinds({
    workspaceId,
    currentModel: workspaceState?.currentModel ?? null,
    canInterrupt: workspaceState?.canInterrupt ?? false,
    showRetryBarrier,
    currentWorkspaceThinking,
    setThinkingLevel,
    setAutoRetry,
    chatInputAPI,
    jumpToBottom,
    handleOpenTerminal,
    aggregator,
    setEditingMessage,
    vimEnabled,
  });

  // Clear editing state if the message being edited no longer exists
  // Must be before early return to satisfy React Hooks rules
  useEffect(() => {
    if (!workspaceState || !editingMessage) return;

    const mergedMessages = mergeConsecutiveStreamErrors(workspaceState.messages);
    const editCutoffHistoryId = mergedMessages.find(
      (msg): msg is Exclude<DisplayedMessage, { type: "history-hidden" | "workspace-init" }> =>
        msg.type !== "history-hidden" &&
        msg.type !== "workspace-init" &&
        msg.historyId === editingMessage.id
    )?.historyId;

    if (!editCutoffHistoryId) {
      // Message was replaced or deleted - clear editing state
      setEditingMessage(undefined);
    }
  }, [workspaceState, editingMessage]);

  // Return early if workspace state not loaded yet
  if (!workspaceState) {
    return (
      <div
        className={cn(
          "flex flex-1 flex-row bg-dark text-light overflow-x-auto overflow-y-hidden [@media(max-width:768px)]:flex-col",
          className
        )}
        style={{ containerType: "inline-size" }}
      >
        <div className="text-placeholder flex h-full flex-1 flex-col items-center justify-center text-center">
          <h3 className="m-0 mb-2.5 text-base font-medium">Loading workspace...</h3>
        </div>
      </div>
    );
  }

  // Note: We intentionally do NOT reset autoRetry when streams start.
  // If user pressed the interrupt key, autoRetry stays false until they manually retry.
  // This makes state transitions explicit and predictable.

  // Merge consecutive identical stream errors
  const mergedMessages = mergeConsecutiveStreamErrors(messages);

  // When editing, find the cutoff point
  const editCutoffHistoryId = editingMessage
    ? mergedMessages.find(
        (msg): msg is Exclude<DisplayedMessage, { type: "history-hidden" | "workspace-init" }> =>
          msg.type !== "history-hidden" &&
          msg.type !== "workspace-init" &&
          msg.historyId === editingMessage.id
      )?.historyId
    : undefined;

  if (loading) {
    return (
      <div
        className={cn(
          "flex flex-1 flex-row bg-dark text-light overflow-x-auto overflow-y-hidden [@media(max-width:768px)]:flex-col",
          className
        )}
        style={{ containerType: "inline-size" }}
      >
        <div className="text-placeholder flex h-full flex-1 flex-col items-center justify-center text-center">
          <h3 className="m-0 mb-2.5 text-base font-medium">Loading workspace...</h3>
        </div>
      </div>
    );
  }

  if (!projectName || !branch) {
    return (
      <div
        className={cn(
          "flex flex-1 flex-row bg-dark text-light overflow-x-auto overflow-y-hidden [@media(max-width:768px)]:flex-col",
          className
        )}
        style={{ containerType: "inline-size" }}
      >
        <div className="text-placeholder flex h-full flex-1 flex-col items-center justify-center text-center">
          <h3 className="m-0 mb-2.5 text-base font-medium">No Workspace Selected</h3>
          <p className="m-0 text-[13px]">
            Select a workspace from the sidebar to view and interact with Claude
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-1 flex-row bg-dark text-light overflow-x-auto overflow-y-hidden [@media(max-width:768px)]:flex-col",
        className
      )}
      style={{ containerType: "inline-size" }}
    >
      <div
        ref={chatAreaRef}
        className="flex min-w-96 flex-1 flex-col [@media(max-width:768px)]:max-h-full [@media(max-width:768px)]:w-full [@media(max-width:768px)]:min-w-0"
      >
        <WorkspaceHeader
          workspaceId={workspaceId}
          projectName={projectName}
          branch={branch}
          namedWorkspacePath={namedWorkspacePath}
          runtimeConfig={runtimeConfig}
        />

        <div className="relative flex-1 overflow-hidden">
          <div
            ref={contentRef}
            onWheel={markUserInteraction}
            onTouchMove={markUserInteraction}
            onScroll={handleScroll}
            role="log"
            aria-live={canInterrupt ? "polite" : "off"}
            aria-busy={canInterrupt}
            aria-label="Conversation transcript"
            tabIndex={0}
            data-testid="message-window"
            className="h-full overflow-y-auto p-[15px] leading-[1.5] break-words whitespace-pre-wrap"
          >
            <div
              ref={innerRef}
              className={cn("max-w-4xl mx-auto", mergedMessages.length === 0 && "h-full")}
            >
              {mergedMessages.length === 0 ? (
                <div className="text-placeholder flex h-full flex-1 flex-col items-center justify-center text-center [&_h3]:m-0 [&_h3]:mb-2.5 [&_h3]:text-base [&_h3]:font-medium [&_p]:m-0 [&_p]:text-[13px]">
                  <h3>No Messages Yet</h3>
                  <p>Send a message below to begin</p>
                  <p className="mt-5 text-xs text-[#888]">
                    💡 Tip: Add a{" "}
                    <code className="rounded-[3px] bg-[#2d2d30] px-1.5 py-0.5 font-mono text-[11px] text-[#d7ba7d]">
                      .mux/init
                    </code>{" "}
                    hook to your project to run setup commands
                    <br />
                    (e.g., install dependencies, build) when creating new workspaces
                  </p>
                </div>
              ) : (
                <>
                  {mergedMessages.map((msg) => {
                    const isAtCutoff =
                      editCutoffHistoryId !== undefined &&
                      msg.type !== "history-hidden" &&
                      msg.type !== "workspace-init" &&
                      msg.historyId === editCutoffHistoryId;

                    return (
                      <React.Fragment key={msg.id}>
                        <div
                          data-testid="chat-message"
                          data-message-id={
                            msg.type !== "history-hidden" && msg.type !== "workspace-init"
                              ? msg.historyId
                              : undefined
                          }
                        >
                          <MessageRenderer
                            message={msg}
                            onEditUserMessage={handleEditUserMessage}
                            workspaceId={workspaceId}
                            isCompacting={isCompacting}
                          />
                        </div>
                        {isAtCutoff && (
                          <div className="edit-cutoff-divider text-edit-mode bg-edit-mode/10 my-5 px-[15px] py-3 text-center text-xs font-medium">
                            ⚠️ Messages below this line will be removed when you submit the edit
                          </div>
                        )}
                        {shouldShowInterruptedBarrier(msg) && <InterruptedBarrier />}
                      </React.Fragment>
                    );
                  })}
                  {/* Show RetryBarrier after the last message if needed */}
                  {showRetryBarrier && <RetryBarrier workspaceId={workspaceId} />}
                </>
              )}
              <PinnedTodoList workspaceId={workspaceId} />
              {canInterrupt && (
                <StreamingBarrier
                  statusText={
                    isCompacting
                      ? currentModel
                        ? `${getModelName(currentModel)} compacting...`
                        : "compacting..."
                      : currentModel
                        ? `${getModelName(currentModel)} streaming...`
                        : "streaming..."
                  }
                  cancelText={`hit ${formatKeybind(vimEnabled ? KEYBINDS.INTERRUPT_STREAM_VIM : KEYBINDS.INTERRUPT_STREAM_NORMAL)} to cancel`}
                  tokenCount={
                    activeStreamMessageId
                      ? aggregator?.getStreamingTokenCount(activeStreamMessageId)
                      : undefined
                  }
                  tps={
                    activeStreamMessageId
                      ? aggregator?.getStreamingTPS(activeStreamMessageId)
                      : undefined
                  }
                />
              )}
              {workspaceState?.queuedMessage && (
                <QueuedMessage
                  message={workspaceState.queuedMessage}
                  onEdit={() => void handleEditQueuedMessage()}
                  onSendImmediately={
                    workspaceState.canInterrupt ? handleSendQueuedImmediately : undefined
                  }
                />
              )}
              <ConcurrentLocalWarning
                workspaceId={workspaceId}
                projectPath={projectPath}
                runtimeConfig={runtimeConfig}
              />
            </div>
          </div>
          {!autoScroll && (
            <button
              onClick={jumpToBottom}
              type="button"
              className="assistant-chip font-primary text-foreground hover:assistant-chip-hover absolute bottom-2 left-1/2 z-[100] -translate-x-1/2 cursor-pointer rounded-[20px] px-2 py-1 text-xs font-medium shadow-[0_4px_12px_rgba(0,0,0,0.3)] backdrop-blur-[1px] transition-all duration-200 hover:scale-105 active:scale-95"
            >
              Press {formatKeybind(KEYBINDS.JUMP_TO_BOTTOM)} to jump to bottom
            </button>
          )}
        </div>
        {shouldShowCompactionWarning && (
          <CompactionWarning
            usagePercentage={autoCompactionResult.usagePercentage}
            thresholdPercentage={autoCompactionResult.thresholdPercentage}
            isStreaming={canInterrupt}
            onCompactClick={handleCompactClick}
          />
        )}
        <ChatInput
          variant="workspace"
          workspaceId={workspaceId}
          onMessageSent={handleMessageSent}
          onTruncateHistory={handleClearHistory}
          onProviderConfig={handleProviderConfig}
          disabled={!projectName || !branch}
          isCompacting={isCompacting}
          editingMessage={editingMessage}
          onCancelEdit={handleCancelEdit}
          onEditLastUserMessage={() => void handleEditLastUserMessage()}
          canInterrupt={canInterrupt}
          onReady={handleChatInputReady}
          autoCompactionCheck={autoCompactionResult}
        />
      </div>

      <RightSidebar
        key={workspaceId}
        workspaceId={workspaceId}
        workspacePath={namedWorkspacePath}
        chatAreaRef={chatAreaRef}
        onTabChange={setActiveTab} // Notifies us when tab changes
        width={isReviewTabActive ? sidebarWidth : undefined} // Custom width only on Review tab
        onStartResize={isReviewTabActive ? startResize : undefined} // Pass resize handler when Review active
        isResizing={isResizing} // Pass resizing state
        onReviewNote={handleReviewNote} // Pass review note handler to append to chat
        isCreating={status === "creating"} // Workspace still being set up
      />
    </div>
  );
};

/**
 * Incompatible workspace error display.
 * Shown when a workspace was created with a newer version of mux.
 */
const IncompatibleWorkspaceView: React.FC<{ message: string; className?: string }> = ({
  message,
  className,
}) => (
  <div className={cn("flex h-full w-full flex-col items-center justify-center p-8", className)}>
    <div className="max-w-md text-center">
      <div className="mb-4 text-4xl">⚠️</div>
      <h2 className="mb-2 text-xl font-semibold text-[var(--color-text-primary)]">
        Incompatible Workspace
      </h2>
      <p className="mb-4 text-[var(--color-text-secondary)]">{message}</p>
      <p className="text-sm text-[var(--color-text-tertiary)]">
        You can delete this workspace and create a new one, or upgrade mux to use it.
      </p>
    </div>
  </div>
);

// Wrapper component that provides the mode and thinking contexts
export const AIView: React.FC<AIViewProps> = (props) => {
  // Early return for incompatible workspaces - no hooks called in this path
  if (props.incompatibleRuntime) {
    return (
      <IncompatibleWorkspaceView message={props.incompatibleRuntime} className={props.className} />
    );
  }

  return (
    <ModeProvider workspaceId={props.workspaceId}>
      <ProviderOptionsProvider>
        <ThinkingProvider workspaceId={props.workspaceId}>
          <AIViewInner {...props} />
        </ThinkingProvider>
      </ProviderOptionsProvider>
    </ModeProvider>
  );
};

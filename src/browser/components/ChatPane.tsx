import React, {
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useDeferredValue,
  useMemo,
} from "react";
import { Lightbulb } from "lucide-react";
import { MessageListProvider } from "./Messages/MessageListContext";
import { cn } from "@/common/lib/utils";
import { MessageRenderer } from "./Messages/MessageRenderer";
import { InterruptedBarrier } from "./Messages/ChatBarrier/InterruptedBarrier";
import { EditCutoffBarrier } from "./Messages/ChatBarrier/EditCutoffBarrier";
import { StreamingBarrier } from "./Messages/ChatBarrier/StreamingBarrier";
import { RetryBarrier } from "./Messages/ChatBarrier/RetryBarrier";
import { PinnedTodoList } from "./PinnedTodoList";
import { getAutoRetryKey, VIM_ENABLED_KEY } from "@/common/constants/storage";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { ChatInput, type ChatInputAPI } from "./ChatInput/index";
import {
  shouldShowInterruptedBarrier,
  mergeConsecutiveStreamErrors,
  computeBashOutputGroupInfo,
  getEditableUserMessageText,
} from "@/browser/utils/messages/messageUtils";
import { BashOutputCollapsedIndicator } from "./tools/BashOutputCollapsedIndicator";
import { getInterruptionContext } from "@/browser/utils/messages/retryEligibility";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { useAutoScroll } from "@/browser/hooks/useAutoScroll";
import { useOpenInEditor } from "@/browser/hooks/useOpenInEditor";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import {
  useWorkspaceAggregator,
  useWorkspaceUsage,
  useWorkspaceStoreRaw,
  type WorkspaceState,
} from "@/browser/stores/WorkspaceStore";
import { WorkspaceHeader } from "./WorkspaceHeader";
import type { ImagePart } from "@/common/orpc/types";
import type { DisplayedMessage } from "@/common/types/message";
import type { RuntimeConfig } from "@/common/types/runtime";
import { getRuntimeTypeForTelemetry } from "@/common/telemetry";
import { useAIViewKeybinds } from "@/browser/hooks/useAIViewKeybinds";
import { QueuedMessage } from "./Messages/QueuedMessage";
import { CompactionWarning } from "./CompactionWarning";
import { ConcurrentLocalWarning } from "./ConcurrentLocalWarning";
import { BackgroundProcessesBanner } from "./BackgroundProcessesBanner";
import { checkAutoCompaction } from "@/browser/utils/compaction/autoCompactionCheck";
import { executeCompaction, buildContinueMessage } from "@/browser/utils/chatCommands";
import { useProviderOptions } from "@/browser/hooks/useProviderOptions";
import { useAutoCompactionSettings } from "../hooks/useAutoCompactionSettings";
import { useSendMessageOptions } from "@/browser/hooks/useSendMessageOptions";
import { useForceCompaction } from "@/browser/hooks/useForceCompaction";
import { useIdleCompactionHandler } from "@/browser/hooks/useIdleCompactionHandler";
import type { TerminalSessionCreateOptions } from "@/browser/utils/terminal";
import { useAPI } from "@/browser/contexts/API";
import { useReviews } from "@/browser/hooks/useReviews";
import { ReviewsBanner } from "./ReviewsBanner";
import type { ReviewNoteData } from "@/common/types/review";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import {
  useBackgroundBashActions,
  useBackgroundBashError,
} from "@/browser/contexts/BackgroundBashContext";

interface ChatPaneProps {
  workspaceId: string;
  workspaceState: WorkspaceState;
  projectPath: string;
  projectName: string;
  workspaceName: string;
  namedWorkspacePath: string;
  leftSidebarCollapsed: boolean;
  onToggleLeftSidebarCollapsed: () => void;
  runtimeConfig?: RuntimeConfig;
  status?: "creating";
  onOpenTerminal: (options?: TerminalSessionCreateOptions) => void;
}

type ReviewsState = ReturnType<typeof useReviews>;

type EditingMessageState = { id: string; content: string; imageParts?: ImagePart[] } | undefined;

export const ChatPane: React.FC<ChatPaneProps> = (props) => {
  const {
    workspaceId,
    projectPath,
    projectName,
    workspaceName,
    namedWorkspacePath,
    leftSidebarCollapsed,
    onToggleLeftSidebarCollapsed,
    runtimeConfig,
    onOpenTerminal,
    workspaceState,
  } = props;
  const { api } = useAPI();
  const { workspaceMetadata } = useWorkspaceContext();
  const chatAreaRef = useRef<HTMLDivElement>(null);

  const storeRaw = useWorkspaceStoreRaw();
  const aggregator = useWorkspaceAggregator(workspaceId);
  const workspaceUsage = useWorkspaceUsage(workspaceId);
  const reviews = useReviews(workspaceId);
  const { autoBackgroundOnSend } = useBackgroundBashActions();
  const { clearError: clearBackgroundBashError } = useBackgroundBashError();

  const meta = workspaceMetadata.get(workspaceId);
  const isQueuedAgentTask = Boolean(meta?.parentWorkspaceId) && meta?.taskStatus === "queued";
  const queuedAgentTaskPrompt =
    isQueuedAgentTask && typeof meta?.taskPrompt === "string" && meta.taskPrompt.trim().length > 0
      ? meta.taskPrompt
      : null;
  const shouldShowQueuedAgentTaskPrompt =
    Boolean(queuedAgentTaskPrompt) && (workspaceState?.messages.length ?? 0) === 0;

  const { options } = useProviderOptions();
  const use1M = options.anthropic?.use1MContext ?? false;
  // Get pending model for auto-compaction settings (threshold is per-model)
  const pendingSendOptions = useSendMessageOptions(workspaceId);
  const pendingModel = pendingSendOptions.model;

  const { threshold: autoCompactionThreshold } = useAutoCompactionSettings(
    workspaceId,
    pendingModel
  );

  const [editingState, setEditingState] = useState(() => ({
    workspaceId,
    message: undefined as EditingMessageState,
  }));
  const editingMessage =
    editingState.workspaceId === workspaceId ? editingState.message : undefined;
  const setEditingMessage = useCallback(
    (message: EditingMessageState) => {
      setEditingState({ workspaceId, message });
    },
    [workspaceId]
  );

  // Track which bash_output groups are expanded (keyed by first message ID)
  const [expandedBashGroups, setExpandedBashGroups] = useState<Set<string>>(new Set());

  // Extract state from workspace state

  // Keep a ref to the latest workspace state so event handlers (passed to memoized children)
  // can stay referentially stable during streaming while still reading fresh data.
  const workspaceStateRef = useRef(workspaceState);
  useEffect(() => {
    workspaceStateRef.current = workspaceState;
  }, [workspaceState]);
  const { messages, canInterrupt, isCompacting, loading } = workspaceState;

  // Apply message transformations:
  // 1. Merge consecutive identical stream errors
  // (bash_output grouping is done at render-time, not as a transformation)
  // Use useDeferredValue to allow React to defer the heavy message list rendering
  // during rapid updates (streaming), keeping the UI responsive.
  // Must be defined before any early returns to satisfy React Hooks rules.
  const transformedMessages = useMemo(() => mergeConsecutiveStreamErrors(messages), [messages]);
  const deferredTransformedMessages = useDeferredValue(transformedMessages);

  // CRITICAL: Show immediate messages when streaming or when message count changes.
  // useDeferredValue can defer indefinitely if React keeps getting new work (rapid deltas).
  // During active streaming (reasoning, text), we MUST show immediate updates or the UI
  // appears frozen while only the token counter updates (reads aggregator directly).
  // Only use deferred messages when the stream is idle and no content is changing.
  const hasActiveStream = transformedMessages.some((m) => "isStreaming" in m && m.isStreaming);
  const deferredMessages =
    hasActiveStream || transformedMessages.length !== deferredTransformedMessages.length
      ? transformedMessages
      : deferredTransformedMessages;

  const latestMessageId =
    deferredMessages.length > 0
      ? (deferredMessages[deferredMessages.length - 1]?.id ?? null)
      : null;
  const messageListContextValue = useMemo(
    () => ({
      workspaceId,
      latestMessageId,
      openTerminal: onOpenTerminal,
    }),
    [workspaceId, latestMessageId, onOpenTerminal]
  );

  const autoCompactionResult = useMemo(
    () => checkAutoCompaction(workspaceUsage, pendingModel, use1M, autoCompactionThreshold / 100),
    [workspaceUsage, pendingModel, use1M, autoCompactionThreshold]
  );

  // Show warning when: shouldShowWarning flag is true AND not currently compacting
  const shouldShowCompactionWarning = !isCompacting && autoCompactionResult.shouldShowWarning;

  // Handle force compaction callback - memoized to avoid effect re-runs.
  // We pass a default continueMessage of "Continue" as a resume sentinel so the backend can
  // auto-send it after compaction. The compaction prompt builder special-cases this sentinel
  // to avoid injecting it into the summarization request.
  const handleForceCompaction = useCallback(() => {
    if (!api) return;

    // Force compaction queues a message while a stream is active.
    // Match user-send semantics: background any running foreground bash so we don't block.
    autoBackgroundOnSend();

    void executeCompaction({
      api,
      workspaceId,
      sendMessageOptions: pendingSendOptions,
      continueMessage: buildContinueMessage({
        text: "Continue",
        model: pendingSendOptions.model,
        agentId: pendingSendOptions.agentId ?? "exec",
      }),
    });
  }, [api, workspaceId, pendingSendOptions, autoBackgroundOnSend]);

  // Force compaction when live usage shows we're about to hit context limit
  useForceCompaction({
    shouldForceCompact: autoCompactionResult.shouldForceCompact,
    canInterrupt,
    isCompacting,
    onTrigger: handleForceCompaction,
  });

  // Idle compaction - trigger compaction when backend signals workspace has been idle
  useIdleCompactionHandler({ api });

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
  const chatInputWorkspaceIdRef = useRef(workspaceId);
  const previousWorkspaceIdRef = useRef(workspaceId);

  // Reset per-workspace UI state now that AIView stays mounted across workspace switches.
  useEffect(() => {
    if (previousWorkspaceIdRef.current === workspaceId) {
      return;
    }

    previousWorkspaceIdRef.current = workspaceId;
    setEditingMessage(undefined);
    setExpandedBashGroups(new Set());
    if (chatInputWorkspaceIdRef.current !== workspaceId) {
      chatInputAPI.current = null;
    }
    setAutoScroll(true);
    clearBackgroundBashError();
  }, [workspaceId, setAutoScroll, clearBackgroundBashError, setEditingMessage]);
  const handleChatInputReady = useCallback(
    (api: ChatInputAPI) => {
      chatInputAPI.current = api;
      chatInputWorkspaceIdRef.current = workspaceId;
    },
    [workspaceId]
  );

  // Handler for review notes from Code Review tab - adds review (starts attached)
  // Depend only on addReview (not whole reviews object) to keep callback stable
  const { addReview, checkReview } = reviews;

  const handleCheckReviews = useCallback(
    (ids: string[]) => {
      for (const id of ids) {
        checkReview(id);
      }
    },
    [checkReview]
  );
  const handleReviewNote = useCallback(
    (data: ReviewNoteData) => {
      addReview(data);
      // New reviews start with status "attached" so they appear in chat input immediately
    },
    [addReview]
  );

  // Handler for manual compaction from CompactionWarning click
  const handleCompactClick = useCallback(() => {
    chatInputAPI.current?.prependText("/compact\n");
  }, []);

  // Handlers for editing messages
  const handleEditUserMessage = useCallback(
    (messageId: string, content: string, imageParts?: ImagePart[]) => {
      setEditingMessage({ id: messageId, content, imageParts });
    },
    [setEditingMessage]
  );

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
    // Set "interrupting" state immediately so UI shows "interrupting..." without flash
    storeRaw.setInterrupting(workspaceId);
    await api?.workspace.interruptStream({
      workspaceId,
      options: { sendQueuedImmediately: true },
    });
  }, [api, workspaceId, workspaceState?.queuedMessage, workspaceState?.canInterrupt, storeRaw]);

  const handleEditLastUserMessage = useCallback(async () => {
    const current = workspaceStateRef.current;
    if (!current) return;

    if (current.queuedMessage) {
      const queuedMessage = current.queuedMessage;

      await api?.workspace.clearQueue({ workspaceId });
      chatInputAPI.current?.restoreText(queuedMessage.content);

      // Restore images if present
      if (queuedMessage.imageParts && queuedMessage.imageParts.length > 0) {
        chatInputAPI.current?.restoreImages(queuedMessage.imageParts);
      }
      return;
    }

    // Otherwise, edit last user message
    const transformedMessages = mergeConsecutiveStreamErrors(current.messages);
    const lastUserMessage = [...transformedMessages]
      .reverse()
      .find((msg): msg is Extract<DisplayedMessage, { type: "user" }> => msg.type === "user");

    if (!lastUserMessage) {
      return;
    }

    setEditingMessage({
      id: lastUserMessage.historyId,
      content: getEditableUserMessageText(lastUserMessage),
      imageParts: lastUserMessage.imageParts,
    });
    setAutoScroll(false); // Show jump-to-bottom indicator

    // Scroll to the message being edited
    requestAnimationFrame(() => {
      const element = contentRef.current?.querySelector(
        `[data-message-id="${lastUserMessage.historyId}"]`
      );
      element?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [api, workspaceId, chatInputAPI, contentRef, setAutoScroll, setEditingMessage]);

  const handleEditLastUserMessageClick = useCallback(() => {
    void handleEditLastUserMessage();
  }, [handleEditLastUserMessage]);

  const handleCancelEdit = useCallback(() => {
    setEditingMessage(undefined);
  }, [setEditingMessage]);

  const handleMessageSent = useCallback(() => {
    // Auto-background any running foreground bash when user sends a new message
    // This prevents the user from waiting for the bash to complete before their message is processed
    autoBackgroundOnSend();

    // Enable auto-scroll when user sends a message
    setAutoScroll(true);

    // Reset autoRetry when user sends a message
    // User action = clear intent: "I'm actively using this workspace"
    setAutoRetry(true);
  }, [setAutoScroll, setAutoRetry, autoBackgroundOnSend]);

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

  const openInEditor = useOpenInEditor();
  const handleOpenInEditor = useCallback(() => {
    void openInEditor(workspaceId, namedWorkspacePath, runtimeConfig);
  }, [workspaceId, namedWorkspacePath, openInEditor, runtimeConfig]);

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
  const interruption = workspaceState
    ? getInterruptionContext(
        workspaceState.messages,
        workspaceState.pendingStreamStartTime,
        workspaceState.runtimeStatus,
        workspaceState.lastAbortReason
      )
    : null;

  const showRetryBarrier = workspaceState
    ? !workspaceState.canInterrupt && (interruption?.hasInterruptedStream ?? false)
    : false;

  const lastMessage = workspaceState.messages[workspaceState.messages.length - 1];
  const suppressRetryBarrier =
    lastMessage?.type === "stream-error" && lastMessage.errorType === "context_exceeded";
  const showRetryBarrierUI = showRetryBarrier && !suppressRetryBarrier;

  // Handle keyboard shortcuts (using optional refs that are safe even if not initialized)
  useAIViewKeybinds({
    workspaceId,
    // Allow interrupt keybind even while waiting for stream-start ("starting...").
    canInterrupt:
      (workspaceState?.canInterrupt ?? false) ||
      typeof workspaceState?.pendingStreamStartTime === "number",
    showRetryBarrier,
    setAutoRetry,
    chatInputAPI,
    jumpToBottom,
    handleOpenTerminal: onOpenTerminal,
    handleOpenInEditor,
    aggregator,
    setEditingMessage,
    vimEnabled,
  });

  // Clear editing state if the message being edited no longer exists
  // Must be before early return to satisfy React Hooks rules
  useEffect(() => {
    if (!workspaceState || !editingMessage) return;

    const transformedMessages = mergeConsecutiveStreamErrors(workspaceState.messages);
    const editCutoffHistoryId = transformedMessages.find(
      (msg): msg is Exclude<DisplayedMessage, { type: "history-hidden" | "workspace-init" }> =>
        msg.type !== "history-hidden" &&
        msg.type !== "workspace-init" &&
        msg.historyId === editingMessage.id
    )?.historyId;

    if (!editCutoffHistoryId) {
      // Message was replaced or deleted - clear editing state
      setEditingMessage(undefined);
    }
  }, [workspaceState, editingMessage, setEditingMessage]);

  // When editing, find the cutoff point
  const editCutoffHistoryId = editingMessage
    ? transformedMessages.find(
        (msg): msg is Exclude<DisplayedMessage, { type: "history-hidden" | "workspace-init" }> =>
          msg.type !== "history-hidden" &&
          msg.type !== "workspace-init" &&
          msg.historyId === editingMessage.id
      )?.historyId
    : undefined;

  // Find the ID of the latest propose_plan tool call for external edit detection
  // Only the latest plan should fetch fresh content from disk
  let latestProposePlanId: string | null = null;
  for (let i = transformedMessages.length - 1; i >= 0; i--) {
    const msg = transformedMessages[i];
    if (msg.type === "tool" && msg.toolName === "propose_plan") {
      latestProposePlanId = msg.id;
      break;
    }
  }

  return (
    <div
      ref={chatAreaRef}
      className="flex min-w-96 flex-1 flex-col [@media(max-width:768px)]:max-h-full [@media(max-width:768px)]:w-full [@media(max-width:768px)]:min-w-0"
    >
      <WorkspaceHeader
        workspaceId={workspaceId}
        projectName={projectName}
        projectPath={projectPath}
        workspaceName={workspaceName}
        leftSidebarCollapsed={leftSidebarCollapsed}
        onToggleLeftSidebarCollapsed={onToggleLeftSidebarCollapsed}
        namedWorkspacePath={namedWorkspacePath}
        runtimeConfig={runtimeConfig}
        onOpenTerminal={onOpenTerminal}
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
          data-loaded={!loading}
          className="h-full overflow-x-hidden overflow-y-auto p-[15px] leading-[1.5] break-words whitespace-pre-wrap"
        >
          <div
            ref={innerRef}
            className={cn("max-w-4xl mx-auto", deferredMessages.length === 0 && "h-full")}
          >
            {deferredMessages.length === 0 ? (
              <div className="text-placeholder flex h-full flex-1 flex-col items-center justify-center text-center [&_h3]:m-0 [&_h3]:mb-2.5 [&_h3]:text-base [&_h3]:font-medium [&_p]:m-0 [&_p]:text-[13px]">
                <h3>No Messages Yet</h3>
                <p>Send a message below to begin</p>
                <p className="text-muted mt-5 flex items-start gap-2 text-xs">
                  <Lightbulb aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    Tip: Add a{" "}
                    <code className="bg-inline-code-dark-bg text-code-string rounded-[3px] px-1.5 py-0.5 font-mono text-[11px]">
                      .mux/init
                    </code>{" "}
                    hook to your project to run setup commands
                    <br />
                    (e.g., install dependencies, build) when creating new workspaces
                  </span>
                </p>
              </div>
            ) : (
              <MessageListProvider value={messageListContextValue}>
                <>
                  {deferredMessages.map((msg, index) => {
                    // Compute bash_output grouping at render-time
                    const bashOutputGroup = computeBashOutputGroupInfo(deferredMessages, index);

                    // For bash_output groups, use first message ID as expansion key
                    const groupKey = bashOutputGroup
                      ? deferredMessages[bashOutputGroup.firstIndex]?.id
                      : undefined;
                    const isGroupExpanded = groupKey ? expandedBashGroups.has(groupKey) : false;

                    // Skip rendering middle items in a bash_output group (unless expanded)
                    if (bashOutputGroup?.position === "middle" && !isGroupExpanded) {
                      return null;
                    }

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
                            onReviewNote={handleReviewNote}
                            isLatestProposePlan={
                              msg.type === "tool" &&
                              msg.toolName === "propose_plan" &&
                              msg.id === latestProposePlanId
                            }
                            bashOutputGroup={bashOutputGroup}
                          />
                        </div>
                        {/* Show collapsed indicator after the first item in a bash_output group */}
                        {bashOutputGroup?.position === "first" && groupKey && (
                          <BashOutputCollapsedIndicator
                            processId={bashOutputGroup.processId}
                            collapsedCount={bashOutputGroup.collapsedCount}
                            isExpanded={isGroupExpanded}
                            onToggle={() => {
                              setExpandedBashGroups((prev) => {
                                const next = new Set(prev);
                                if (next.has(groupKey)) {
                                  next.delete(groupKey);
                                } else {
                                  next.add(groupKey);
                                }
                                return next;
                              });
                            }}
                          />
                        )}
                        {isAtCutoff && <EditCutoffBarrier />}
                        {shouldShowInterruptedBarrier(msg) && <InterruptedBarrier />}
                      </React.Fragment>
                    );
                  })}
                  {/* Show RetryBarrier after the last message if needed */}
                  {showRetryBarrierUI && <RetryBarrier workspaceId={workspaceId} />}
                </>
              </MessageListProvider>
            )}
            <PinnedTodoList workspaceId={workspaceId} />
            <StreamingBarrier workspaceId={workspaceId} />
            {shouldShowQueuedAgentTaskPrompt && (
              <QueuedMessage
                message={{
                  id: `queued-agent-task-${workspaceId}`,
                  content: queuedAgentTaskPrompt ?? "",
                }}
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
            className="assistant-chip font-primary text-foreground hover:assistant-chip-hover absolute bottom-2 left-1/2 z-20 -translate-x-1/2 cursor-pointer rounded-[20px] px-2 py-1 text-xs font-medium shadow-[0_4px_12px_rgba(0,0,0,0.3)] backdrop-blur-[1px] transition-all duration-200 hover:scale-105 active:scale-95"
          >
            Press {formatKeybind(KEYBINDS.JUMP_TO_BOTTOM)} to jump to bottom
          </button>
        )}
      </div>
      <ChatInputPane
        workspaceId={workspaceId}
        projectName={projectName}
        workspaceName={workspaceName}
        runtimeConfig={runtimeConfig}
        isQueuedAgentTask={isQueuedAgentTask}
        isCompacting={isCompacting}
        canInterrupt={canInterrupt}
        autoCompactionResult={autoCompactionResult}
        shouldShowCompactionWarning={shouldShowCompactionWarning}
        onCompactClick={handleCompactClick}
        onMessageSent={handleMessageSent}
        onTruncateHistory={handleClearHistory}
        onProviderConfig={handleProviderConfig}
        editingMessage={editingMessage}
        onCancelEdit={handleCancelEdit}
        onEditLastUserMessage={handleEditLastUserMessageClick}
        onChatInputReady={handleChatInputReady}
        hasQueuedCompaction={Boolean(workspaceState.queuedMessage?.hasCompactionRequest)}
        reviews={reviews}
        onCheckReviews={handleCheckReviews}
      />
    </div>
  );
};

interface ChatInputPaneProps {
  workspaceId: string;
  projectName: string;
  workspaceName: string;
  runtimeConfig?: RuntimeConfig;
  isQueuedAgentTask: boolean;
  isCompacting: boolean;
  canInterrupt: boolean;
  autoCompactionResult: ReturnType<typeof checkAutoCompaction>;
  shouldShowCompactionWarning: boolean;
  onCompactClick: () => void;
  onMessageSent: () => void;
  onTruncateHistory: (percentage?: number) => Promise<void>;
  onProviderConfig: (provider: string, keyPath: string[], value: string) => Promise<void>;
  editingMessage: EditingMessageState;
  onCancelEdit: () => void;
  onEditLastUserMessage: () => void;
  onChatInputReady: (api: ChatInputAPI) => void;
  hasQueuedCompaction: boolean;
  reviews: ReviewsState;
  onCheckReviews: (ids: string[]) => void;
}

const ChatInputPane: React.FC<ChatInputPaneProps> = (props) => {
  const { reviews } = props;

  return (
    <>
      {props.shouldShowCompactionWarning && (
        <CompactionWarning
          usagePercentage={props.autoCompactionResult.usagePercentage}
          thresholdPercentage={props.autoCompactionResult.thresholdPercentage}
          isStreaming={props.canInterrupt}
          onCompactClick={props.onCompactClick}
        />
      )}
      <BackgroundProcessesBanner workspaceId={props.workspaceId} />
      <ReviewsBanner workspaceId={props.workspaceId} />
      {props.isQueuedAgentTask && (
        <div className="border-border-medium bg-background-secondary text-muted mb-2 rounded-md border px-3 py-2 text-xs">
          This agent task is queued and will start automatically when a parallel slot is available.
        </div>
      )}
      <ChatInput
        key={props.workspaceId}
        variant="workspace"
        workspaceId={props.workspaceId}
        runtimeType={getRuntimeTypeForTelemetry(props.runtimeConfig)}
        onMessageSent={props.onMessageSent}
        onTruncateHistory={props.onTruncateHistory}
        onProviderConfig={props.onProviderConfig}
        disabled={!props.projectName || !props.workspaceName || props.isQueuedAgentTask}
        disabledReason={
          props.isQueuedAgentTask
            ? "Queued — waiting for an available parallel task slot. This will start automatically."
            : undefined
        }
        isCompacting={props.isCompacting}
        editingMessage={props.editingMessage}
        onCancelEdit={props.onCancelEdit}
        onEditLastUserMessage={props.onEditLastUserMessage}
        canInterrupt={props.canInterrupt}
        onReady={props.onChatInputReady}
        autoCompactionCheck={props.autoCompactionResult}
        hasQueuedCompaction={props.hasQueuedCompaction}
        attachedReviews={reviews.attachedReviews}
        onDetachReview={reviews.detachReview}
        onDetachAllReviews={reviews.detachAllAttached}
        onCheckReview={reviews.checkReview}
        onCheckReviews={props.onCheckReviews}
        onDeleteReview={reviews.removeReview}
        onUpdateReviewNote={reviews.updateReviewNote}
      />
    </>
  );
};

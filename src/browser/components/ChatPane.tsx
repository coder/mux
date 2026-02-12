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
import { VIM_ENABLED_KEY } from "@/common/constants/storage";
import { ChatInput, type ChatInputAPI } from "./ChatInput/index";
import {
  shouldShowInterruptedBarrier,
  mergeConsecutiveStreamErrors,
  computeBashOutputGroupInfo,
  shouldBypassDeferredMessages,
} from "@/browser/utils/messages/messageUtils";
import { computeTaskReportLinking } from "@/browser/utils/messages/taskReportLinking";
import { BashOutputCollapsedIndicator } from "./tools/BashOutputCollapsedIndicator";
import { enableAutoRetryPreference } from "@/browser/utils/messages/autoRetryPreference";
import {
  getInterruptionContext,
  getLastNonDecorativeMessage,
} from "@/browser/utils/messages/retryEligibility";
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
import type { DisplayedMessage, QueuedMessage as QueuedMessageData } from "@/common/types/message";
import type { RuntimeConfig } from "@/common/types/runtime";
import { getRuntimeTypeForTelemetry } from "@/common/telemetry";
import { useAIViewKeybinds } from "@/browser/hooks/useAIViewKeybinds";
import { QueuedMessage } from "./Messages/QueuedMessage";
import { CompactionWarning } from "./CompactionWarning";
import { ContextSwitchWarning as ContextSwitchWarningBanner } from "./ContextSwitchWarning";
import { ConcurrentLocalWarning } from "./ConcurrentLocalWarning";
import { BackgroundProcessesBanner } from "./BackgroundProcessesBanner";
import { checkAutoCompaction } from "@/browser/utils/compaction/autoCompactionCheck";
import type { ContextSwitchWarning } from "@/browser/utils/compaction/contextSwitchCheck";
import { executeCompaction } from "@/browser/utils/chatCommands";
import { useProviderOptions } from "@/browser/hooks/useProviderOptions";
import { useAutoCompactionSettings } from "../hooks/useAutoCompactionSettings";
import { useContextSwitchWarning } from "@/browser/hooks/useContextSwitchWarning";
import { useSendMessageOptions } from "@/browser/hooks/useSendMessageOptions";
import { useForceCompaction } from "@/browser/hooks/useForceCompaction";
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
import {
  buildEditingStateFromDisplayed,
  normalizeQueuedMessage,
  type EditingMessageState,
} from "@/browser/utils/chatEditing";

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
  onOpenTerminal: (options?: TerminalSessionCreateOptions) => void;
}

type ReviewsState = ReturnType<typeof useReviews>;

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
  const workspaceTitle = meta?.title ?? meta?.name ?? workspaceName;
  const isQueuedAgentTask = Boolean(meta?.parentWorkspaceId) && meta?.taskStatus === "queued";
  const queuedAgentTaskPrompt =
    isQueuedAgentTask && typeof meta?.taskPrompt === "string" && meta.taskPrompt.trim().length > 0
      ? meta.taskPrompt
      : null;
  const shouldShowQueuedAgentTaskPrompt =
    Boolean(queuedAgentTaskPrompt) && (workspaceState?.messages.length ?? 0) === 0;

  const { has1MContext } = useProviderOptions();
  // Resolve 1M context per-model (uses the pending model for the current workspace)
  const pendingSendOptions = useSendMessageOptions(workspaceId);
  const pendingModel = pendingSendOptions.model;
  const use1M = has1MContext(pendingModel);

  const { threshold: autoCompactionThreshold } = useAutoCompactionSettings(
    workspaceId,
    pendingModel
  );

  const [editingState, setEditingState] = useState(() => ({
    workspaceId,
    message: undefined as EditingMessageState | undefined,
  }));
  const editingMessage =
    editingState.workspaceId === workspaceId ? editingState.message : undefined;
  const setEditingMessage = useCallback(
    (message: EditingMessageState | undefined) => {
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
  const { messages, canInterrupt, isCompacting, isStreamStarting, loading } = workspaceState;

  const {
    warning: contextSwitchWarning,
    handleModelChange,
    handleCompact: handleContextSwitchCompact,
    handleDismiss: handleContextSwitchDismiss,
  } = useContextSwitchWarning({
    workspaceId,
    messages,
    pendingModel,
    use1M,
    workspaceUsage,
    api: api ?? undefined,
    pendingSendOptions,
  });

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
  const shouldBypassDeferral = shouldBypassDeferredMessages(
    transformedMessages,
    deferredTransformedMessages
  );
  const deferredMessages = shouldBypassDeferral ? transformedMessages : deferredTransformedMessages;

  const latestMessageId = getLastNonDecorativeMessage(deferredMessages)?.id ?? null;
  const messageListContextValue = useMemo(
    () => ({
      workspaceId,
      latestMessageId,
      openTerminal: onOpenTerminal,
    }),
    [workspaceId, latestMessageId, onOpenTerminal]
  );

  // Compute navigation map for user messages (prev/next historyIds for each user message)
  // Only enabled when there are 2+ user messages to navigate between
  const userMessageNavMap = useMemo(() => {
    const userMessages = deferredMessages.filter(
      (m): m is DisplayedMessage & { type: "user" } => m.type === "user"
    );
    // Only enable navigation when there are multiple user messages
    if (userMessages.length < 2) return null;

    const navMap = new Map<string, { prev?: string; next?: string }>();
    for (let i = 0; i < userMessages.length; i++) {
      const msg = userMessages[i];
      navMap.set(msg.historyId, {
        prev: i > 0 ? userMessages[i - 1].historyId : undefined,
        next: i < userMessages.length - 1 ? userMessages[i + 1].historyId : undefined,
      });
    }
    return navMap;
  }, [deferredMessages]);

  const taskReportLinking = useMemo(
    () => computeTaskReportLinking(deferredMessages),
    [deferredMessages]
  );

  const autoCompactionResult = useMemo(
    () => checkAutoCompaction(workspaceUsage, pendingModel, use1M, autoCompactionThreshold / 100),
    [workspaceUsage, pendingModel, use1M, autoCompactionThreshold]
  );

  // Show warning when: shouldShowWarning flag is true AND not currently compacting.
  // Context-switch warning takes priority so we don't show competing banners.
  const shouldShowCompactionWarning =
    !isCompacting && autoCompactionResult.shouldShowWarning && !contextSwitchWarning;

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
      followUpContent: { text: "Continue" },
    });
  }, [api, workspaceId, pendingSendOptions, autoBackgroundOnSend]);

  // Force compaction when live usage shows we're about to hit context limit
  useForceCompaction({
    shouldForceCompact: autoCompactionResult.shouldForceCompact,
    canInterrupt,
    isCompacting,
    onTrigger: handleForceCompaction,
  });

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

  // Handler to navigate (scroll) to a specific message by historyId
  const handleNavigateToMessage = useCallback(
    (historyId: string) => {
      // Disable auto-scroll so the navigation isn't undone by streaming content
      setAutoScroll(false);
      requestAnimationFrame(() => {
        const element = contentRef.current?.querySelector(`[data-message-id="${historyId}"]`);
        element?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    },
    [contentRef, setAutoScroll]
  );

  // ChatInput API for focus management
  const chatInputAPI = useRef<ChatInputAPI | null>(null);

  // ChatPane is keyed by workspaceId (WorkspaceShell), so per-workspace UI state naturally
  // resets on workspace switches. Clear background errors so they don't leak across workspaces.
  useEffect(() => {
    clearBackgroundBashError();
  }, [clearBackgroundBashError]);

  const handleChatInputReady = useCallback((api: ChatInputAPI) => {
    chatInputAPI.current = api;
  }, []);

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
    (message: EditingMessageState) => {
      setEditingMessage(message);
    },
    [setEditingMessage]
  );

  const restoreQueuedDraft = useCallback(
    async (queuedMessage: QueuedMessageData) => {
      const inputApi = chatInputAPI.current;
      if (!inputApi) return;

      await api?.workspace.clearQueue({ workspaceId });
      inputApi.restoreDraft(normalizeQueuedMessage(queuedMessage));
    },
    [api, workspaceId]
  );

  const handleEditQueuedMessage = useCallback(async () => {
    const queuedMessage = workspaceState?.queuedMessage;
    if (!queuedMessage) return;

    await restoreQueuedDraft(queuedMessage);
  }, [restoreQueuedDraft, workspaceState?.queuedMessage]);

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
      await restoreQueuedDraft(current.queuedMessage);
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

    setEditingMessage(buildEditingStateFromDisplayed(lastUserMessage));
    setAutoScroll(false); // Show jump-to-bottom indicator

    // Scroll to the message being edited
    requestAnimationFrame(() => {
      const element = contentRef.current?.querySelector(
        `[data-message-id="${lastUserMessage.historyId}"]`
      );
      element?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [restoreQueuedDraft, contentRef, setAutoScroll, setEditingMessage]);

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
    enableAutoRetryPreference(workspaceId);
  }, [setAutoScroll, autoBackgroundOnSend, workspaceId]);

  const handleClearHistory = useCallback(
    async (percentage = 1.0) => {
      // Enable auto-scroll after clearing
      setAutoScroll(true);

      // Truncate history in backend
      await api?.workspace.truncateHistory({ workspaceId, percentage });
    },
    [workspaceId, setAutoScroll, api]
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

  const lastActionableMessage = getLastNonDecorativeMessage(workspaceState.messages);
  const suppressRetryBarrier =
    lastActionableMessage?.type === "stream-error" &&
    lastActionableMessage.errorType === "context_exceeded";
  const showRetryBarrierUI = showRetryBarrier && !suppressRetryBarrier;

  // Handle keyboard shortcuts (using optional refs that are safe even if not initialized)
  useAIViewKeybinds({
    workspaceId,
    // Allow interrupt keybind even while waiting for stream-start ("starting...").
    canInterrupt:
      (workspaceState?.canInterrupt ?? false) ||
      typeof workspaceState?.pendingStreamStartTime === "number",
    showRetryBarrier,
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
      (
        msg
      ): msg is Exclude<
        DisplayedMessage,
        { type: "history-hidden" | "workspace-init" | "compaction-boundary" }
      > =>
        msg.type !== "history-hidden" &&
        msg.type !== "workspace-init" &&
        msg.type !== "compaction-boundary" &&
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
        (
          msg
        ): msg is Exclude<
          DisplayedMessage,
          { type: "history-hidden" | "workspace-init" | "compaction-boundary" }
        > =>
          msg.type !== "history-hidden" &&
          msg.type !== "workspace-init" &&
          msg.type !== "compaction-boundary" &&
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
        workspaceTitle={workspaceTitle}
        leftSidebarCollapsed={leftSidebarCollapsed}
        onToggleLeftSidebarCollapsed={onToggleLeftSidebarCollapsed}
        namedWorkspacePath={namedWorkspacePath}
        runtimeConfig={runtimeConfig}
        onOpenTerminal={onOpenTerminal}
      />

      {/* Spacer for fixed mobile header - mobile-header-spacer adds padding-top on touch devices */}
      <div className="mobile-header-spacer relative flex-1 overflow-hidden">
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
                      msg.type !== "compaction-boundary" &&
                      msg.historyId === editCutoffHistoryId;

                    return (
                      <React.Fragment key={msg.id}>
                        <div
                          data-testid="chat-message"
                          data-message-id={
                            msg.type !== "history-hidden" &&
                            msg.type !== "workspace-init" &&
                            msg.type !== "compaction-boundary"
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
                            taskReportLinking={taskReportLinking}
                            userMessageNavigation={
                              msg.type === "user" && userMessageNavMap
                                ? {
                                    prevUserMessageId: userMessageNavMap.get(msg.historyId)?.prev,
                                    nextUserMessageId: userMessageNavMap.get(msg.historyId)?.next,
                                    onNavigate: handleNavigateToMessage,
                                  }
                                : undefined
                            }
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
        isStreamStarting={isStreamStarting}
        runtimeConfig={runtimeConfig}
        isQueuedAgentTask={isQueuedAgentTask}
        isCompacting={isCompacting}
        canInterrupt={canInterrupt}
        autoCompactionResult={autoCompactionResult}
        shouldShowCompactionWarning={shouldShowCompactionWarning}
        contextSwitchWarning={contextSwitchWarning}
        onContextSwitchCompact={handleContextSwitchCompact}
        onContextSwitchDismiss={handleContextSwitchDismiss}
        onModelChange={handleModelChange}
        onCompactClick={handleCompactClick}
        onMessageSent={handleMessageSent}
        onTruncateHistory={handleClearHistory}
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
  isStreamStarting: boolean;
  canInterrupt: boolean;
  autoCompactionResult: ReturnType<typeof checkAutoCompaction>;
  shouldShowCompactionWarning: boolean;
  contextSwitchWarning: ContextSwitchWarning | null;
  onContextSwitchCompact: () => void;
  onContextSwitchDismiss: () => void;
  onModelChange?: (model: string) => void;
  onCompactClick: () => void;
  onMessageSent: () => void;
  onTruncateHistory: (percentage?: number) => Promise<void>;
  editingMessage: EditingMessageState | undefined;
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
      {props.contextSwitchWarning && (
        <ContextSwitchWarningBanner
          warning={props.contextSwitchWarning}
          onCompact={props.onContextSwitchCompact}
          onDismiss={props.onContextSwitchDismiss}
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
        onModelChange={props.onModelChange}
        disabled={!props.projectName || !props.workspaceName || props.isQueuedAgentTask}
        disabledReason={
          props.isQueuedAgentTask
            ? "Queued — waiting for an available parallel task slot. This will start automatically."
            : undefined
        }
        isStreamStarting={props.isStreamStarting}
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

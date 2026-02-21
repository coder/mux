import React, {
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useDeferredValue,
  useMemo,
} from "react";
import { Clipboard, Lightbulb, TextQuote } from "lucide-react";
import { copyToClipboard } from "@/browser/utils/clipboard";
import {
  formatTranscriptTextAsQuote,
  getTranscriptContextMenuText,
} from "@/browser/utils/messages/transcriptContextMenu";
import { useContextMenuPosition } from "@/browser/hooks/useContextMenuPosition";
import { PositionedMenu, PositionedMenuItem } from "./ui/positioned-menu";
import { MessageListProvider } from "./Messages/MessageListContext";
import { cn } from "@/common/lib/utils";
import { MessageRenderer } from "./Messages/MessageRenderer";
import type { UserMessageNavigation } from "./Messages/UserMessage";
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
  computeBashOutputGroupInfos,
  shouldBypassDeferredMessages,
} from "@/browser/utils/messages/messageUtils";
import { computeTaskReportLinking } from "@/browser/utils/messages/taskReportLinking";
import { BashOutputCollapsedIndicator } from "./tools/BashOutputCollapsedIndicator";
import {
  getInterruptionContext,
  getLastNonDecorativeMessage,
} from "@/common/utils/messages/retryEligibility";
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
import { WorkspaceMenuBar } from "./WorkspaceMenuBar";
import type { DisplayedMessage, QueuedMessage as QueuedMessageData } from "@/common/types/message";
import type { RuntimeConfig } from "@/common/types/runtime";
import { getRuntimeTypeForTelemetry } from "@/common/telemetry";
import { useAIViewKeybinds } from "@/browser/hooks/useAIViewKeybinds";
import { QueuedMessage } from "./Messages/QueuedMessage";
import { CompactionWarning } from "./CompactionWarning";
import { ContextSwitchWarning as ContextSwitchWarningBanner } from "./ContextSwitchWarning";
import { ConcurrentLocalWarning } from "./ConcurrentLocalWarning";
import { BackgroundProcessesBanner } from "./BackgroundProcessesBanner";
import { checkAutoCompaction } from "@/common/utils/compaction/autoCompactionCheck";
import { cancelCompaction } from "@/browser/utils/compaction/handler";
import type { ContextSwitchWarning } from "@/browser/utils/compaction/contextSwitchCheck";
import { useProviderOptions } from "@/browser/hooks/useProviderOptions";
import { useAutoCompactionSettings } from "../hooks/useAutoCompactionSettings";
import { useContextSwitchWarning } from "@/browser/hooks/useContextSwitchWarning";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { useSendMessageOptions } from "@/browser/hooks/useSendMessageOptions";
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
import { recordSyntheticReactRenderSample } from "@/browser/utils/perf/reactProfileCollector";

// Perf e2e runs load the production bundle where React's onRender profiler callbacks may not
// fire. This marker records synthetic commit timings for selected subtrees so automated perf
// runs still capture render-path metrics for workspace-open regressions.
function PerfRenderMarker(props: { id: string; children: React.ReactNode }): React.ReactElement {
  const renderStartTimeRef = useRef(performance.now());
  renderStartTimeRef.current = performance.now();
  const hasProfiledMountRef = useRef(false);

  useLayoutEffect(() => {
    if (window.api?.enableReactPerfProfile !== true) {
      return;
    }

    const commitTime = performance.now();
    const actualDuration = Math.max(0, commitTime - renderStartTimeRef.current);
    const phase = hasProfiledMountRef.current ? "update" : "mount";
    hasProfiledMountRef.current = true;

    recordSyntheticReactRenderSample({
      id: props.id,
      phase,
      actualDuration,
      baseDuration: actualDuration,
      startTime: renderStartTimeRef.current,
      commitTime,
    });
  });

  return <>{props.children}</>;
}

function isChromaticStorybookEnvironment(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  // Keep production behavior unchanged while suppressing story-only snapshot churn.
  const isStorybookPreview = window.location.pathname.endsWith("iframe.html");
  if (!isStorybookPreview) {
    return false;
  }

  const chromaticRuntimeFlag = (window as Window & { chromatic?: boolean }).chromatic;
  return /Chromatic/i.test(window.navigator.userAgent) || chromaticRuntimeFlag === true;
}

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
  /** Hide + inactivate chat pane while immersive review overlay is active. */
  immersiveHidden?: boolean;
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
    immersiveHidden = false,
  } = props;
  const { api } = useAPI();
  const { workspaceMetadata } = useWorkspaceContext();
  const chatAreaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const chatPaneElement = chatAreaRef.current;
    if (!chatPaneElement) {
      return;
    }

    if (immersiveHidden) {
      chatPaneElement.setAttribute("inert", "");
    } else {
      chatPaneElement.removeAttribute("inert");
    }

    return () => {
      chatPaneElement.removeAttribute("inert");
    };
  }, [immersiveHidden, workspaceId]);

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

  const { config: providersConfig } = useProvidersConfig();

  const { threshold: autoCompactionThreshold } = useAutoCompactionSettings(
    workspaceId,
    pendingModel
  );

  useEffect(() => {
    if (!api) {
      return;
    }

    // Keep backend session threshold in sync with the persisted per-model slider value.
    const normalizedThreshold = Math.max(0.1, Math.min(1, autoCompactionThreshold / 100));
    void api.workspace.setAutoCompactionThreshold({
      workspaceId,
      threshold: normalizedThreshold,
    });
  }, [api, workspaceId, autoCompactionThreshold]);

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
  const {
    messages,
    canInterrupt,
    isCompacting,
    isStreamStarting,
    loading,
    isHydratingTranscript,
    hasOlderHistory,
    loadingOlderHistory,
  } = workspaceState;
  const shouldRenderLoadOlderMessagesButton = hasOlderHistory && !isChromaticStorybookEnvironment();
  const loadOlderMessagesShortcutLabel = formatKeybind(KEYBINDS.LOAD_OLDER_MESSAGES);

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
    providersConfig,
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

  const taskReportLinking = useMemo(
    () => computeTaskReportLinking(deferredMessages),
    [deferredMessages]
  );

  // Precompute bash_output grouping once per message snapshot so row rendering stays O(n).
  const bashOutputGroupInfos = useMemo(
    () => computeBashOutputGroupInfos(deferredMessages),
    [deferredMessages]
  );

  const autoCompactionResult = useMemo(
    () =>
      checkAutoCompaction(
        workspaceUsage,
        pendingModel,
        use1M,
        autoCompactionThreshold / 100,
        undefined,
        providersConfig
      ),
    [workspaceUsage, pendingModel, use1M, providersConfig, autoCompactionThreshold]
  );

  // Show warning when: shouldShowWarning flag is true AND not currently compacting.
  // Context-switch warning takes priority so we don't show competing banners.
  const shouldShowCompactionWarning =
    !isCompacting && autoCompactionResult.shouldShowWarning && !contextSwitchWarning;

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

  // Precompute per-user navigation objects so MessageRenderer rows receive stable prop
  // references across non-message updates (usage bumps, stats updates, etc.).
  const userMessageNavigationByHistoryId = useMemo(() => {
    const userHistoryIds: string[] = [];
    for (const message of deferredMessages) {
      if (message.type === "user") {
        userHistoryIds.push(message.historyId);
      }
    }

    if (userHistoryIds.length < 2) {
      return null;
    }

    const navigationByHistoryId = new Map<string, UserMessageNavigation>();
    for (let index = 0; index < userHistoryIds.length; index++) {
      navigationByHistoryId.set(userHistoryIds[index], {
        prevUserMessageId: index > 0 ? userHistoryIds[index - 1] : undefined,
        nextUserMessageId:
          index < userHistoryIds.length - 1 ? userHistoryIds[index + 1] : undefined,
        onNavigate: handleNavigateToMessage,
      });
    }

    return navigationByHistoryId;
  }, [deferredMessages, handleNavigateToMessage]);

  // ChatInput API for focus management
  const chatInputAPI = useRef<ChatInputAPI | null>(null);

  // Right-clicking transcript text offers quick quote/copy actions,
  // using selection first and hovered text as a fallback when nothing is selected.
  const transcriptMenu = useContextMenuPosition();
  const transcriptMenuTextRef = useRef<string>("");

  const handleTranscriptContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const transcriptRoot = contentRef.current;
      if (!transcriptRoot) return;

      const selection = typeof window === "undefined" ? null : window.getSelection();
      const text = getTranscriptContextMenuText({
        transcriptRoot,
        target: event.target,
        selection,
      });

      if (!text) {
        transcriptMenu.close();
        return;
      }

      transcriptMenuTextRef.current = text;
      transcriptMenu.onContextMenu(event);
    },
    [contentRef, transcriptMenu]
  );

  const handleQuoteHoveredText = useCallback(() => {
    const quotedText = formatTranscriptTextAsQuote(transcriptMenuTextRef.current.trim());
    transcriptMenu.close();
    if (!quotedText) return;
    chatInputAPI.current?.appendText(quotedText);
    chatInputAPI.current?.focus();
  }, [transcriptMenu]);

  const handleCopyHoveredText = useCallback(() => {
    void copyToClipboard(transcriptMenuTextRef.current);
    transcriptMenu.close();
  }, [transcriptMenu]);

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

  const handleCancelCompactionFromBarrier = useCallback(() => {
    if (!api || !aggregator) {
      return;
    }

    void cancelCompaction(api, workspaceId, aggregator, setEditingMessage);
  }, [api, workspaceId, aggregator, setEditingMessage]);

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
  }, [setAutoScroll, autoBackgroundOnSend]);

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

  // Compute showRetryBarrier once for both keybinds and UI.
  // Track if last message was interrupted or errored (for RetryBarrier).
  const interruption = workspaceState
    ? getInterruptionContext(
        workspaceState.messages,
        workspaceState.pendingStreamStartTime,
        workspaceState.runtimeStatus,
        workspaceState.lastAbortReason
      )
    : null;

  const hasInterruptedStream = interruption?.hasInterruptedStream ?? false;
  // Keep rendering cached transcript rows during incremental catch-up so workspace switches
  // feel stable; only show the full placeholder when there's no transcript content yet.
  const showTranscriptHydrationPlaceholder = isHydratingTranscript && deferredMessages.length === 0;
  const showRetryBarrier =
    !isHydratingTranscript && !workspaceState.canInterrupt && hasInterruptedStream;

  const lastActionableMessage = getLastNonDecorativeMessage(workspaceState.messages);
  const suppressRetryBarrier =
    lastActionableMessage?.type === "stream-error" &&
    lastActionableMessage.errorType === "context_exceeded";
  // Keep RetryBarrier mounted (but visually hidden) while a resumed stream is in flight
  // so its temporary auto-retry rollback effect can observe terminal stream outcomes.
  const shouldMountRetryBarrier = hasInterruptedStream && !suppressRetryBarrier;
  const showRetryBarrierUI = showRetryBarrier && !suppressRetryBarrier;

  const handleLoadOlderHistory = useCallback(() => {
    if (!shouldRenderLoadOlderMessagesButton || loadingOlderHistory) {
      return;
    }

    storeRaw.loadOlderHistory(workspaceId).catch((error) => {
      console.warn(`[ChatPane] Failed to load older history for ${workspaceId}:`, error);
    });
  }, [loadingOlderHistory, shouldRenderLoadOlderMessagesButton, storeRaw, workspaceId]);

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
    loadOlderHistory: shouldRenderLoadOlderMessagesButton ? handleLoadOlderHistory : null,
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
    <PerfRenderMarker id="chat-pane">
      <div
        ref={chatAreaRef}
        aria-hidden={immersiveHidden || undefined}
        className="flex min-w-96 flex-1 flex-col [@media(max-width:768px)]:max-h-full [@media(max-width:768px)]:w-full [@media(max-width:768px)]:min-w-0"
      >
        <PerfRenderMarker id="chat-pane.header">
          <WorkspaceMenuBar
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
        </PerfRenderMarker>

        <PerfRenderMarker id="chat-pane.transcript">
          {/* Spacer for fixed mobile header - mobile-header-spacer adds padding-top on touch devices */}
          <div className="mobile-header-spacer relative flex-1 overflow-hidden">
            <div
              ref={contentRef}
              onWheel={markUserInteraction}
              onTouchMove={markUserInteraction}
              onScroll={handleScroll}
              onContextMenu={handleTranscriptContextMenu}
              role="log"
              aria-live={canInterrupt ? "polite" : "off"}
              aria-busy={canInterrupt || isHydratingTranscript}
              aria-label="Conversation transcript"
              tabIndex={0}
              data-testid="message-window"
              data-loaded={!loading && !isHydratingTranscript}
              className="h-full overflow-x-hidden overflow-y-auto p-[15px] leading-[1.5] break-words whitespace-pre-wrap"
            >
              <div
                ref={innerRef}
                className={cn(
                  "max-w-4xl mx-auto",
                  (showTranscriptHydrationPlaceholder || deferredMessages.length === 0) && "h-full"
                )}
              >
                {showTranscriptHydrationPlaceholder ? (
                  <div
                    data-testid="transcript-hydration-placeholder"
                    className="text-placeholder flex h-full flex-1 flex-col items-center justify-center text-center [&_h3]:m-0 [&_h3]:mb-2.5 [&_h3]:text-base [&_h3]:font-medium [&_p]:m-0 [&_p]:text-[13px]"
                  >
                    <h3>Loading transcript...</h3>
                    <p>Syncing recent messages for this workspace</p>
                  </div>
                ) : deferredMessages.length === 0 ? (
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
                      {shouldRenderLoadOlderMessagesButton && (
                        <div className="flex justify-center py-3">
                          <button
                            type="button"
                            onClick={handleLoadOlderHistory}
                            disabled={loadingOlderHistory}
                            title={`Load older messages (${loadOlderMessagesShortcutLabel})`}
                            className="text-muted hover:text-foreground text-xs underline underline-offset-2 transition-colors disabled:opacity-50"
                          >
                            {loadingOlderHistory ? "Loading..." : "Load older messages"}
                          </button>
                        </div>
                      )}
                      {deferredMessages.map((msg, index) => {
                        const bashOutputGroup = bashOutputGroupInfos[index];

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

                        const taskReportLinkingForMessage =
                          msg.type === "tool" &&
                          (msg.toolName === "task" || msg.toolName === "task_await")
                            ? taskReportLinking
                            : undefined;

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
                                taskReportLinking={taskReportLinkingForMessage}
                                userMessageNavigation={
                                  msg.type === "user"
                                    ? userMessageNavigationByHistoryId?.get(msg.historyId)
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
                      {shouldMountRetryBarrier && (
                        <RetryBarrier
                          workspaceId={workspaceId}
                          className={!showRetryBarrierUI ? "hidden" : undefined}
                        />
                      )}
                    </>
                  </MessageListProvider>
                )}
                <PinnedTodoList workspaceId={workspaceId} />
                <StreamingBarrier
                  workspaceId={workspaceId}
                  vimEnabled={vimEnabled}
                  onCancelCompaction={handleCancelCompactionFromBarrier}
                />
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
            <PositionedMenu
              open={transcriptMenu.isOpen}
              onOpenChange={transcriptMenu.onOpenChange}
              position={transcriptMenu.position}
            >
              <PositionedMenuItem
                icon={<TextQuote />}
                label="Quote in input"
                onClick={handleQuoteHoveredText}
              />
              <PositionedMenuItem
                icon={<Clipboard />}
                label="Copy text"
                onClick={handleCopyHoveredText}
              />
            </PositionedMenu>
            {!autoScroll && (
              <button
                onClick={jumpToBottom}
                type="button"
                className="assistant-chip font-primary text-foreground hover:assistant-chip-hover absolute bottom-2 left-1/2 z-20 -translate-x-1/2 cursor-pointer rounded-[20px] px-2 py-1 text-xs font-medium shadow-[0_4px_12px_rgba(0,0,0,0.3)] backdrop-blur-[1px] transition-all duration-200 hover:scale-105 active:scale-95"
              >
                Jump to bottom{" "}
                <span className="mobile-hide-shortcut-hints">
                  ({formatKeybind(KEYBINDS.JUMP_TO_BOTTOM)})
                </span>
              </button>
            )}
          </div>
        </PerfRenderMarker>
        <PerfRenderMarker id="chat-pane.input">
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
            onMessageSent={handleMessageSent}
            onTruncateHistory={handleClearHistory}
            editingMessage={editingMessage}
            onCancelEdit={handleCancelEdit}
            onEditLastUserMessage={handleEditLastUserMessageClick}
            onChatInputReady={handleChatInputReady}
            reviews={reviews}
            onCheckReviews={handleCheckReviews}
          />
        </PerfRenderMarker>
      </div>
    </PerfRenderMarker>
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
  onMessageSent: () => void;
  onTruncateHistory: (percentage?: number) => Promise<void>;
  editingMessage: EditingMessageState | undefined;
  onCancelEdit: () => void;
  onEditLastUserMessage: () => void;
  onChatInputReady: (api: ChatInputAPI) => void;
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

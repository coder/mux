import type { JSX } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  TextInput,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme";
import { ThemedText } from "../components/ThemedText";
import { useApiClient } from "../hooks/useApiClient";
import { useWorkspaceActions } from "../contexts/WorkspaceActionsContext";
import { useWorkspaceCost } from "../contexts/WorkspaceCostContext";
import type { StreamAbortEvent, StreamEndEvent } from "@shared/types/stream.ts";
import { MessageRenderer } from "../messages/MessageRenderer";
import { useWorkspaceSettings } from "../hooks/useWorkspaceSettings";
import { FloatingTodoCard } from "../components/FloatingTodoCard";
import type { TodoItem } from "../components/TodoItemView";
import { createChatEventExpander, DISPLAYABLE_MESSAGE_TYPES } from "../messages/normalizeChatEvent";
import type { DisplayedMessage, FrontendWorkspaceMetadata, WorkspaceChatEvent } from "../types";
import { createCompactedMessage } from "../utils/messageHelpers";
type ThemeSpacing = ReturnType<typeof useTheme>["spacing"];

type TimelineEntry =
  | { kind: "displayed"; key: string; message: DisplayedMessage }
  | { kind: "raw"; key: string; payload: WorkspaceChatEvent };

function isDisplayedMessageEvent(event: WorkspaceChatEvent): event is DisplayedMessage {
  if (!event || typeof event !== "object") {
    return false;
  }
  const maybeType = (event as { type?: unknown }).type;
  if (typeof maybeType !== "string") {
    return false;
  }
  if (!DISPLAYABLE_MESSAGE_TYPES.has(maybeType as DisplayedMessage["type"])) {
    return false;
  }
  if (!("historySequence" in event)) {
    return false;
  }
  const sequence = (event as { historySequence?: unknown }).historySequence;
  return typeof sequence === "number" && Number.isFinite(sequence);
}

function isDeleteEvent(
  event: WorkspaceChatEvent
): event is { type: "delete"; historySequences: number[] } {
  return (
    typeof event === "object" &&
    event !== null &&
    "type" in event &&
    (event as { type: unknown }).type === "delete" &&
    Array.isArray((event as { historySequences?: unknown }).historySequences)
  );
}

function compareDisplayedMessages(a: DisplayedMessage, b: DisplayedMessage): number {
  if (a.historySequence !== b.historySequence) {
    return a.historySequence - b.historySequence;
  }
  const seqA = "streamSequence" in a && typeof a.streamSequence === "number" ? a.streamSequence : 0;
  const seqB = "streamSequence" in b && typeof b.streamSequence === "number" ? b.streamSequence : 0;
  return seqA - seqB;
}

function applyChatEvent(current: TimelineEntry[], event: WorkspaceChatEvent): TimelineEntry[] {
  if (isDeleteEvent(event)) {
    const sequences = new Set(event.historySequences);
    return current.filter((entry) => {
      if (entry.kind !== "displayed") {
        return true;
      }
      return !sequences.has(entry.message.historySequence);
    });
  }

  if (isDisplayedMessageEvent(event)) {
    // Check if message already exists (deduplicate)
    const existingIndex = current.findIndex(
      (item) => item.kind === "displayed" && item.message.id === event.id
    );

    if (existingIndex >= 0) {
      // Message already exists - check if it's an update
      const existingMessage = (
        current[existingIndex] as Extract<TimelineEntry, { kind: "displayed" }>
      ).message;

      // Check if it's a streaming update
      const isStreamingUpdate =
        existingMessage.historySequence === event.historySequence &&
        "isStreaming" in event &&
        (event as any).isStreaming === true;

      // Check if it's a tool status change (executing → completed/failed)
      const isToolStatusChange =
        existingMessage.type === "tool" &&
        event.type === "tool" &&
        existingMessage.historySequence === event.historySequence &&
        (existingMessage as any).status !== (event as any).status;

      if (isStreamingUpdate || isToolStatusChange) {
        // Update in place
        const updated = [...current];
        updated[existingIndex] = {
          kind: "displayed",
          key: `displayed-${event.id}`,
          message: event,
        };
        return updated;
      }

      // Same message, skip (already processed)
      return current;
    }

    // New message - add and sort only if needed
    const entry: TimelineEntry = {
      kind: "displayed",
      key: `displayed-${event.id}`,
      message: event,
    };

    // Check if we need to sort (is new message out of order?)
    const lastDisplayed = [...current]
      .reverse()
      .find(
        (item): item is Extract<TimelineEntry, { kind: "displayed" }> => item.kind === "displayed"
      );

    if (!lastDisplayed || compareDisplayedMessages(lastDisplayed.message, event) <= 0) {
      // New message is in order - just append (no sort needed)
      return [...current, entry];
    }

    // Out of order - need to sort
    const withoutExisting = current.filter(
      (item) => item.kind !== "displayed" || item.message.id !== event.id
    );
    const displayed = withoutExisting
      .filter(
        (item): item is Extract<TimelineEntry, { kind: "displayed" }> => item.kind === "displayed"
      )
      .concat(entry)
      .sort((left, right) => compareDisplayedMessages(left.message, right.message));
    const raw = withoutExisting.filter(
      (item): item is Extract<TimelineEntry, { kind: "raw" }> => item.kind === "raw"
    );
    return [...displayed, ...raw];
  }

  if (
    typeof event === "object" &&
    event !== null &&
    "type" in event &&
    ((event as { type: unknown }).type === "caught-up" ||
      (event as { type: unknown }).type === "stream-start")
  ) {
    return current;
  }

  const rawEntry: TimelineEntry = {
    kind: "raw",
    key: `raw-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    payload: event,
  };
  return [...current, rawEntry];
}

function formatProjectBreadcrumb(metadata: FrontendWorkspaceMetadata | null): string {
  if (!metadata) {
    return "Workspace";
  }
  return `${metadata.projectName} › ${metadata.name}`;
}

function RawEventCard({
  payload,
  onDismiss,
}: {
  payload: WorkspaceChatEvent;
  onDismiss?: () => void;
}): JSX.Element {
  const theme = useTheme();
  const spacing = theme.spacing;

  if (payload && typeof payload === "object" && "type" in payload) {
    const typed = payload as { type: unknown; [key: string]: unknown };
    if (typed.type === "status" && typeof typed.status === "string") {
      return <ThemedText variant="caption">{typed.status}</ThemedText>;
    }
    if (typed.type === "error" && typeof typed.error === "string") {
      return (
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing.sm }}>
          <ThemedText variant="muted" style={{ flex: 1, color: theme.colors.danger }}>
            ⚠️ {typed.error}
          </ThemedText>
          {onDismiss && (
            <Pressable onPress={onDismiss} hitSlop={8}>
              <Ionicons name="close" size={18} color={theme.colors.foregroundMuted} />
            </Pressable>
          )}
        </View>
      );
    }
  }
  if (typeof payload === "string") {
    return <ThemedText>{payload}</ThemedText>;
  }
  return <ThemedText variant="caption">{JSON.stringify(payload, null, 2)}</ThemedText>;
}

const TimelineRow = memo(
  ({
    item,
    spacing,
    onDismiss,
    workspaceId,
    onStartHere,
    onEditMessage,
    canEditMessage,
  }: {
    item: TimelineEntry;
    spacing: ThemeSpacing;
    onDismiss?: () => void;
    workspaceId?: string;
    onStartHere?: (content: string) => Promise<void>;
    onEditMessage?: (messageId: string, content: string) => void;
    canEditMessage?: (message: DisplayedMessage) => boolean;
  }) => {
    if (item.kind === "displayed") {
      return (
        <MessageRenderer
          message={item.message}
          workspaceId={workspaceId}
          onStartHere={onStartHere}
          onEditMessage={onEditMessage}
          canEdit={canEditMessage ? canEditMessage(item.message) : false}
        />
      );
    }
    return (
      <View
        style={{
          paddingVertical: spacing.sm,
          paddingHorizontal: spacing.md,
          marginBottom: spacing.sm,
          backgroundColor: "#252526",
          borderRadius: 8,
        }}
      >
        <RawEventCard payload={item.payload} onDismiss={onDismiss} />
      </View>
    );
  },
  (prev, next) =>
    prev.item === next.item &&
    prev.spacing === next.spacing &&
    prev.onDismiss === next.onDismiss &&
    prev.workspaceId === next.workspaceId &&
    prev.onEditMessage === next.onEditMessage &&
    prev.canEditMessage === next.canEditMessage &&
    prev.onStartHere === next.onStartHere
);

TimelineRow.displayName = "TimelineRow";

interface WorkspaceScreenInnerProps {
  workspaceId?: string | null;
  creationContext?: {
    projectPath: string;
    projectName: string;
    branches?: string[];
    defaultTrunk?: string;
  };
}

function WorkspaceScreenInner({
  workspaceId,
  creationContext,
}: WorkspaceScreenInnerProps): JSX.Element {
  const isCreationMode = !workspaceId && !!creationContext;
  const router = useRouter();
  const { recordStreamUsage } = useWorkspaceCost();
  const theme = useTheme();
  const spacing = theme.spacing;
  const insets = useSafeAreaInsets();
  const expanderRef = useRef(createChatEventExpander());
  const api = useApiClient();
  const {
    mode,
    thinkingLevel,
    model,
    use1MContext,
    isLoading: settingsLoading,
  } = useWorkspaceSettings(workspaceId ?? "");
  const [input, setInput] = useState("");

  // Creation mode: branch selection state
  const [branches, setBranches] = useState<string[]>(creationContext?.branches ?? []);
  const [trunkBranch, setTrunkBranch] = useState<string>(
    creationContext?.defaultTrunk ?? branches[0] ?? "main"
  );
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [isSending, setIsSending] = useState(false);
  const wsRef = useRef<{ close: () => void } | null>(null);
  const flatListRef = useRef<FlatList<TimelineEntry> | null>(null);
  const inputRef = useRef<TextInput>(null);

  // Editing state - tracks message being edited
  const [editingMessage, setEditingMessage] = useState<{ id: string; content: string } | undefined>(
    undefined
  );

  // Track current todos for floating card (during streaming)
  const [currentTodos, setCurrentTodos] = useState<TodoItem[]>([]);

  // Use context for todo card visibility
  const { todoCardVisible, toggleTodoCard, setHasTodos } = useWorkspaceActions();

  // Track streaming state for indicator
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingModel, setStreamingModel] = useState<string | null>(null);

  // Track deltas with timestamps for accurate TPS calculation (60s window like desktop)
  const deltasRef = useRef<Array<{ tokens: number; timestamp: number }>>([]);
  const [tokenDisplay, setTokenDisplay] = useState({ total: 0, tps: 0 });

  useEffect(() => {
    expanderRef.current = createChatEventExpander();
  }, [workspaceId]);

  // Load branches in creation mode
  useEffect(() => {
    if (!isCreationMode || !creationContext) return;

    async function loadBranches() {
      try {
        const result = await api.projects.listBranches(creationContext!.projectPath);
        const sanitized = result?.branches ?? [];
        setBranches(sanitized);
        const trunk = result?.recommendedTrunk ?? sanitized[0] ?? "main";
        setTrunkBranch(trunk);
      } catch (error) {
        console.error("Failed to load branches:", error);
        // Keep defaults
      }
    }
    void loadBranches();
  }, [isCreationMode, api, creationContext]);

  const metadataQuery = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => api.workspace.getInfo(workspaceId!),
    staleTime: 15_000,
    enabled: !isCreationMode && !!workspaceId,
  });

  const metadata = metadataQuery.data ?? null;

  // Extract most recent todos from timeline (timeline-based approach)
  useEffect(() => {
    // Find the most recent completed todo_write tool in timeline
    const toolMessages = timeline
      .filter(
        (entry): entry is Extract<TimelineEntry, { kind: "displayed" }> =>
          entry.kind === "displayed"
      )
      .map((entry) => entry.message)
      .filter((msg): msg is DisplayedMessage & { type: "tool" } => msg.type === "tool")
      .filter((msg) => msg.toolName === "todo_write");

    // Get the most recent one (timeline is already sorted)
    const latestTodoTool = toolMessages[toolMessages.length - 1];

    if (
      latestTodoTool &&
      latestTodoTool.args &&
      typeof latestTodoTool.args === "object" &&
      "todos" in latestTodoTool.args &&
      Array.isArray(latestTodoTool.args.todos)
    ) {
      const todos = latestTodoTool.args.todos as TodoItem[];
      setCurrentTodos(todos);
      setHasTodos(todos.length > 0);
    } else if (toolMessages.length === 0) {
      // Only clear if no todo_write tools exist at all
      setCurrentTodos([]);
      setHasTodos(false);
    }
  }, [timeline, setHasTodos]);

  useEffect(() => {
    // Skip WebSocket subscription in creation mode (no workspace yet)
    if (isCreationMode) return;

    const expander = expanderRef.current;
    const subscription = api.workspace.subscribeChat(workspaceId!, (payload) => {
      // Track streaming state and tokens (60s trailing window like desktop)
      if (payload && typeof payload === "object" && "type" in payload) {
        const typedEvent = payload as StreamEndEvent | StreamAbortEvent | { type: string };
        if (typedEvent.type === "stream-end" || typedEvent.type === "stream-abort") {
          recordStreamUsage(typedEvent as StreamEndEvent | StreamAbortEvent);
        }

        if (payload.type === "stream-start" && "model" in payload) {
          setIsStreaming(true);
          setStreamingModel(typeof payload.model === "string" ? payload.model : null);
          deltasRef.current = [];
          setTokenDisplay({ total: 0, tps: 0 });
        } else if (
          (payload.type === "stream-delta" ||
            payload.type === "reasoning-delta" ||
            payload.type === "tool-call-start" ||
            payload.type === "tool-call-delta") &&
          "tokens" in payload &&
          typeof payload.tokens === "number" &&
          payload.tokens > 0
        ) {
          const tokens = payload.tokens;
          const timestamp =
            "timestamp" in payload && typeof payload.timestamp === "number"
              ? payload.timestamp
              : Date.now();

          // Add delta with timestamp
          deltasRef.current.push({ tokens, timestamp });

          // Calculate with 60-second trailing window (like desktop)
          const now = Date.now();
          const windowStart = now - 60000; // 60 seconds
          const recentDeltas = deltasRef.current.filter((d) => d.timestamp >= windowStart);

          // Calculate total tokens and TPS
          const total = deltasRef.current.reduce((sum, d) => sum + d.tokens, 0);
          let tps = 0;

          if (recentDeltas.length > 0) {
            const recentTokens = recentDeltas.reduce((sum, d) => sum + d.tokens, 0);
            const timeSpanMs = now - recentDeltas[0].timestamp;
            const timeSpanSec = timeSpanMs / 1000;
            if (timeSpanSec > 0) {
              tps = Math.round(recentTokens / timeSpanSec);
            }
          }

          setTokenDisplay({ total, tps });
        } else if (payload.type === "stream-end" || payload.type === "stream-abort") {
          setIsStreaming(false);
          setStreamingModel(null);
          deltasRef.current = [];
          setTokenDisplay({ total: 0, tps: 0 });
        }
      }

      const expanded = expander.expand(payload);

      // If expander returns [], it means the event was handled but nothing to display yet
      // (e.g., streaming deltas accumulating). Do NOT fall back to raw display.
      if (expanded.length === 0) {
        return;
      }

      setTimeline((current) => {
        let next = current;
        let changed = false;
        for (const event of expanded) {
          const updated = applyChatEvent(next, event);
          if (updated !== next) {
            changed = true;
            next = updated;
          }
        }

        // Only return new array if actually changed (prevents FlatList re-render)
        return changed ? next : current;
      });
    });
    wsRef.current = subscription;
    return () => {
      subscription.close();
      wsRef.current = null;
    };
  }, [api, workspaceId, isCreationMode, recordStreamUsage]);

  // Reset timeline, todos, and editing state when workspace changes
  useEffect(() => {
    setTimeline([]);
    setCurrentTodos([]);
    setHasTodos(false);
    setEditingMessage(undefined);
    setInput("");
  }, [workspaceId, setHasTodos]);

  const onSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed) {
      return;
    }

    const wasEditing = !!editingMessage;
    const originalContent = input;

    // Clear input immediately for better UX
    setInput("");
    setIsSending(true);

    if (isCreationMode) {
      // CREATION MODE: Send first message to create workspace
      const result = await api.workspace.sendMessage(null, trimmed, {
        model,
        mode,
        thinkingLevel,
        projectPath: creationContext!.projectPath,
        trunkBranch,
        runtimeConfig: undefined, // Can add runtime preference loading
        providerOptions: {
          anthropic: {
            use1MContext,
          },
        },
      });

      if (!result.success) {
        console.error("[createWorkspace] Failed:", result.error);
        setTimeline((current) =>
          applyChatEvent(current, { type: "error", error: result.error } as WorkspaceChatEvent)
        );
        setInput(originalContent);
      } else if ("metadata" in result && result.metadata) {
        // Success! Navigate to new workspace
        router.replace(`/workspace/${result.metadata.id}`);
        // Note: router.replace ensures we don't go back to creation screen
      }

      setIsSending(false);
      return;
    }

    // NORMAL MODE: Send message - fire and forget
    // Actual errors will come via stream-error events from WebSocket
    const result = await api.workspace.sendMessage(workspaceId!, trimmed, {
      model,
      mode,
      thinkingLevel,
      editMessageId: editingMessage?.id, // Pass editMessageId if editing
      providerOptions: {
        anthropic: {
          use1MContext,
        },
      },
    });

    // Only show error for validation failures (not stream errors)
    if (!result.success) {
      console.error("[sendMessage] Validation failed:", result.error);
      setTimeline((current) =>
        applyChatEvent(current, { type: "error", error: result.error } as WorkspaceChatEvent)
      );

      // Restore edit state on error
      if (wasEditing) {
        setEditingMessage(editingMessage);
        setInput(originalContent);
      }
    } else {
      // Clear editing state on success
      if (wasEditing) {
        setEditingMessage(undefined);
      }
    }

    setIsSending(false);
  }, [
    api,
    input,
    mode,
    thinkingLevel,
    model,
    use1MContext,
    workspaceId,
    editingMessage,
    isCreationMode,
    creationContext,
    trunkBranch,
    router,
  ]);

  const onCancelStream = useCallback(async () => {
    if (!workspaceId) return;
    await api.workspace.interruptStream(workspaceId);
  }, [api, workspaceId]);

  const handleStartHere = useCallback(
    async (content: string) => {
      if (!workspaceId) return;
      const message = createCompactedMessage(content);
      const result = await api.workspace.replaceChatHistory(workspaceId, message);

      if (!result.success) {
        console.error("Failed to start here:", result.error);
        // Consider adding toast notification in future
      }
      // Success case: backend will send delete + new message via WebSocket
      // UI will update automatically via subscription
    },
    [api, workspaceId]
  );

  // Edit message handlers
  const handleStartEdit = useCallback((messageId: string, content: string) => {
    setEditingMessage({ id: messageId, content });
    setInput(content);
    // Focus input after a short delay to ensure keyboard opens
    setTimeout(() => {
      inputRef.current?.focus();
    }, 100);
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingMessage(undefined);
    setInput("");
  }, []);

  // Validation: check if message can be edited
  const canEditMessage = useCallback(
    (message: DisplayedMessage): boolean => {
      // Cannot edit during streaming
      if (isStreaming) return false;

      // Only user messages can be edited
      if (message.type !== "user") return false;

      return true;
    },
    [isStreaming]
  );

  // Reverse timeline for inverted FlatList (chat messages bottom-to-top)
  const listData = useMemo(() => [...timeline].reverse(), [timeline]);
  const keyExtractor = useCallback((item: TimelineEntry) => item.key, []);

  const handleDismissRawEvent = useCallback((key: string) => {
    setTimeline((current) => current.filter((item) => item.key !== key));
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: TimelineEntry }) => {
      // Check if this is the cutoff message
      const isEditCutoff =
        editingMessage &&
        item.kind === "displayed" &&
        item.message.type !== "history-hidden" &&
        item.message.type !== "workspace-init" &&
        item.message.historyId === editingMessage.id;

      return (
        <>
          <TimelineRow
            item={item}
            spacing={spacing}
            onDismiss={item.kind === "raw" ? () => handleDismissRawEvent(item.key) : undefined}
            workspaceId={workspaceId ?? undefined}
            onStartHere={handleStartHere}
            onEditMessage={handleStartEdit}
            canEditMessage={canEditMessage}
          />

          {/* Cutoff warning banner (inverted list, so appears below the message) */}
          {isEditCutoff && (
            <View
              style={{
                backgroundColor: "#FEF3C7",
                borderBottomWidth: 3,
                borderBottomColor: "#F59E0B",
                paddingVertical: 12,
                paddingHorizontal: 16,
                marginVertical: 16,
                marginHorizontal: spacing.md,
                borderRadius: 8,
              }}
            >
              <ThemedText
                style={{
                  color: "#92400E",
                  fontSize: 12,
                  textAlign: "center",
                  fontWeight: "600",
                }}
              >
                ⚠️ Messages below this line will be removed when you submit the edit
              </ThemedText>
            </View>
          )}
        </>
      );
    },
    [
      spacing,
      handleDismissRawEvent,
      workspaceId,
      handleStartHere,
      handleStartEdit,
      canEditMessage,
      editingMessage,
    ]
  );

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.colors.background }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={80}
    >
      <View style={{ flex: 1 }}>
        {/* Chat area - header bar removed, all actions now in action sheet menu */}
        <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
          {isCreationMode && timeline.length === 0 ? (
            <View
              style={{
                flex: 1,
                justifyContent: "center",
                alignItems: "center",
                padding: spacing.xl,
              }}
            >
              <Ionicons name="chatbubbles-outline" size={48} color={theme.colors.foregroundMuted} />
              <ThemedText
                variant="titleSmall"
                weight="semibold"
                style={{ marginTop: spacing.md, textAlign: "center" }}
              >
                Start a new conversation
              </ThemedText>
              <ThemedText
                variant="caption"
                style={{
                  marginTop: spacing.xs,
                  textAlign: "center",
                  color: theme.colors.foregroundMuted,
                }}
              >
                Type your first message below to create a workspace
              </ThemedText>
            </View>
          ) : metadataQuery.isLoading && timeline.length === 0 ? (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
              <ActivityIndicator color={theme.colors.accent} />
            </View>
          ) : (
            <FlatList
              ref={flatListRef}
              data={listData}
              keyExtractor={keyExtractor}
              renderItem={renderItem}
              inverted
              contentContainerStyle={{ paddingHorizontal: spacing.md, paddingVertical: spacing.sm }}
              initialNumToRender={20}
              maxToRenderPerBatch={12}
              windowSize={5}
              updateCellsBatchingPeriod={32}
              removeClippedSubviews
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
            />
          )}
        </View>

        {/* Floating Todo Card */}
        {currentTodos.length > 0 && todoCardVisible && (
          <FloatingTodoCard todos={currentTodos} onDismiss={toggleTodoCard} />
        )}

        {/* Streaming Indicator */}
        {isStreaming && streamingModel && (
          <View
            style={{
              paddingVertical: spacing.xs,
              paddingHorizontal: spacing.md,
              backgroundColor: theme.colors.surfaceSecondary,
              borderTopWidth: 1,
              borderTopColor: theme.colors.border,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <ThemedText variant="caption" style={{ color: theme.colors.accent }}>
              {streamingModel} streaming...
            </ThemedText>
            {tokenDisplay.total > 0 && (
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                <ThemedText variant="caption" style={{ color: theme.colors.accent }}>
                  ~{tokenDisplay.total.toLocaleString()} tokens
                </ThemedText>
                {tokenDisplay.tps > 0 && (
                  <ThemedText variant="caption" style={{ color: theme.colors.foregroundMuted }}>
                    @ {tokenDisplay.tps} t/s
                  </ThemedText>
                )}
              </View>
            )}
          </View>
        )}

        {/* Input area */}
        <View
          style={{
            paddingHorizontal: spacing.md,
            paddingTop: spacing.sm,
            paddingBottom: Math.max(spacing.sm, insets.bottom),
            backgroundColor: theme.colors.surfaceSecondary,
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
          }}
        >
          {/* Creation banner */}
          {isCreationMode && (
            <View
              style={{
                flexDirection: "column",
                backgroundColor: theme.colors.surfaceElevated,
                paddingVertical: spacing.md,
                paddingHorizontal: spacing.md,
                borderRadius: 8,
                marginBottom: spacing.sm,
              }}
            >
              <ThemedText
                variant="titleSmall"
                weight="semibold"
                style={{ marginBottom: spacing.xs }}
              >
                {creationContext!.projectName}
              </ThemedText>
              <ThemedText variant="caption" style={{ color: theme.colors.foregroundMuted }}>
                Workspace name and branch will be generated automatically
              </ThemedText>
            </View>
          )}

          {/* Editing banner */}
          {editingMessage && (
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
                backgroundColor: "#FFF4E6",
                paddingVertical: spacing.sm,
                paddingHorizontal: spacing.md,
                borderRadius: 8,
                marginBottom: spacing.sm,
              }}
            >
              <ThemedText style={{ color: "#B45309", fontSize: 14, fontWeight: "600" }}>
                ✏️ Editing message
              </ThemedText>
              <Pressable onPress={handleCancelEdit}>
                <ThemedText style={{ color: "#1E40AF", fontSize: 14, fontWeight: "600" }}>
                  Cancel
                </ThemedText>
              </Pressable>
            </View>
          )}

          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <TextInput
              ref={inputRef}
              value={input}
              onChangeText={setInput}
              placeholder={
                isCreationMode
                  ? "Describe what you want to build..."
                  : editingMessage
                    ? "Edit your message..."
                    : "Message"
              }
              placeholderTextColor={theme.colors.foregroundMuted}
              style={{
                flex: 1,
                minHeight: 38,
                maxHeight: 100,
                paddingVertical: spacing.xs,
                paddingHorizontal: spacing.md,
                borderRadius: 20,
                backgroundColor: theme.colors.inputBackground,
                color: theme.colors.foregroundPrimary,
                borderWidth: editingMessage ? 2 : 1,
                borderColor: editingMessage ? "#F59E0B" : theme.colors.inputBorder,
                fontSize: 16,
              }}
              textAlignVertical="center"
              multiline
              autoCorrect={false}
              autoCapitalize="sentences"
            />
            <Pressable
              onPress={isStreaming ? onCancelStream : onSend}
              disabled={!isStreaming && (isSending || !input.trim())}
              style={({ pressed }) => ({
                backgroundColor: isStreaming
                  ? pressed
                    ? theme.colors.accentHover
                    : theme.colors.accent
                  : isSending || !input.trim()
                    ? theme.colors.inputBorder
                    : pressed
                      ? editingMessage
                        ? "#D97706"
                        : theme.colors.accentHover
                      : editingMessage
                        ? "#F59E0B"
                        : theme.colors.accent,
                width: 38,
                height: 38,
                borderRadius: isStreaming ? 8 : 19, // Square when streaming, circle when not
                justifyContent: "center",
                alignItems: "center",
              })}
            >
              {isStreaming ? (
                <Ionicons name="stop" size={20} color={theme.colors.foregroundInverted} />
              ) : editingMessage ? (
                <Ionicons
                  name="checkmark"
                  size={24}
                  color={
                    isSending || !input.trim()
                      ? theme.colors.foregroundMuted
                      : theme.colors.foregroundInverted
                  }
                />
              ) : (
                <Ionicons
                  name="arrow-up"
                  size={24}
                  color={
                    isSending || !input.trim()
                      ? theme.colors.foregroundMuted
                      : theme.colors.foregroundInverted
                  }
                />
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

export function WorkspaceScreen({
  creationContext,
}: {
  creationContext?: { projectPath: string; projectName: string };
} = {}): JSX.Element {
  const theme = useTheme();
  const spacing = theme.spacing;
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();

  // Creation mode: use null workspaceId
  if (creationContext) {
    return <WorkspaceScreenInner workspaceId={null} creationContext={creationContext} />;
  }

  // Normal mode: existing logic
  const workspaceId = params.id ? String(params.id) : "";
  if (!workspaceId) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.colors.background,
          padding: spacing.lg,
        }}
      >
        <ThemedText variant="titleMedium" weight="semibold">
          Workspace not found
        </ThemedText>
        <ThemedText variant="caption" style={{ marginTop: spacing.sm }}>
          Try opening this workspace from the Projects screen.
        </ThemedText>
        <Pressable
          onPress={() => router.back()}
          style={({ pressed }) => ({
            marginTop: spacing.md,
            paddingHorizontal: spacing.lg,
            paddingVertical: spacing.sm,
            borderRadius: theme.radii.sm,
            backgroundColor: pressed ? theme.colors.accentHover : theme.colors.accent,
          })}
        >
          <ThemedText style={{ color: theme.colors.foregroundInverted }} weight="semibold">
            Go back
          </ThemedText>
        </Pressable>
      </View>
    );
  }

  return <WorkspaceScreenInner workspaceId={workspaceId} />;
}

export default WorkspaceScreen;

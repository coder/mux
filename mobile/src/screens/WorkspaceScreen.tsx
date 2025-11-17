import type { JSX } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  TextInput,
  View,
} from "react-native";
import type {
  LayoutChangeEvent,
  TextInputContentSizeChangeEventData,
  TextInputKeyPressEventData,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Picker } from "@react-native-picker/picker";
import { useTheme } from "../theme";
import { ThemedText } from "../components/ThemedText";
import { useApiClient } from "../hooks/useApiClient";
import { useWorkspaceCost } from "../contexts/WorkspaceCostContext";
import type { StreamAbortEvent, StreamEndEvent } from "@/common/types/stream.ts";
import { MessageRenderer } from "../messages/MessageRenderer";
import { useWorkspaceSettings } from "../hooks/useWorkspaceSettings";
import type { ThinkingLevel, WorkspaceMode } from "../types/settings";
import { FloatingTodoCard } from "../components/FloatingTodoCard";
import type { TodoItem } from "../components/TodoItemView";
import type { DisplayedMessage, FrontendWorkspaceMetadata, WorkspaceChatEvent } from "../types";
import { useWorkspaceChat } from "../contexts/WorkspaceChatContext";
import { applyChatEvent, TimelineEntry } from "./chatTimelineReducer";
import type { SlashSuggestion } from "@/browser/utils/slashCommands/types";
import { parseCommand } from "@/browser/utils/slashCommands/parser";
import { useSlashCommandSuggestions } from "../hooks/useSlashCommandSuggestions";
import { ToastBanner, ToastPayload, ToastState } from "../components/ToastBanner";
import { SlashCommandSuggestions } from "../components/SlashCommandSuggestions";
import { executeSlashCommand } from "../utils/slashCommandRunner";
import { createCompactedMessage } from "../utils/messageHelpers";
import type { RuntimeConfig, RuntimeMode } from "@/common/types/runtime";
import { RUNTIME_MODE, parseRuntimeModeAndHost, buildRuntimeString } from "@/common/types/runtime";
import { loadRuntimePreference, saveRuntimePreference } from "../utils/workspacePreferences";
import { FullscreenComposerModal } from "../components/FullscreenComposerModal";

import { RunSettingsSheet } from "../components/RunSettingsSheet";
import { useModelHistory } from "../hooks/useModelHistory";
import { areTodosEqual, extractTodosFromEvent } from "../utils/todoLifecycle";
import {
  assertKnownModelId,
  formatModelSummary,
  getModelDisplayName,
  sanitizeModelSequence,
} from "../utils/modelCatalog";

const CHAT_INPUT_MIN_HEIGHT = 38;
const CHAT_INPUT_MAX_HEIGHT = 120;

if (__DEV__) {
  console.assert(
    CHAT_INPUT_MIN_HEIGHT < CHAT_INPUT_MAX_HEIGHT,
    "Chat composer height bounds invalid"
  );
}

type ThemeSpacing = ReturnType<typeof useTheme>["spacing"];

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
  const { getExpander } = useWorkspaceChat();
  const api = useApiClient();
  const {
    mode,
    thinkingLevel,
    model,
    use1MContext,
    setModel,
    setMode,
    setThinkingLevel,
    setUse1MContext,
    isLoading: settingsLoading,
  } = useWorkspaceSettings(workspaceId ?? "");
  const { recentModels, addRecentModel } = useModelHistory();
  const [isRunSettingsVisible, setRunSettingsVisible] = useState(false);
  const selectedModelEntry = useMemo(() => assertKnownModelId(model), [model]);
  const supportsExtendedContext = selectedModelEntry.provider === "anthropic";
  const modelPickerRecents = useMemo(
    () => sanitizeModelSequence([model, ...recentModels]),
    [model, recentModels]
  );
  const sendMessageOptions = useMemo(
    () => ({
      model,
      mode,
      thinkingLevel,
      providerOptions: {
        anthropic: {
          use1MContext,
        },
      },
    }),
    [model, mode, thinkingLevel, use1MContext]
  );
  const [input, setInput] = useState("");
  const [suppressCommandSuggestions, setSuppressCommandSuggestions] = useState(false);
  const setInputWithSuggestionGuard = useCallback((next: string) => {
    setInput(next);
    setSuppressCommandSuggestions(false);
  }, []);
  const commandListIdRef = useRef(`slash-${Math.random().toString(36).slice(2)}`);
  const [commandHighlightIndex, setCommandHighlightIndex] = useState(0);
  const [toast, setToast] = useState<ToastState | null>(null);
  const showToast = useCallback((payload: ToastPayload) => {
    setToast({
      ...payload,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
  }, []);
  const dismissToast = useCallback(() => {
    setToast(null);
  }, []);
  const showInfoToast = useCallback(
    (title: string, message: string) => {
      showToast({ title, message, tone: "info" });
    },
    [showToast]
  );
  const showErrorToast = useCallback(
    (title: string, message: string) => {
      showToast({ title, message, tone: "error" });
    },
    [showToast]
  );
  const { suggestions: commandSuggestions } = useSlashCommandSuggestions({
    input,
    api,
    enabled: !isCreationMode,
  });
  useEffect(() => {
    if (!toast || toast.tone === "error") {
      return;
    }
    const timer = setTimeout(() => {
      setToast((current) => (current?.id === toast.id ? null : current));
    }, 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    setCommandHighlightIndex((currentIndex) => {
      if (commandSuggestions.length === 0) {
        return 0;
      }
      return Math.min(currentIndex, commandSuggestions.length - 1);
    });
  }, [commandSuggestions]);
  const selectHighlightedCommand = useCallback(
    (suggestion?: SlashSuggestion) => {
      const target = suggestion ?? commandSuggestions[commandHighlightIndex];
      if (!target) {
        return;
      }
      const replacement = target.replacement.endsWith(" ")
        ? target.replacement
        : `${target.replacement} `;
      setInputWithSuggestionGuard(replacement);
    },
    [commandHighlightIndex, commandSuggestions, setInputWithSuggestionGuard]
  );
  const showCommandSuggestions =
    !isCreationMode && !suppressCommandSuggestions && commandSuggestions.length > 0;
  const handleCommandKeyDown = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      if (!showCommandSuggestions || commandSuggestions.length === 0) {
        return;
      }
      const key = event.nativeEvent.key;
      if (key === "ArrowDown") {
        event.preventDefault();
        setCommandHighlightIndex((prev) => (prev + 1) % commandSuggestions.length);
      } else if (key === "ArrowUp") {
        event.preventDefault();
        setCommandHighlightIndex(
          (prev) => (prev - 1 + commandSuggestions.length) % commandSuggestions.length
        );
      } else if (key === "Tab") {
        event.preventDefault();
        selectHighlightedCommand();
      } else if (key === "Escape") {
        event.preventDefault();
        setSuppressCommandSuggestions(true);
      }
    },
    [
      commandSuggestions.length,
      selectHighlightedCommand,
      setSuppressCommandSuggestions,
      showCommandSuggestions,
    ]
  );

  const runSettingsDetails = useMemo(() => {
    const modeLabel = mode === "plan" ? "Plan" : "Exec";
    return `${modeLabel} • ${thinkingLevel.toUpperCase()}`;
  }, [mode, thinkingLevel]);
  const modelSummary = useMemo(() => formatModelSummary(model), [model]);

  // Creation mode: branch selection state
  const [branches, setBranches] = useState<string[]>(creationContext?.branches ?? []);
  const [trunkBranch, setTrunkBranch] = useState<string>(
    creationContext?.defaultTrunk ?? branches[0] ?? "main"
  );

  // Creation mode: advanced options state
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(RUNTIME_MODE.LOCAL);
  const [sshHost, setSshHost] = useState("");

  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [isSending, setIsSending] = useState(false);
  const wsRef = useRef<{ close: () => void } | null>(null);
  const flatListRef = useRef<FlatList<TimelineEntry> | null>(null);
  const inputRef = useRef<TextInput>(null);
  const [composerContentHeight, setComposerContentHeight] = useState(CHAT_INPUT_MIN_HEIGHT);
  const inlineMaxHeight = CHAT_INPUT_MAX_HEIGHT;
  const composerDisplayHeight = useMemo(() => {
    const clampedHeight = Math.max(composerContentHeight, CHAT_INPUT_MIN_HEIGHT);
    return Math.min(clampedHeight, inlineMaxHeight);
  }, [composerContentHeight, inlineMaxHeight]);
  const [isFullscreenComposerOpen, setFullscreenComposerOpen] = useState(false);

  // Editing state - tracks message being edited
  const [editingMessage, setEditingMessage] = useState<{ id: string; content: string } | undefined>(
    undefined
  );
  const handlePlaceholder = useMemo(() => {
    if (isCreationMode) {
      return "Describe what you want to build...";
    }
    if (editingMessage) {
      return "Edit your message...";
    }
    return "Message";
  }, [isCreationMode, editingMessage]);

  // Track current todos

  const handleOpenFullscreenComposer = useCallback(() => {
    setSuppressCommandSuggestions(true);
    setFullscreenComposerOpen(true);
  }, [setFullscreenComposerOpen, setSuppressCommandSuggestions]);

  const handleCloseFullscreenComposer = useCallback(() => {
    setFullscreenComposerOpen(false);
    setSuppressCommandSuggestions(false);
    setTimeout(() => {
      inputRef.current?.focus();
    }, 150);
  }, [setFullscreenComposerOpen, setSuppressCommandSuggestions]);

  // Track current todos for floating card (during streaming)
  const [currentTodos, setCurrentTodos] = useState<TodoItem[]>([]);

  // Track streaming state for indicator
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingModel, setStreamingModel] = useState<string | null>(null);
  const updateComposerContentHeight = useCallback((nextHeight: number) => {
    const clamped = Math.max(nextHeight, CHAT_INPUT_MIN_HEIGHT);
    setComposerContentHeight((current) => (Math.abs(current - clamped) < 0.5 ? current : clamped));
  }, []);
  const streamingModelDisplay = useMemo(
    () => (streamingModel ? getModelDisplayName(streamingModel) : null),
    [streamingModel]
  );

  const handleComposerContentSizeChange = useCallback(
    (event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => {
      updateComposerContentHeight(event.nativeEvent.contentSize?.height ?? CHAT_INPUT_MIN_HEIGHT);
    },
    [updateComposerContentHeight]
  );

  const handleComposerLayout = useCallback(
    (event: LayoutChangeEvent) => {
      updateComposerContentHeight(event.nativeEvent.layout.height);
    },
    [updateComposerContentHeight]
  );

  // Track deltas with timestamps for accurate TPS calculation (60s window like desktop)
  const deltasRef = useRef<Array<{ tokens: number; timestamp: number }>>([]);
  const isStreamActiveRef = useRef(false);
  const hasCaughtUpRef = useRef(false);
  const pendingTodosRef = useRef<TodoItem[] | null>(null);
  const [tokenDisplay, setTokenDisplay] = useState({ total: 0, tps: 0 });

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

  // Load runtime preference in creation mode
  useEffect(() => {
    if (!isCreationMode || !creationContext) return;

    async function loadRuntime() {
      try {
        const saved = await loadRuntimePreference(creationContext!.projectPath);
        if (saved) {
          const parsed = parseRuntimeModeAndHost(saved);
          setRuntimeMode(parsed.mode);
          setSshHost(parsed.host);
        }
      } catch (error) {
        console.error("Failed to load runtime preference:", error);
        // Keep defaults (local)
      }
    }
    void loadRuntime();
  }, [isCreationMode, creationContext]);

  useEffect(() => {
    if (input.trim().length === 0) {
      setComposerContentHeight(CHAT_INPUT_MIN_HEIGHT);
    }
  }, [input]);

  const metadataQuery = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => api.workspace.getInfo(workspaceId!),
    staleTime: 15_000,
    enabled: !isCreationMode && !!workspaceId,
  });

  const metadata = metadataQuery.data ?? null;

  useEffect(() => {
    // Skip WebSocket subscription in creation mode (no workspace yet)
    if (isCreationMode) return;

    isStreamActiveRef.current = false;
    hasCaughtUpRef.current = false;
    pendingTodosRef.current = null;

    // Get persistent expander for this workspace (survives navigation)
    const expander = getExpander(workspaceId!);
    const subscription = api.workspace.subscribeChat(workspaceId!, (payload) => {
      // Track streaming state and tokens (60s trailing window like desktop)
      if (payload && typeof payload === "object" && "type" in payload) {
        if (payload.type === "caught-up") {
          const alreadyCaughtUp = hasCaughtUpRef.current;
          hasCaughtUpRef.current = true;

          if (
            pendingTodosRef.current &&
            pendingTodosRef.current.length > 0 &&
            isStreamActiveRef.current
          ) {
            const pending = pendingTodosRef.current;
            setCurrentTodos((prev) => (areTodosEqual(prev, pending) ? prev : pending));
          } else if (!isStreamActiveRef.current) {
            setCurrentTodos([]);
          }

          pendingTodosRef.current = null;

          if (__DEV__ && !alreadyCaughtUp) {
            console.debug(`[WorkspaceScreen] caught up for workspace ${workspaceId}`);
          }
          return;
        }

        const typedEvent = payload as StreamEndEvent | StreamAbortEvent | { type: string };
        if (typedEvent.type === "stream-end" || typedEvent.type === "stream-abort") {
          recordStreamUsage(typedEvent as StreamEndEvent | StreamAbortEvent);
        }

        if (payload.type === "stream-start" && "model" in payload) {
          setIsStreaming(true);
          setStreamingModel(typeof payload.model === "string" ? payload.model : null);
          deltasRef.current = [];
          setTokenDisplay({ total: 0, tps: 0 });
          isStreamActiveRef.current = true;
          pendingTodosRef.current = null;
          setCurrentTodos([]);
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
          isStreamActiveRef.current = false;
          pendingTodosRef.current = null;
          setCurrentTodos([]);
        }
      }

      const expanded = expander.expand(payload);

      let latestTodos: TodoItem[] | null = null;
      for (const event of expanded) {
        const todos = extractTodosFromEvent(event);
        if (todos) {
          latestTodos = todos;
        }
      }

      if (latestTodos) {
        if (hasCaughtUpRef.current) {
          setCurrentTodos((prev) => (areTodosEqual(prev, latestTodos) ? prev : latestTodos));
        } else {
          pendingTodosRef.current = latestTodos;
        }
      }

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
  }, [api, workspaceId, isCreationMode, recordStreamUsage, getExpander]);

  // Reset timeline, todos, and editing state when workspace changes
  useEffect(() => {
    setTimeline([]);
    setCurrentTodos([]);
    setEditingMessage(undefined);
    setInputWithSuggestionGuard("");
    isStreamActiveRef.current = false;
    hasCaughtUpRef.current = false;
    pendingTodosRef.current = null;
  }, [workspaceId, setInputWithSuggestionGuard]);

  const handleOpenRunSettings = useCallback(() => {
    if (settingsLoading) {
      return;
    }
    setRunSettingsVisible(true);
  }, [settingsLoading]);

  const handleCloseRunSettings = useCallback(() => {
    setRunSettingsVisible(false);
  }, []);

  const handleSelectModel = useCallback(
    async (modelId: string) => {
      if (modelId === model) {
        return;
      }
      try {
        await setModel(modelId);
        addRecentModel(modelId);
      } catch (error) {
        if (process.env.NODE_ENV !== "production") {
          console.error("Failed to update model", error);
        }
      }
    },
    [model, setModel, addRecentModel]
  );

  const handleSelectMode = useCallback(
    (nextMode: WorkspaceMode) => {
      if (nextMode === mode) {
        return;
      }
      void setMode(nextMode);
    },
    [mode, setMode]
  );

  const handleSelectThinkingLevel = useCallback(
    (level: ThinkingLevel) => {
      if (level === thinkingLevel) {
        return;
      }
      void setThinkingLevel(level);
    },
    [thinkingLevel, setThinkingLevel]
  );

  const handleToggle1MContext = useCallback(() => {
    if (!supportsExtendedContext) {
      return;
    }
    void setUse1MContext(!use1MContext);
  }, [supportsExtendedContext, use1MContext, setUse1MContext]);

  const handleCancelEdit = useCallback(() => {
    setEditingMessage(undefined);
    setInputWithSuggestionGuard("");
    setSuppressCommandSuggestions(false);
  }, [setEditingMessage, setInputWithSuggestionGuard, setSuppressCommandSuggestions]);

  const onSend = useCallback(async (): Promise<boolean> => {
    const trimmed = input.trim();
    const parsedCommand = parseCommand(trimmed);

    if (!isCreationMode && parsedCommand) {
      const handled = await executeSlashCommand(parsedCommand, {
        api,
        workspaceId,
        metadata,
        sendMessageOptions,
        editingMessageId: editingMessage?.id,
        onClearTimeline: () => setTimeline([]),
        onCancelEdit: handleCancelEdit,
        onNavigateToWorkspace: (nextWorkspaceId) => {
          router.replace(`/workspace/${nextWorkspaceId}`);
        },
        onSelectModel: async (modelId) => {
          await handleSelectModel(modelId);
        },
        showInfo: showInfoToast,
        showError: showErrorToast,
      });

      if (handled) {
        setIsSending(false);
        setSuppressCommandSuggestions(true);
        setInputWithSuggestionGuard("");
        return true;
      }
    }

    if (!trimmed) {
      return false;
    }

    const wasEditing = !!editingMessage;
    const originalContent = input;

    setInputWithSuggestionGuard("");
    setIsSending(true);
    setSuppressCommandSuggestions(true);

    if (isCreationMode) {
      const runtimeConfig: RuntimeConfig | undefined =
        runtimeMode === RUNTIME_MODE.SSH
          ? { type: "ssh" as const, host: sshHost, srcBaseDir: "~/mux" }
          : undefined;

      const result = await api.workspace.sendMessage(null, trimmed, {
        ...sendMessageOptions,
        projectPath: creationContext!.projectPath,
        trunkBranch,
        runtimeConfig,
      });

      if (!result.success) {
        console.error("[createWorkspace] Failed:", result.error);
        setTimeline((current) =>
          applyChatEvent(current, { type: "error", error: result.error } as WorkspaceChatEvent)
        );
        setInputWithSuggestionGuard(originalContent);
        setIsSending(false);
        return false;
      }

      if ("metadata" in result && result.metadata) {
        if (runtimeMode !== RUNTIME_MODE.LOCAL) {
          const runtimeString = buildRuntimeString(runtimeMode, sshHost);
          if (runtimeString) {
            await saveRuntimePreference(creationContext!.projectPath, runtimeString);
          }
        }

        router.replace(`/workspace/${result.metadata.id}`);
      }

      setIsSending(false);
      return true;
    }

    const result = await api.workspace.sendMessage(workspaceId!, trimmed, {
      ...sendMessageOptions,
      editMessageId: editingMessage?.id,
    });

    if (!result.success) {
      console.error("[sendMessage] Validation failed:", result.error);
      setTimeline((current) =>
        applyChatEvent(current, { type: "error", error: result.error } as WorkspaceChatEvent)
      );

      if (wasEditing) {
        setEditingMessage(editingMessage);
        setInputWithSuggestionGuard(originalContent);
      }

      setIsSending(false);
      return false;
    }

    if (wasEditing) {
      setEditingMessage(undefined);
    }

    setIsSending(false);
    return true;
  }, [
    api,
    creationContext,
    editingMessage,
    handleCancelEdit,
    handleSelectModel,
    input,
    isCreationMode,
    metadata,
    model,
    mode,
    router,
    runtimeMode,
    sendMessageOptions,
    setEditingMessage,
    setInputWithSuggestionGuard,
    setIsSending,
    setSuppressCommandSuggestions,
    setTimeline,
    showErrorToast,
    showInfoToast,
    sshHost,
    thinkingLevel,
    trunkBranch,
    use1MContext,
    workspaceId,
  ]);

  const handleFullscreenSend = useCallback(async () => {
    const sent = await onSend();
    if (sent) {
      setFullscreenComposerOpen(false);
    }
    return sent;
  }, [onSend, setFullscreenComposerOpen]);

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
    setInputWithSuggestionGuard(content);
    // Focus input after a short delay to ensure keyboard opens
    setTimeout(() => {
      inputRef.current?.focus();
    }, 100);
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
    <>
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
                <Ionicons
                  name="chatbubbles-outline"
                  size={48}
                  color={theme.colors.foregroundMuted}
                />
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
                contentContainerStyle={{
                  paddingHorizontal: spacing.md,
                  paddingVertical: spacing.sm,
                }}
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
          {currentTodos.length > 0 && <FloatingTodoCard todos={currentTodos} />}

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
                {streamingModelDisplay ?? streamingModel ?? ""} streaming...
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

                {/* Advanced Options Toggle */}
                <Pressable
                  onPress={() => setShowAdvanced(!showAdvanced)}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: spacing.xs,
                    marginTop: spacing.sm,
                    paddingVertical: spacing.xs,
                  }}
                >
                  <Ionicons
                    name="settings-outline"
                    size={14}
                    color={theme.colors.foregroundMuted}
                  />
                  <ThemedText
                    variant="caption"
                    style={{ color: theme.colors.foregroundMuted, flex: 1 }}
                  >
                    Advanced Options
                  </ThemedText>
                  <Ionicons
                    name={showAdvanced ? "chevron-down" : "chevron-forward"}
                    size={14}
                    color={theme.colors.foregroundMuted}
                  />
                </Pressable>

                {/* Expandable Options */}
                {showAdvanced && (
                  <View style={{ marginTop: spacing.md, gap: spacing.md }}>
                    {/* Trunk Branch Picker */}
                    <View>
                      <ThemedText
                        variant="caption"
                        style={{ marginBottom: spacing.xs, color: theme.colors.foregroundMuted }}
                      >
                        Base Branch
                      </ThemedText>
                      <View
                        style={{
                          borderWidth: 1,
                          borderColor: theme.colors.inputBorder,
                          borderRadius: theme.radii.sm,
                          backgroundColor: theme.colors.inputBackground,
                        }}
                      >
                        <Picker
                          selectedValue={trunkBranch}
                          onValueChange={(value) => setTrunkBranch(value)}
                          style={{ color: theme.colors.foregroundPrimary }}
                          dropdownIconColor={theme.colors.foregroundPrimary}
                        >
                          {branches.map((branch) => (
                            <Picker.Item
                              key={branch}
                              label={branch}
                              value={branch}
                              color={theme.colors.foregroundPrimary}
                            />
                          ))}
                        </Picker>
                      </View>
                    </View>

                    {/* Runtime Picker */}
                    <View>
                      <ThemedText
                        variant="caption"
                        style={{ marginBottom: spacing.xs, color: theme.colors.foregroundMuted }}
                      >
                        Runtime
                      </ThemedText>
                      <View
                        style={{
                          borderWidth: 1,
                          borderColor: theme.colors.inputBorder,
                          borderRadius: theme.radii.sm,
                          backgroundColor: theme.colors.inputBackground,
                        }}
                      >
                        <Picker
                          selectedValue={runtimeMode}
                          onValueChange={(value) => setRuntimeMode(value as RuntimeMode)}
                          style={{ color: theme.colors.foregroundPrimary }}
                          dropdownIconColor={theme.colors.foregroundPrimary}
                        >
                          <Picker.Item
                            label="Local"
                            value={RUNTIME_MODE.LOCAL}
                            color={theme.colors.foregroundPrimary}
                          />
                          <Picker.Item
                            label="SSH Remote"
                            value={RUNTIME_MODE.SSH}
                            color={theme.colors.foregroundPrimary}
                          />
                        </Picker>
                      </View>
                    </View>

                    {/* SSH Host Input (conditional) */}
                    {runtimeMode === RUNTIME_MODE.SSH && (
                      <View>
                        <ThemedText
                          variant="caption"
                          style={{ marginBottom: spacing.xs, color: theme.colors.foregroundMuted }}
                        >
                          SSH Host
                        </ThemedText>
                        <TextInput
                          value={sshHost}
                          onChangeText={setSshHost}
                          placeholder="user@hostname"
                          placeholderTextColor={theme.colors.foregroundMuted}
                          style={{
                            borderWidth: 1,
                            borderColor: theme.colors.inputBorder,
                            borderRadius: theme.radii.sm,
                            backgroundColor: theme.colors.inputBackground,
                            color: theme.colors.foregroundPrimary,
                            paddingHorizontal: spacing.md,
                            paddingVertical: spacing.sm,
                            fontSize: 14,
                          }}
                        />
                      </View>
                    )}
                  </View>
                )}
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

            <View style={{ position: "relative", marginBottom: spacing.sm }}>
              {toast && (
                <View
                  pointerEvents="box-none"
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    bottom: "100%",
                    marginBottom: spacing.lg,
                    zIndex: 10,
                  }}
                >
                  <ToastBanner toast={toast} onDismiss={dismissToast} />
                </View>
              )}
              <Pressable
                onPress={handleOpenRunSettings}
                disabled={settingsLoading}
                style={({ pressed }) => [
                  {
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    paddingVertical: spacing.xs,
                    paddingHorizontal: spacing.md,
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                    backgroundColor: theme.colors.surface,
                  },
                  pressed && !settingsLoading
                    ? { backgroundColor: theme.colors.surfaceSecondary }
                    : null,
                  settingsLoading ? { opacity: 0.6 } : null,
                ]}
              >
                <View style={{ flex: 1 }}>
                  <ThemedText weight="semibold">{modelSummary}</ThemedText>
                  <ThemedText
                    variant="caption"
                    style={{ color: theme.colors.foregroundMuted, marginTop: 2 }}
                  >
                    {runSettingsDetails}
                  </ThemedText>
                </View>
                <Ionicons name="chevron-up" size={16} color={theme.colors.foregroundPrimary} />
              </Pressable>
            </View>

            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
              <View style={{ flex: 1, position: "relative" }}>
                {showCommandSuggestions && (
                  <SlashCommandSuggestions
                    suggestions={commandSuggestions}
                    visible
                    highlightedIndex={commandHighlightIndex}
                    listId={commandListIdRef.current}
                    onSelect={(suggestion) => {
                      selectHighlightedCommand(suggestion);
                      inputRef.current?.focus();
                    }}
                    onHighlight={setCommandHighlightIndex}
                  />
                )}
                <TextInput
                  ref={inputRef}
                  value={input}
                  onChangeText={setInputWithSuggestionGuard}
                  onKeyPress={handleCommandKeyDown}
                  placeholder={handlePlaceholder}
                  placeholderTextColor={theme.colors.foregroundMuted}
                  style={{
                    flex: 1,
                    paddingVertical: spacing.xs,
                    paddingHorizontal: spacing.md,
                    borderRadius: 20,
                    backgroundColor: theme.colors.inputBackground,
                    color: theme.colors.foregroundPrimary,
                    borderWidth: editingMessage ? 2 : 1,
                    borderColor: editingMessage ? "#F59E0B" : theme.colors.inputBorder,
                    fontSize: 16,
                    height: composerDisplayHeight,
                    minHeight: CHAT_INPUT_MIN_HEIGHT,
                    maxHeight: inlineMaxHeight,
                  }}
                  textAlignVertical="top"
                  multiline
                  onContentSizeChange={handleComposerContentSizeChange}
                  onLayout={handleComposerLayout}
                  autoCorrect={false}
                  autoCapitalize="sentences"
                  onFocus={() => setSuppressCommandSuggestions(false)}
                />
              </View>
              <Pressable
                onPress={handleOpenFullscreenComposer}
                accessibilityRole="button"
                accessibilityLabel="Open fullscreen composer"
                onFocus={() => setSuppressCommandSuggestions(true)}
                style={({ pressed }) => ({
                  backgroundColor: pressed ? theme.colors.surfaceSecondary : theme.colors.surface,
                  width: 38,
                  height: 38,
                  borderRadius: 19,
                  borderWidth: 1,
                  borderColor: theme.colors.inputBorder,
                  justifyContent: "center",
                  alignItems: "center",
                })}
              >
                <Ionicons name="open-outline" size={20} color={theme.colors.foregroundPrimary} />
              </Pressable>

              <Pressable
                onPress={isStreaming ? onCancelStream : onSend}
                disabled={!isStreaming && (isSending || !input.trim())}
                onFocus={() => setSuppressCommandSuggestions(true)}
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
      <RunSettingsSheet
        visible={isRunSettingsVisible}
        onClose={handleCloseRunSettings}
        selectedModel={model}
        onSelectModel={handleSelectModel}
        recentModels={modelPickerRecents}
        mode={mode}
        onSelectMode={handleSelectMode}
        thinkingLevel={thinkingLevel}
        onSelectThinkingLevel={handleSelectThinkingLevel}
        use1MContext={use1MContext}
        onToggle1MContext={handleToggle1MContext}
        supportsExtendedContext={supportsExtendedContext}
      />
      <FullscreenComposerModal
        visible={isFullscreenComposerOpen}
        value={input}
        placeholder={handlePlaceholder}
        isEditing={!!editingMessage}
        isSending={isSending}
        onChangeText={setInputWithSuggestionGuard}
        onClose={handleCloseFullscreenComposer}
        onSend={handleFullscreenSend}
      />
    </>
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

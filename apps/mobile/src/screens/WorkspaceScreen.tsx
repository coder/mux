import type { JSX } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
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
import { IconButton } from "../components/IconButton";
import { useApiClient } from "../hooks/useApiClient";
import { MessageRenderer } from "../messages/MessageRenderer";
import { useWorkspaceDefaults, type WorkspaceMode } from "../hooks/useWorkspaceDefaults";
import { createChatEventExpander, DISPLAYABLE_MESSAGE_TYPES } from "../messages/normalizeChatEvent";
import type { DisplayedMessage, FrontendWorkspaceMetadata, WorkspaceChatEvent } from "../types";
import type { Result } from "../api/client";
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
    const entry: TimelineEntry = {
      kind: "displayed",
      key: `displayed-${event.id}`,
      message: event,
    };
    const withoutExisting = current.filter(
      (item) => item.kind !== "displayed" || item.message.id !== event.id
    );
    const displayed = withoutExisting
      .filter((item): item is Extract<TimelineEntry, { kind: "displayed" }> => item.kind === "displayed")
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
    ((event as { type: unknown }).type === "caught-up" || (event as { type: unknown }).type === "stream-start")
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

function RawEventCard({ payload }: { payload: WorkspaceChatEvent }): JSX.Element {
  if (payload && typeof payload === "object" && "type" in payload) {
    const typed = payload as { type: unknown; [key: string]: unknown };
    if (typed.type === "status" && typeof typed.status === "string") {
      return <ThemedText variant="caption">{typed.status}</ThemedText>;
    }
    if (typed.type === "error" && typeof typed.error === "string") {
      return <ThemedText variant="muted">⚠️ {typed.error}</ThemedText>;
    }
  }
  if (typeof payload === "string") {
    return <ThemedText>{payload}</ThemedText>;
  }
  return <ThemedText variant="caption">{JSON.stringify(payload, null, 2)}</ThemedText>;
}

const TimelineRow = memo(
  ({ item, spacing }: { item: TimelineEntry; spacing: ThemeSpacing }) => {
    if (item.kind === "displayed") {
      return <MessageRenderer message={item.message} />;
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
        <RawEventCard payload={item.payload} />
      </View>
    );
  },
  (prev, next) => prev.item === next.item && prev.spacing === next.spacing
);

TimelineRow.displayName = "TimelineRow";

interface WorkspaceScreenInnerProps {
  workspaceId: string;
}

function WorkspaceScreenInner({ workspaceId }: WorkspaceScreenInnerProps): JSX.Element {
  const theme = useTheme();
  const spacing = theme.spacing;
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const expanderRef = useRef(createChatEventExpander());
  const api = useApiClient();
  const { defaultMode, defaultReasoningLevel } = useWorkspaceDefaults();
  const [mode] = useState<WorkspaceMode>(defaultMode);
  const [input, setInput] = useState("");
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [isSending, setIsSending] = useState(false);
  const wsRef = useRef<{ close: () => void } | null>(null);

  useEffect(() => {
    expanderRef.current = createChatEventExpander();
  }, [workspaceId]);

  const metadataQuery = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => api.workspace.getInfo(workspaceId),
    staleTime: 15_000,
  });

  useEffect(() => {
    const expander = expanderRef.current;
    const subscription = api.workspace.subscribeChat(workspaceId, (payload) => {
      const expanded = expander.expand(payload);
      
      // If expander returns [], it means the event was handled but nothing to display yet
      // (e.g., streaming deltas accumulating). Do NOT fall back to raw display.
      if (expanded.length === 0) {
        return;
      }

      setTimeline((current) => {
        let next = current;
        for (const event of expanded) {
          next = applyChatEvent(next, event);
        }
        return next;
      });
    });
    wsRef.current = subscription;
    return () => {
      subscription.close();
      wsRef.current = null;
    };
  }, [api, workspaceId]);

  const metadata = metadataQuery.data ?? null;
  const title = formatProjectBreadcrumb(metadata);

  const onSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed) {
      return;
    }
    setIsSending(true);
    const result: Result<void, string> = await api.workspace.sendMessage(workspaceId, trimmed, {
      model: "default",
      mode: defaultMode,
      thinkingLevel: defaultReasoningLevel,
    });
    if (!result.success) {
      setTimeline((current) =>
        applyChatEvent(current, { type: "error", error: result.error } as WorkspaceChatEvent)
      );
    }
    setIsSending(false);
    setInput("");
  }, [api, input, defaultMode, defaultReasoningLevel, workspaceId]);

  const listData = useMemo(() => timeline, [timeline]);
  const keyExtractor = useCallback((item: TimelineEntry) => item.key, []);

  const renderItem = useCallback(
    ({ item }: { item: TimelineEntry }) => <TimelineRow item={item} spacing={spacing} />,
    [spacing]
  );

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.colors.background }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={80}
    >
      <View style={{ flex: 1 }}>
        {/* Header */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.sm,
            backgroundColor: theme.colors.surfaceSecondary,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.border,
          }}
        >
          <ThemedText variant="titleSmall" weight="semibold" numberOfLines={1} style={{ flex: 1 }}>
            {metadata ? `${metadata.projectName} › ${metadata.name}` : "Loading..."}
          </ThemedText>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
            <IconButton
              icon={<Ionicons name="terminal-outline" size={22} color={theme.colors.foregroundPrimary} />}
              accessibilityLabel="Open terminal"
              variant="ghost"
              onPress={() => {
                setTimeline((current) =>
                  applyChatEvent(current, {
                    type: "status",
                    status: "Terminal action not yet implemented",
                  } as WorkspaceChatEvent)
                );
              }}
            />
            <IconButton
              icon={<Ionicons name="key-outline" size={22} color={theme.colors.foregroundPrimary} />}
              accessibilityLabel="Manage secrets"
              variant="ghost"
              onPress={() => {
                setTimeline((current) =>
                  applyChatEvent(current, {
                    type: "status",
                    status: "Secrets management coming soon",
                  } as WorkspaceChatEvent)
                );
              }}
            />
            <IconButton
              icon={<Ionicons name="settings-outline" size={22} color={theme.colors.foregroundPrimary} />}
              accessibilityLabel="Open settings"
              variant="ghost"
              onPress={() => router.push("/settings")}
            />
          </View>
        </View>

        {/* Chat area */}
        <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
          {metadataQuery.isLoading && timeline.length === 0 ? (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
              <ActivityIndicator color={theme.colors.accent} />
            </View>
          ) : (
            <FlatList
              data={listData}
              keyExtractor={keyExtractor}
              renderItem={renderItem}
              contentContainerStyle={{ paddingHorizontal: spacing.md, paddingVertical: spacing.sm }}
              initialNumToRender={20}
              maxToRenderPerBatch={12}
              windowSize={5}
              updateCellsBatchingPeriod={32}
              removeClippedSubviews
              keyboardShouldPersistTaps="handled"
            />
          )}
        </View>

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
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: spacing.sm }}>
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder="Message"
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
                borderWidth: 1,
                borderColor: theme.colors.inputBorder,
                fontSize: 16,
              }}
              multiline
              autoCorrect={false}
              autoCapitalize="sentences"
            />
            <Pressable
              onPress={onSend}
              disabled={isSending || !input.trim()}
              style={({ pressed }) => ({
                backgroundColor:
                  isSending || !input.trim()
                    ? theme.colors.inputBorder
                    : pressed
                      ? theme.colors.accentHover
                      : theme.colors.accent,
                width: 38,
                height: 38,
                borderRadius: 19,
                justifyContent: "center",
                alignItems: "center",
              })}
            >
              <Ionicons
                name="arrow-up"
                size={24}
                color={
                  isSending || !input.trim()
                    ? theme.colors.foregroundMuted
                    : theme.colors.foregroundInverted
                }
              />
            </Pressable>
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

export function WorkspaceScreen(): JSX.Element {
  const theme = useTheme();
  const spacing = theme.spacing;
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
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

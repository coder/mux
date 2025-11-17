import type { JSX } from "react";
import {
  Image,
  View,
  StyleSheet,
  ScrollView,
  Text,
  Pressable,
  Animated,
  ActionSheetIOS,
  Platform,
  Modal,
  TouchableOpacity,
  Keyboard,
} from "react-native";
import { useMemo, useState, useEffect, useRef, useCallback } from "react";
import * as Clipboard from "expo-clipboard";
import { MarkdownMessageBody } from "../components/MarkdownMessageBody";
import { hasRenderableMarkdown } from "./markdownUtils";
import { Ionicons } from "@expo/vector-icons";
import { Surface } from "../components/Surface";
import { ThemedText } from "../components/ThemedText";
import { ProposePlanCard } from "../components/ProposePlanCard";
import { TodoToolCard } from "../components/TodoToolCard";
import { StatusSetToolCard } from "../components/StatusSetToolCard";
import type { TodoItem } from "../components/TodoItemView";
import { useTheme } from "../theme";
import type { DisplayedMessage } from "../types";
import { assert } from "../utils/assert";
import { MessageBubble, type MessageBubbleButtonConfig } from "./MessageBubble";
import { renderSpecializedToolCard, type ToolCardViewModel } from "./tools/toolRenderers";
import { getModelDisplayName } from "../utils/modelCatalog";
import * as Haptics from "expo-haptics";

/**
 * Streaming cursor component - pulsing animation
 */
function StreamingCursor(): JSX.Element {
  const theme = useTheme();
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.3,
          duration: 530,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 530,
          useNativeDriver: true,
        }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, [opacity]);

  return (
    <Animated.View
      style={{
        width: 2,
        height: 16,
        backgroundColor: theme.colors.accent,
        marginLeft: 2,
        opacity,
      }}
    />
  );
}

export interface MessageRendererProps {
  message: DisplayedMessage;
  workspaceId?: string;
  onStartHere?: (content: string) => Promise<void>;
  onEditMessage?: (messageId: string, content: string) => void;
  canEdit?: boolean;
}

export function MessageRenderer({
  message,
  workspaceId,
  onStartHere,
  onEditMessage,
  canEdit,
}: MessageRendererProps): JSX.Element | null {
  switch (message.type) {
    case "assistant":
      return (
        <AssistantMessageCard
          message={message}
          workspaceId={workspaceId}
          onStartHere={onStartHere}
        />
      );
    case "user":
      return <UserMessageCard message={message} onEditMessage={onEditMessage} canEdit={canEdit} />;
    case "reasoning":
      return <ReasoningMessageCard message={message} />;
    case "stream-error":
      return <StreamErrorMessageCard message={message} />;
    case "history-hidden":
      return <HistoryHiddenMessageCard message={message} />;
    case "workspace-init":
      return <WorkspaceInitMessageCard message={message} />;
    case "tool":
      return (
        <ToolMessageCard message={message} workspaceId={workspaceId} onStartHere={onStartHere} />
      );
    default:
      // Exhaustiveness check
      assert(false, `Unsupported message type: ${(message as DisplayedMessage).type}`);
      return null;
  }
}

function AssistantMessageCard({
  message,
  onStartHere,
}: {
  message: DisplayedMessage & { type: "assistant" };
  workspaceId?: string;
  onStartHere?: (content: string) => Promise<void>;
}): JSX.Element {
  const theme = useTheme();
  const [menuVisible, setMenuVisible] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isStartingHere, setIsStartingHere] = useState(false);
  const isStreaming = message.isStreaming === true;

  const handlePress = () => {
    Keyboard.dismiss();
  };

  const handleLongPress = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ["Copy Message", "Cancel"],
          cancelButtonIndex: 1,
        },
        async (buttonIndex) => {
          if (buttonIndex === 0) {
            await handleCopy();
          }
        }
      );
    } else {
      setMenuVisible(true);
    }
  };

  const handleCopy = useCallback(async () => {
    if (!message.content) {
      return;
    }
    setMenuVisible(false);
    await Clipboard.setStringAsync(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [message.content]);

  const handleStartHere = useCallback(async () => {
    if (!onStartHere || !message.content || isStartingHere) {
      return;
    }
    setIsStartingHere(true);
    try {
      await onStartHere(message.content);
    } finally {
      setIsStartingHere(false);
    }
  }, [isStartingHere, message.content, onStartHere]);

  // Determine if stream is actually complete:
  // We're complete if EITHER:
  // 1. isStreaming is explicitly false (proper signal)
  // 2. We're not the last part AND not partial (stream has moved past us)
  // 3. We're not streaming AND we're the last part AND not partial (completed final message)
  const isComplete =
    !isStreaming ||
    (!message.isLastPartOfMessage && !message.isPartial) ||
    (!isStreaming && message.isLastPartOfMessage && !message.isPartial);

  const buttons: MessageBubbleButtonConfig[] = [];

  if (isComplete && message.content) {
    buttons.push({
      label: copied ? "Copied" : "Copy",
      onPress: handleCopy,
    });
  }

  if (isComplete && onStartHere && message.content) {
    buttons.push({
      label: isStartingHere ? "Starting…" : "Start Here",
      onPress: handleStartHere,
      disabled: isStartingHere,
    });
  }

  if (isComplete) {
    buttons.push({
      label: showRaw ? "Show Markdown" : "Show Text",
      onPress: () => setShowRaw((prev) => !prev),
      active: showRaw,
    });
  }

  const label = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.xs }}>
      <ModelBadge modelId={message.model} />
      {message.isCompacted ? <CompactedBadge /> : null}
    </View>
  );

  const renderContent = () => {
    if (!message.content) {
      return <ThemedText variant="muted">(No content)</ThemedText>;
    }

    if (showRaw) {
      return (
        <ScrollView
          style={{ maxHeight: 320 }}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingRight: theme.spacing.xs }}
        >
          <Text
            style={{
              fontFamily: theme.typography.familyMono,
              fontSize: 12,
              color: theme.colors.foregroundPrimary,
            }}
          >
            {message.content}
          </Text>
        </ScrollView>
      );
    }

    return (
      <View style={{ flexDirection: "row", alignItems: "flex-end" }}>
        <View style={{ flex: 1 }}>
          <MarkdownMessageBody variant="assistant" content={message.content} />
        </View>
        {!isComplete && <StreamingCursor />}
      </View>
    );
  };

  return (
    <Pressable onPress={handlePress} onLongPress={handleLongPress} delayLongPress={500}>
      <MessageBubble message={message} label={label} variant="assistant" buttons={buttons}>
        {renderContent()}
      </MessageBubble>

      {Platform.OS === "android" && (
        <Modal
          visible={menuVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setMenuVisible(false)}
        >
          <Pressable
            style={{
              flex: 1,
              backgroundColor: "rgba(0, 0, 0, 0.5)",
              justifyContent: "flex-end",
            }}
            onPress={() => setMenuVisible(false)}
          >
            <View
              style={{
                backgroundColor: theme.colors.surfaceElevated,
                borderTopLeftRadius: theme.radii.lg,
                borderTopRightRadius: theme.radii.lg,
                paddingBottom: theme.spacing.xl,
              }}
            >
              <Pressable
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: theme.spacing.md,
                  padding: theme.spacing.md,
                }}
                onPress={handleCopy}
              >
                <ThemedText>📋 Copy Message</ThemedText>
              </Pressable>
            </View>
          </Pressable>
        </Modal>
      )}
    </Pressable>
  );
}

function UserMessageCard({
  message,
  onEditMessage,
  canEdit,
}: {
  message: DisplayedMessage & { type: "user" };
  onEditMessage?: (messageId: string, content: string) => void;
  canEdit?: boolean;
}): JSX.Element {
  const theme = useTheme();
  const [menuVisible, setMenuVisible] = useState(false);
  const [copied, setCopied] = useState(false);

  const handlePress = () => {
    Keyboard.dismiss();
  };

  const handleLongPress = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    if (Platform.OS === "ios") {
      const options = ["Copy Message"];
      if (canEdit && onEditMessage) {
        options.unshift("Edit Message");
      }
      options.push("Cancel");

      const cancelButtonIndex = options.length - 1;

      ActionSheetIOS.showActionSheetWithOptions(
        {
          options,
          cancelButtonIndex,
        },
        async (buttonIndex) => {
          if (canEdit && onEditMessage && buttonIndex === 0) {
            handleEdit();
          } else if (buttonIndex === (canEdit && onEditMessage ? 1 : 0)) {
            await handleCopy();
          }
        }
      );
    } else {
      setMenuVisible(true);
    }
  };

  const handleEdit = useCallback(() => {
    setMenuVisible(false);
    if (onEditMessage) {
      onEditMessage(message.historyId, message.content);
    }
  }, [message.content, message.historyId, onEditMessage]);

  const handleCopy = useCallback(async () => {
    setMenuVisible(false);
    if (!message.content) {
      return;
    }
    await Clipboard.setStringAsync(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [message.content]);

  const LOCAL_STDOUT_PREFIX = "<local-command-stdout>";
  const LOCAL_STDOUT_SUFFIX = "</local-command-stdout>";
  const isLocalCommandOutput =
    typeof message.content === "string" &&
    message.content.startsWith(LOCAL_STDOUT_PREFIX) &&
    message.content.endsWith(LOCAL_STDOUT_SUFFIX);
  const extractedOutput = isLocalCommandOutput
    ? message.content.slice(LOCAL_STDOUT_PREFIX.length, -LOCAL_STDOUT_SUFFIX.length).trim()
    : undefined;

  const buttons: MessageBubbleButtonConfig[] = [];
  if (canEdit && onEditMessage) {
    buttons.push({ label: "Edit", onPress: handleEdit });
  }
  buttons.push({ label: copied ? "Copied" : "Copy", onPress: handleCopy });

  const renderAttachments = () => {
    if (!message.imageParts || message.imageParts.length === 0) {
      return null;
    }

    return (
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          marginTop: theme.spacing.md,
        }}
      >
        {message.imageParts.map((image, index) => (
          <Image
            key={`${message.id}-image-${index}`}
            source={{ uri: image.url }}
            style={{
              width: 160,
              height: 120,
              borderRadius: theme.radii.sm,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surfaceSunken,
              marginRight: theme.spacing.sm,
              marginBottom: theme.spacing.sm,
            }}
            resizeMode="cover"
          />
        ))}
      </View>
    );
  };

  const renderContent = () => {
    if (isLocalCommandOutput && extractedOutput) {
      return (
        <View
          style={{
            marginTop: theme.spacing.sm,
            borderRadius: theme.radii.sm,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surfaceSunken,
            padding: theme.spacing.sm,
          }}
        >
          <ScrollView horizontal={false} showsVerticalScrollIndicator={false}>
            <Text
              style={{
                fontFamily: theme.typography.familyMono,
                fontSize: 12,
                color: theme.colors.foregroundPrimary,
              }}
            >
              {extractedOutput}
            </Text>
          </ScrollView>
        </View>
      );
    }

    return (
      <ThemedText style={{ marginTop: theme.spacing.sm }}>
        {message.content || "(No content)"}
      </ThemedText>
    );
  };

  return (
    <Pressable onPress={handlePress} onLongPress={handleLongPress} delayLongPress={500}>
      <MessageBubble message={message} variant="user" buttons={buttons}>
        <View>
          <ThemedText variant="label">You</ThemedText>
          {renderContent()}
          {renderAttachments()}
        </View>
      </MessageBubble>

      {Platform.OS === "android" && (
        <Modal
          visible={menuVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setMenuVisible(false)}
        >
          <TouchableOpacity
            style={{
              flex: 1,
              backgroundColor: "rgba(0, 0, 0, 0.5)",
              justifyContent: "center",
              alignItems: "center",
            }}
            activeOpacity={1}
            onPress={() => setMenuVisible(false)}
          >
            <View
              style={{
                backgroundColor: theme.colors.surfaceSecondary,
                borderRadius: theme.radii.lg,
                padding: theme.spacing.md,
                minWidth: 200,
                elevation: 5,
                shadowColor: "#000",
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.25,
                shadowRadius: 4,
              }}
            >
              {canEdit && onEditMessage ? (
                <TouchableOpacity
                  onPress={handleEdit}
                  style={{
                    paddingVertical: theme.spacing.md,
                    paddingHorizontal: theme.spacing.sm,
                  }}
                >
                  <ThemedText>✏️ Edit Message</ThemedText>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                onPress={handleCopy}
                style={{
                  paddingVertical: theme.spacing.md,
                  paddingHorizontal: theme.spacing.sm,
                }}
              >
                <ThemedText>📋 Copy Message</ThemedText>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </Modal>
      )}
    </Pressable>
  );
}

function ReasoningMessageCard({
  message,
}: {
  message: DisplayedMessage & { type: "reasoning" };
}): JSX.Element {
  const theme = useTheme();
  const isStreaming = message.isStreaming === true;
  const isLastPart = message.isLastPartOfMessage === true;

  // Start collapsed if not streaming, otherwise expanded
  const [isExpanded, setIsExpanded] = useState(isStreaming);
  const hasReasoningContent = hasRenderableMarkdown(message.content);

  // Track when we've seen this message finish streaming
  const hasStreamedRef = useRef(isStreaming);

  useEffect(() => {
    // If we were streaming and now we're not, collapse immediately
    if (hasStreamedRef.current && !isStreaming) {
      setIsExpanded(false);
      hasStreamedRef.current = false;
    } else if (isStreaming) {
      hasStreamedRef.current = true;
      setIsExpanded(true);
    }
  }, [isStreaming]);

  // Also collapse if we're still marked as streaming but no longer the last part
  // (means new messages have arrived after us)
  useEffect(() => {
    if (isStreaming && !isLastPart) {
      setIsExpanded(false);
    }
  }, [isStreaming, isLastPart]);

  const handleToggle = useCallback(() => {
    if (isStreaming) {
      return;
    }
    setIsExpanded((prev) => !prev);
  }, [isStreaming]);

  const thinkingBackground = `${theme.colors.thinkingMode}1A`;
  const thinkingBorder = `${theme.colors.thinkingMode}33`;

  return (
    <View
      style={{
        paddingVertical: theme.spacing.sm,
        paddingHorizontal: theme.spacing.md,
        marginBottom: theme.spacing.md,
        borderRadius: theme.radii.md,
        backgroundColor: thinkingBackground,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: thinkingBorder,
      }}
    >
      <Pressable onPress={handleToggle} accessibilityRole="button">
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: theme.spacing.sm,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.xs }}>
            <Text style={{ color: theme.colors.thinkingMode, fontSize: 14 }}>💡</Text>
            <ThemedText
              variant="caption"
              style={{
                color: theme.colors.thinkingMode,
                fontWeight: "600",
                letterSpacing: 0.5,
                textTransform: "uppercase",
              }}
            >
              {isStreaming ? "Thinking" : "Thought"}
            </ThemedText>
            {isStreaming && <StreamingCursor />}
          </View>
          {!isStreaming && (
            <Text style={{ color: theme.colors.thinkingMode, opacity: 0.6 }}>
              {isExpanded ? "▾" : "▸"}
            </Text>
          )}
        </View>
      </Pressable>

      {isExpanded && (
        <View style={{ marginTop: theme.spacing.sm }}>
          {hasReasoningContent ? (
            <MarkdownMessageBody variant="reasoning" content={message.content} />
          ) : (
            <ThemedText style={{ fontStyle: "italic", color: theme.colors.foregroundSecondary }}>
              {isStreaming ? "(Thinking…)" : "(No reasoning provided)"}
            </ThemedText>
          )}
        </View>
      )}
    </View>
  );
}

function StreamErrorMessageCard({
  message,
}: {
  message: DisplayedMessage & { type: "stream-error" };
}): JSX.Element {
  const theme = useTheme();
  const showCount = message.errorCount !== undefined && message.errorCount > 1;

  return (
    <Surface
      variant="plain"
      style={{
        backgroundColor: theme.colors.danger + "15", // 15% opacity background
        borderWidth: 1,
        borderColor: theme.colors.danger,
        borderRadius: theme.radii.sm,
        padding: theme.spacing.md,
        marginBottom: theme.spacing.md,
      }}
      accessibilityRole="alert"
    >
      {/* Header with error type and count */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: theme.spacing.sm,
          marginBottom: theme.spacing.sm,
          flexWrap: "wrap",
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.xs }}>
          <ThemedText style={{ color: theme.colors.danger, fontSize: 16, lineHeight: 16 }}>
            ●
          </ThemedText>
          <ThemedText variant="label" weight="semibold" style={{ color: theme.colors.danger }}>
            Stream Error
          </ThemedText>
        </View>

        {/* Error type badge */}
        <View
          style={{
            backgroundColor: "rgba(0, 0, 0, 0.4)",
            paddingHorizontal: theme.spacing.sm,
            paddingVertical: theme.spacing.xs,
            borderRadius: theme.radii.xs,
          }}
        >
          <ThemedText
            style={{
              fontFamily: theme.typography.familyMono,
              fontSize: 10,
              color: theme.colors.foregroundSecondary,
              textTransform: "uppercase",
            }}
          >
            {message.errorType}
          </ThemedText>
        </View>

        {/* Error count badge */}
        {showCount && (
          <View
            style={{
              backgroundColor: "rgba(244, 67, 54, 0.15)", // danger color with 15% opacity
              paddingHorizontal: theme.spacing.sm,
              paddingVertical: theme.spacing.xs,
              borderRadius: theme.radii.xs,
              marginLeft: "auto",
            }}
          >
            <ThemedText
              style={{
                fontFamily: theme.typography.familyMono,
                fontSize: 10,
                fontWeight: theme.typography.weights.semibold,
                color: theme.colors.danger,
              }}
            >
              ×{message.errorCount}
            </ThemedText>
          </View>
        )}
      </View>

      {/* Error message */}
      <ThemedText
        style={{
          fontFamily: theme.typography.familyMono,
          fontSize: theme.typography.sizes.caption,
          lineHeight: theme.typography.lineHeights.relaxed,
          color: theme.colors.foregroundPrimary,
        }}
      >
        {message.error}
      </ThemedText>
    </Surface>
  );
}

function HistoryHiddenMessageCard({
  message,
}: {
  message: DisplayedMessage & { type: "history-hidden" };
}): JSX.Element {
  const theme = useTheme();
  return (
    <Surface
      variant="ghost"
      style={{
        padding: theme.spacing.sm,
        alignItems: "center",
        marginVertical: theme.spacing.sm,
      }}
      accessibilityRole="text"
    >
      <ThemedText variant="caption" style={{ color: theme.colors.foregroundSecondary }}>
        {message.hiddenCount} earlier messages hidden
      </ThemedText>
    </Surface>
  );
}

function WorkspaceInitMessageCard({
  message,
}: {
  message: DisplayedMessage & { type: "workspace-init" };
}): JSX.Element {
  const theme = useTheme();

  const statusConfig = useMemo(() => {
    switch (message.status) {
      case "success":
        return {
          icon: "✅",
          title: "Init hook completed successfully",
          backgroundColor: "rgba(76, 175, 80, 0.16)",
          borderColor: theme.colors.success,
          titleColor: theme.colors.success,
          statusLabel: "Success",
        } as const;
      case "error":
        return {
          icon: "⚠️",
          title:
            message.exitCode !== null
              ? `Init hook exited with code ${message.exitCode}. Some setup steps failed.`
              : "Init hook failed. Some setup steps failed.",
          backgroundColor: "rgba(244, 67, 54, 0.16)",
          borderColor: theme.colors.danger,
          titleColor: theme.colors.danger,
          statusLabel: "Error",
        } as const;
      default:
        return {
          icon: "🔧",
          title: "Running init hook…",
          backgroundColor: theme.colors.accentMuted,
          borderColor: theme.colors.accent,
          titleColor: theme.colors.accent,
          statusLabel: "Running",
        } as const;
    }
  }, [
    message.exitCode,
    message.status,
    theme.colors.accent,
    theme.colors.accentMuted,
    theme.colors.danger,
    theme.colors.success,
  ]);

  return (
    <Surface
      variant="plain"
      style={{
        padding: theme.spacing.md,
        marginBottom: theme.spacing.md,
        borderColor: statusConfig.borderColor,
        borderWidth: 1,
        backgroundColor: statusConfig.backgroundColor,
      }}
      accessibilityRole="summary"
    >
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: theme.spacing.sm }}>
        <ThemedText variant="titleSmall" style={{ color: statusConfig.titleColor }}>
          {statusConfig.icon}
        </ThemedText>
        <View style={{ flex: 1 }}>
          <ThemedText variant="body" weight="semibold" style={{ color: statusConfig.titleColor }}>
            {statusConfig.title}
          </ThemedText>
          <ThemedText
            variant="monoMuted"
            style={{ marginTop: theme.spacing.xs, color: theme.colors.foregroundSecondary }}
          >
            {message.hookPath}
          </ThemedText>
        </View>
      </View>

      {message.lines.length > 0 ? (
        <View
          style={{
            marginTop: theme.spacing.sm,
            borderRadius: theme.radii.sm,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: statusConfig.borderColor,
            backgroundColor: theme.colors.surfaceSunken,
            maxHeight: 160,
          }}
        >
          <ScrollView
            style={{ maxHeight: 160 }}
            contentContainerStyle={{
              paddingHorizontal: theme.spacing.sm,
              paddingVertical: theme.spacing.xs,
              gap: theme.spacing.xs,
            }}
            showsVerticalScrollIndicator
          >
            {message.lines.map((line, index) => {
              const isErrorLine = line.startsWith("ERROR:");
              return (
                <Text
                  key={`${message.id}-line-${index}`}
                  style={{
                    fontFamily: theme.typography.familyMono,
                    fontSize: theme.typography.sizes.caption,
                    color: isErrorLine ? theme.colors.danger : theme.colors.foregroundPrimary,
                  }}
                >
                  {line}
                </Text>
              );
            })}
          </ScrollView>
        </View>
      ) : (
        <ThemedText variant="caption" style={{ marginTop: theme.spacing.sm }}>
          (No output yet)
        </ThemedText>
      )}

      <View
        style={{
          marginTop: theme.spacing.sm,
          flexDirection: "row",
          justifyContent: "space-between",
          gap: theme.spacing.xs,
          flexWrap: "wrap",
        }}
      >
        <ThemedText variant="caption" style={{ color: statusConfig.titleColor }}>
          Status: {statusConfig.statusLabel}
        </ThemedText>
        {message.exitCode !== null ? (
          <ThemedText variant="caption" style={{ color: theme.colors.foregroundSecondary }}>
            Exit code: {message.exitCode}
          </ThemedText>
        ) : null}
      </View>
    </Surface>
  );
}

/**
 * Type guard for propose_plan tool
 */
function isProposePlanTool(
  message: DisplayedMessage & { type: "tool" }
): message is DisplayedMessage & {
  type: "tool";
  args: { title: string; plan: string };
} {
  return (
    message.toolName === "propose_plan" &&
    message.args !== null &&
    typeof message.args === "object" &&
    "title" in message.args &&
    "plan" in message.args &&
    typeof message.args.title === "string" &&
    typeof message.args.plan === "string"
  );
}

/**
 * Type guard for todo_write tool
 */
function isTodoWriteTool(
  message: DisplayedMessage & { type: "tool" }
): message is DisplayedMessage & {
  type: "tool";
  args: { todos: TodoItem[] };
} {
  return (
    message.toolName === "todo_write" &&
    message.args !== null &&
    typeof message.args === "object" &&
    "todos" in message.args &&
    Array.isArray((message.args as { todos?: unknown }).todos)
  );
}

/**
 * Type guard for status_set tool
 */
function isStatusSetTool(
  message: DisplayedMessage & { type: "tool" }
): message is DisplayedMessage & {
  type: "tool";
  args: { emoji: string; message: string; url?: string };
} {
  return (
    message.toolName === "status_set" &&
    message.args !== null &&
    typeof message.args === "object" &&
    "emoji" in message.args &&
    "message" in message.args &&
    typeof message.args.emoji === "string" &&
    typeof message.args.message === "string"
  );
}

function ToolMessageCard({
  message,
  workspaceId,
  onStartHere,
}: {
  message: DisplayedMessage & { type: "tool" };
  workspaceId?: string;
  onStartHere?: (content: string) => Promise<void>;
}): JSX.Element {
  // Special handling for propose_plan tool
  if (isProposePlanTool(message)) {
    const handleStartHereWithPlan = onStartHere
      ? async () => {
          const fullContent = `# ${message.args.title}\n\n${message.args.plan}`;
          await onStartHere(fullContent);
        }
      : undefined;

    return (
      <ProposePlanCard
        title={message.args.title}
        plan={message.args.plan}
        status={message.status}
        workspaceId={workspaceId}
        onStartHere={handleStartHereWithPlan}
      />
    );
  }

  // Special handling for todo_write tool
  if (isTodoWriteTool(message)) {
    return <TodoToolCard todos={message.args.todos} status={message.status} />;
  }

  // Special handling for status_set tool
  if (isStatusSetTool(message)) {
    return (
      <StatusSetToolCard
        emoji={message.args.emoji}
        message={message.args.message}
        url={message.args.url}
        status={message.status}
      />
    );
  }

  const theme = useTheme();
  const specializedModel = useMemo<ToolCardViewModel | null>(
    () => renderSpecializedToolCard(message),
    [message]
  );
  const viewModel = useMemo<ToolCardViewModel>(
    () => specializedModel ?? createFallbackToolModel(message),
    [specializedModel, message]
  );
  const initialExpanded = viewModel.defaultExpanded ?? message.status !== "completed";
  const [expanded, setExpanded] = useState(initialExpanded);
  useEffect(() => {
    setExpanded(initialExpanded);
  }, [initialExpanded, message.id]);
  const [showRawPayload, setShowRawPayload] = useState(false);
  useEffect(() => {
    if (!expanded) {
      setShowRawPayload(false);
    }
  }, [expanded]);

  return (
    <Surface
      variant="plain"
      style={{ padding: theme.spacing.md, marginBottom: theme.spacing.md }}
      accessibilityRole="summary"
    >
      <Pressable
        onPress={() => setExpanded((prev) => !prev)}
        style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.sm }}
        accessibilityRole="button"
      >
        <Text style={{ fontSize: 18 }}>{viewModel.icon}</Text>
        <View style={{ flex: 1, gap: 2 }}>
          <ThemedText
            variant="caption"
            style={{ textTransform: "uppercase", color: theme.colors.foregroundSecondary }}
          >
            {viewModel.caption}
          </ThemedText>
          <Text
            style={{
              color: theme.colors.foregroundPrimary,
              fontSize: theme.typography.sizes.body,
              fontWeight: "600",
            }}
            numberOfLines={1}
          >
            {viewModel.title}
          </Text>
          {viewModel.subtitle ? (
            <Text
              style={{
                color: theme.colors.foregroundSecondary,
                fontSize: theme.typography.sizes.caption,
              }}
              numberOfLines={1}
            >
              {viewModel.subtitle}
            </Text>
          ) : null}
        </View>
        <ToolStatusPill status={message.status} />
        <Ionicons
          name={expanded ? "chevron-down" : "chevron-forward"}
          size={16}
          color={theme.colors.foregroundSecondary}
        />
      </Pressable>

      {expanded ? (
        <View style={{ marginTop: theme.spacing.sm, gap: theme.spacing.sm }}>
          {viewModel.summary ? <View>{viewModel.summary}</View> : null}
          {viewModel.content ? <View>{viewModel.content}</View> : null}
          <View style={{ gap: theme.spacing.xs }}>
            <Pressable
              onPress={() => setShowRawPayload((prev) => !prev)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                paddingVertical: theme.spacing.xs,
              }}
              accessibilityRole="button"
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.sm }}>
                <Ionicons
                  name={showRawPayload ? "chevron-down" : "chevron-forward"}
                  size={16}
                  color={theme.colors.foregroundSecondary}
                />
                <ThemedText variant="label">Raw payload</ThemedText>
              </View>
              <ThemedText variant="caption" style={{ color: theme.colors.foregroundSecondary }}>
                {showRawPayload ? "Hide" : "Show"}
              </ThemedText>
            </Pressable>
            {showRawPayload ? (
              <View style={{ gap: theme.spacing.sm }}>
                <View>
                  <ThemedText variant="caption" weight="medium">
                    Input
                  </ThemedText>
                  <JSONPreview value={message.args} />
                </View>
                {message.result !== undefined ? (
                  <View>
                    <ThemedText variant="caption" weight="medium">
                      Result
                    </ThemedText>
                    <JSONPreview value={message.result} />
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        </View>
      ) : null}
    </Surface>
  );
}

function createFallbackToolModel(message: DisplayedMessage & { type: "tool" }): ToolCardViewModel {
  return {
    icon: "🛠️",
    caption: message.toolName,
    title: "Raw tool payload",
    subtitle: "No specialized renderer available",
    content: (
      <ThemedText variant="muted">
        No specialized renderer is available for this tool. Use the raw payload to inspect the
        arguments.
      </ThemedText>
    ),
    defaultExpanded: true,
  };
}

type ToolStatus = (DisplayedMessage & { type: "tool" })["status"];

function ToolStatusPill({ status }: { status: ToolStatus }): JSX.Element {
  const theme = useTheme();
  const visual = getToolStatusVisual(theme, status);
  return (
    <View
      style={{
        paddingHorizontal: theme.spacing.sm,
        paddingVertical: theme.spacing.xs,
        borderRadius: theme.radii.pill,
        backgroundColor: visual.background,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: visual.border,
      }}
    >
      <ThemedText variant="caption" style={{ color: visual.color, textTransform: "uppercase" }}>
        {visual.label}
      </ThemedText>
    </View>
  );
}

interface ToolStatusVisual {
  label: string;
  color: string;
  background: string;
  border: string;
}

function getToolStatusVisual(
  theme: ReturnType<typeof useTheme>,
  status: ToolStatus
): ToolStatusVisual {
  switch (status) {
    case "completed":
      return {
        label: "Completed",
        color: theme.colors.success,
        background: "rgba(76, 175, 80, 0.16)",
        border: "rgba(76, 175, 80, 0.36)",
      };
    case "failed":
      return {
        label: "Failed",
        color: theme.colors.error,
        background: "rgba(244, 67, 54, 0.16)",
        border: "rgba(244, 67, 54, 0.36)",
      };
    case "interrupted":
      return {
        label: "Interrupted",
        color: theme.colors.warning,
        background: "rgba(255, 193, 7, 0.16)",
        border: "rgba(255, 193, 7, 0.32)",
      };
    case "executing":
      return {
        label: "Running",
        color: theme.colors.accent,
        background: theme.colors.accentMuted,
        border: theme.colors.chipBorder,
      };
    default:
      return {
        label: "Pending",
        color: theme.colors.foregroundSecondary,
        background: "rgba(255, 255, 255, 0.04)",
        border: "rgba(255, 255, 255, 0.1)",
      };
  }
}

function JSONPreview({ value }: { value: unknown }): JSX.Element {
  const theme = useTheme();
  const text = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2);
    } catch (error) {
      return `Unable to render JSON: ${String(error)}`;
    }
  }, [value]);

  return (
    <View
      style={{
        marginTop: theme.spacing.xs,
        backgroundColor: theme.colors.surfaceSunken,
        borderRadius: theme.radii.sm,
        padding: theme.spacing.sm,
      }}
    >
      <Text
        style={{
          fontFamily: theme.typography.familyMono,
          color: theme.colors.foregroundPrimary,
          fontSize: theme.typography.sizes.caption,
        }}
      >
        {text}
      </Text>
    </View>
  );
}

function ModelBadge(props: { modelId?: string | null }): JSX.Element | null {
  const theme = useTheme();
  if (!props.modelId) {
    return null;
  }

  const displayName = getModelDisplayName(props.modelId);
  if (!displayName) {
    return null;
  }

  return (
    <View
      style={{
        borderRadius: theme.radii.pill,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.chipBorder,
        paddingHorizontal: theme.spacing.sm,
        paddingVertical: theme.spacing.xs,
        backgroundColor: "rgba(255, 255, 255, 0.04)",
      }}
    >
      <ThemedText
        variant="caption"
        weight="semibold"
        style={{ color: theme.colors.foregroundPrimary }}
      >
        {displayName}
      </ThemedText>
    </View>
  );
}

function CompactedBadge(): JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: theme.spacing.sm,
        paddingVertical: theme.spacing.xs,
        backgroundColor: "rgba(31, 107, 184, 0.15)",
        borderRadius: theme.radii.sm,
      }}
    >
      <Text style={{ fontSize: 12 }}>📦</Text>
      <ThemedText
        variant="caption"
        weight="semibold"
        style={{ color: theme.colors.planModeLight, textTransform: "uppercase" }}
      >
        Compacted
      </ThemedText>
    </View>
  );
}

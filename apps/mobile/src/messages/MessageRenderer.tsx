import type { JSX } from "react";
import Markdown from "react-native-markdown-display";
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
import { useMemo, useState, useEffect, useRef } from "react";
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
      return <AssistantMessageCard message={message} />;
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
}: {
  message: DisplayedMessage & { type: "assistant" };
}): JSX.Element {
  const theme = useTheme();
  const [menuVisible, setMenuVisible] = useState(false);
  const isStreaming = "isStreaming" in message && (message as any).isStreaming === true;

  const handlePress = () => {
    Keyboard.dismiss();
  };

  const handleLongPress = async () => {
    // Import haptics dynamically to handle on press
    const Haptics = await import("expo-haptics");
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // Use native ActionSheet on iOS, custom modal on Android
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

  const handleCopy = async () => {
    setMenuVisible(false);
    const Clipboard = await import("expo-clipboard");
    await Clipboard.setStringAsync(message.content);
  };

  const markdownStyles = useMemo(
    () => ({
      body: {
        color: theme.colors.foregroundPrimary,
        fontFamily: theme.typography.familyPrimary,
        fontSize: theme.typography.sizes.body,
        lineHeight: theme.typography.lineHeights.normal,
      },
      code_block: {
        backgroundColor: theme.colors.surfaceSunken,
        borderRadius: theme.radii.sm,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.separator,
        padding: theme.spacing.sm,
        fontFamily: theme.typography.familyMono,
        fontSize: theme.typography.sizes.caption,
        color: theme.colors.foregroundPrimary,
      },
      code_inline: {
        fontFamily: theme.typography.familyMono,
        backgroundColor: theme.colors.surfaceSunken,
        paddingHorizontal: theme.spacing.xs,
        paddingVertical: 1,
        borderRadius: theme.radii.xs,
        color: theme.colors.foregroundPrimary,
        fontSize: theme.typography.sizes.caption,
      },
      fence: {
        backgroundColor: theme.colors.surfaceSunken,
        borderRadius: theme.radii.sm,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.separator,
        padding: theme.spacing.sm,
        marginVertical: theme.spacing.xs,
      },
      pre: {
        backgroundColor: theme.colors.surfaceSunken,
        borderRadius: theme.radii.sm,
        padding: theme.spacing.sm,
        fontFamily: theme.typography.familyMono,
        fontSize: theme.typography.sizes.caption,
        color: theme.colors.foregroundPrimary,
      },
      text: {
        fontFamily: theme.typography.familyMono,
        fontSize: theme.typography.sizes.caption,
        color: theme.colors.foregroundPrimary,
      },
      bullet_list: {
        marginVertical: theme.spacing.xs,
      },
      ordered_list: {
        marginVertical: theme.spacing.xs,
      },
      blockquote: {
        borderLeftColor: theme.colors.accent,
        borderLeftWidth: 2,
        paddingLeft: theme.spacing.md,
        color: theme.colors.foregroundSecondary,
      },
      heading1: {
        color: theme.colors.foregroundPrimary,
        fontSize: theme.typography.sizes.titleLarge,
        fontWeight: theme.typography.weights.bold,
        marginVertical: theme.spacing.sm,
      },
      heading2: {
        color: theme.colors.foregroundPrimary,
        fontSize: theme.typography.sizes.titleMedium,
        fontWeight: theme.typography.weights.semibold,
        marginVertical: theme.spacing.sm,
      },
      heading3: {
        color: theme.colors.foregroundPrimary,
        fontSize: theme.typography.sizes.titleSmall,
        fontWeight: theme.typography.weights.semibold,
        marginVertical: theme.spacing.xs,
      },
    }),
    [theme]
  );

  return (
    <Pressable onPress={handlePress} onLongPress={handleLongPress} delayLongPress={500}>
      <Surface
        variant="plain"
        style={{ padding: theme.spacing.md, marginBottom: theme.spacing.md }}
        accessibilityRole="summary"
      >
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            marginBottom: theme.spacing.sm,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.sm }}>
            <ThemedText variant="label">Assistant</ThemedText>
            {message.isCompacted && (
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
            )}
          </View>
          {message.model ? (
            <Surface
              variant="ghost"
              style={{
                borderRadius: theme.radii.pill,
                borderWidth: 1,
                borderColor: theme.colors.chipBorder,
                paddingHorizontal: theme.spacing.sm,
                paddingVertical: theme.spacing.xs,
              }}
            >
              <ThemedText variant="caption" weight="medium">
                {truncateModel(message.model)}
              </ThemedText>
            </Surface>
          ) : null}
        </View>
        <View style={{ flexDirection: "row", alignItems: "flex-end" }}>
          <View style={{ flex: 1 }}>
            {Boolean(message.content) ? (
              <Markdown style={markdownStyles}>{message.content}</Markdown>
            ) : (
              <ThemedText variant="muted">(No content)</ThemedText>
            )}
          </View>
          {isStreaming && <StreamingCursor />}
        </View>
      </Surface>

      {/* Android context menu modal */}
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

  const handlePress = () => {
    Keyboard.dismiss();
  };

  const handleLongPress = async () => {
    // Import haptics dynamically to handle on press
    const Haptics = await import("expo-haptics");
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // Use native ActionSheet on iOS, custom modal on Android
    if (Platform.OS === "ios") {
      const options = ["Copy Message"];
      if (canEdit && onEditMessage) {
        options.unshift("Edit Message"); // Add Edit as first option
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
            // Edit Message (only if canEdit)
            onEditMessage(message.historyId, message.content);
          } else if (buttonIndex === (canEdit && onEditMessage ? 1 : 0)) {
            // Copy Message
            await handleCopy();
          }
        }
      );
    } else {
      setMenuVisible(true);
    }
  };

  const handleEdit = () => {
    setMenuVisible(false);
    if (onEditMessage) {
      onEditMessage(message.historyId, message.content);
    }
  };

  const handleCopy = async () => {
    setMenuVisible(false);
    const Clipboard = await import("expo-clipboard");
    await Clipboard.setStringAsync(message.content);
  };

  return (
    <Pressable onPress={handlePress} onLongPress={handleLongPress} delayLongPress={500}>
      <Surface
        variant="plain"
        style={{ padding: theme.spacing.md, marginBottom: theme.spacing.md }}
        accessibilityRole="text"
      >
        <ThemedText variant="label">You</ThemedText>
        <ThemedText style={{ marginTop: theme.spacing.sm }}>
          {message.content || "(No content)"}
        </ThemedText>
        {message.imageParts && message.imageParts.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ marginTop: theme.spacing.md, gap: theme.spacing.sm }}
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
                }}
                resizeMode="cover"
              />
            ))}
          </ScrollView>
        ) : null}
      </Surface>

      {/* Android context menu modal */}
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
              {canEdit && onEditMessage && (
                <TouchableOpacity
                  onPress={handleEdit}
                  style={{
                    paddingVertical: theme.spacing.md,
                    paddingHorizontal: theme.spacing.sm,
                  }}
                >
                  <ThemedText>✏️ Edit Message</ThemedText>
                </TouchableOpacity>
              )}
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
  const isStreaming = "isStreaming" in message && (message as any).isStreaming === true;
  const [isExpanded, setIsExpanded] = useState(true); // Default expanded

  // Auto-collapse when reasoning finishes (isStreaming becomes false)
  useEffect(() => {
    if (!isStreaming) {
      setIsExpanded(false);
    }
  }, [isStreaming]);

  return (
    <Surface
      variant="plain"
      style={{
        borderLeftWidth: 3,
        borderLeftColor: theme.colors.thinkingMode,
        padding: theme.spacing.md,
        marginBottom: theme.spacing.md,
      }}
    >
      <Pressable onPress={() => setIsExpanded(!isExpanded)}>
        <ThemedText variant="label" style={{ color: theme.colors.thinkingMode }}>
          Thinking
        </ThemedText>
      </Pressable>

      {isExpanded && (
        <View style={{ flexDirection: "row", alignItems: "flex-end", marginTop: theme.spacing.sm }}>
          <ThemedText
            style={{ flex: 1, fontStyle: "italic", color: theme.colors.foregroundSecondary }}
          >
            {message.content || "(Thinking…)"}
          </ThemedText>
          {isStreaming && <StreamingCursor />}
        </View>
      )}
    </Surface>
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

  // Generic tool rendering for all other tools
  const theme = useTheme();
  const [isExpanded, setIsExpanded] = useState(false);

  const statusConfig = useMemo(() => {
    switch (message.status) {
      case "completed":
        return { color: theme.colors.success, label: "✓ Completed" };
      case "failed":
        return { color: theme.colors.danger, label: "✗ Failed" };
      case "interrupted":
        return { color: theme.colors.warning, label: "⚠ Interrupted" };
      case "executing":
        return { color: theme.colors.accent, label: "⟳ Executing" };
      default:
        return { color: theme.colors.foregroundSecondary, label: "○ Pending" };
    }
  }, [
    message.status,
    theme.colors.accent,
    theme.colors.danger,
    theme.colors.foregroundSecondary,
    theme.colors.success,
    theme.colors.warning,
  ]);

  return (
    <Surface
      variant="plain"
      style={{ padding: theme.spacing.md, marginBottom: theme.spacing.md }}
      accessibilityRole="summary"
    >
      <Pressable
        onPress={() => setIsExpanded(!isExpanded)}
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
      >
        <View
          style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: theme.spacing.sm }}
        >
          <Ionicons
            name={isExpanded ? "chevron-down" : "chevron-forward"}
            size={16}
            color={theme.colors.foregroundSecondary}
          />
          <ThemedText variant="label" style={{ flex: 1 }}>
            {message.toolName}
          </ThemedText>
          <ThemedText variant="caption" style={{ color: statusConfig.color }}>
            {statusConfig.label}
          </ThemedText>
        </View>
      </Pressable>

      {isExpanded ? (
        <>
          <View style={{ marginTop: theme.spacing.sm }}>
            <ThemedText variant="caption" weight="medium">
              Input
            </ThemedText>
            <JSONPreview value={message.args} />
          </View>
          {message.result !== undefined ? (
            <View style={{ marginTop: theme.spacing.sm }}>
              <ThemedText variant="caption" weight="medium">
                Result
              </ThemedText>
              <JSONPreview value={message.result} />
            </View>
          ) : null}
        </>
      ) : null}
    </Surface>
  );
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

function truncateModel(model: string): string {
  if (model.length <= 32) {
    return model;
  }
  return `${model.slice(0, 12)}…${model.slice(-12)}`;
}

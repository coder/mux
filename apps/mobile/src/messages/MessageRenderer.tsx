import type { JSX } from "react";
import Markdown from "react-native-markdown-display";
import { Image, View, ActivityIndicator, StyleSheet, ScrollView, Text, Pressable, Animated } from "react-native";
import { useMemo, useState, useEffect, useRef } from "react";
import { Ionicons } from "@expo/vector-icons";
import { Surface } from "../components/Surface";
import { ThemedText } from "../components/ThemedText";
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
}

export function MessageRenderer({ message }: MessageRendererProps): JSX.Element | null {
  switch (message.type) {
    case "assistant":
      return <AssistantMessageCard message={message} />;
    case "user":
      return <UserMessageCard message={message} />;
    case "reasoning":
      return <ReasoningMessageCard message={message} />;
    case "stream-error":
      return <StreamErrorMessageCard message={message} />;
    case "history-hidden":
      return <HistoryHiddenMessageCard message={message} />;
    case "workspace-init":
      return <WorkspaceInitMessageCard message={message} />;
    case "tool":
      return <ToolMessageCard message={message} />;
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
  const isStreaming = 'isStreaming' in message && (message as any).isStreaming === true;
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
      },
      code_inline: {
        fontFamily: theme.typography.familyMono,
        backgroundColor: theme.colors.surfaceSunken,
        paddingHorizontal: theme.spacing.xs,
        paddingVertical: 1,
        borderRadius: theme.radii.xs,
      },
      fence: {
        fontFamily: theme.typography.familyMono,
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
      },
      heading2: {
        color: theme.colors.foregroundPrimary,
      },
      heading3: {
        color: theme.colors.foregroundPrimary,
      },
    }),
    [theme]
  );

  return (
    <Surface
      variant="plain"
      style={{ padding: theme.spacing.md, marginBottom: theme.spacing.md }}
      accessibilityRole="summary"
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: theme.spacing.sm }}>
        <ThemedText variant="label">Assistant</ThemedText>
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
  );
}

function UserMessageCard({
  message,
}: {
  message: DisplayedMessage & { type: "user" };
}): JSX.Element {
  const theme = useTheme();
  return (
    <Surface
      variant="plain"
      style={{ padding: theme.spacing.md, marginBottom: theme.spacing.md }}
      accessibilityRole="text"
    >
      <ThemedText variant="label">You</ThemedText>
      <ThemedText style={{ marginTop: theme.spacing.sm }}>{message.content || "(No content)"}</ThemedText>
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
  );
}

function ReasoningMessageCard({
  message,
}: {
  message: DisplayedMessage & { type: "reasoning" };
}): JSX.Element {
  const theme = useTheme();
  const isStreaming = 'isStreaming' in message && (message as any).isStreaming === true;
  return (
    <Surface
      variant="plain"
      style={{
        borderLeftWidth: 3,
        borderLeftColor: theme.colors.accent,
        padding: theme.spacing.md,
        marginBottom: theme.spacing.md,
      }}
    >
      <ThemedText variant="label" style={{ color: theme.colors.accent }}>
        Reasoning
      </ThemedText>
      <View style={{ flexDirection: "row", alignItems: "flex-end", marginTop: theme.spacing.sm }}>
        <ThemedText style={{ flex: 1 }}>{message.content || "(Thinking…)"}</ThemedText>
        {isStreaming && <StreamingCursor />}
      </View>
    </Surface>
  );
}

function StreamErrorMessageCard({
  message,
}: {
  message: DisplayedMessage & { type: "stream-error" };
}): JSX.Element {
  const theme = useTheme();
  return (
    <Surface
      variant="plain"
      style={{
        padding: theme.spacing.md,
        marginBottom: theme.spacing.md,
        borderColor: theme.colors.danger,
      }}
      accessibilityRole="alert"
    >
      <ThemedText variant="label" style={{ color: theme.colors.danger }}>
        Error
      </ThemedText>
      <ThemedText style={{ marginTop: theme.spacing.sm }}>{message.error}</ThemedText>
      {message.errorCount && message.errorCount > 1 ? (
        <ThemedText variant="caption" style={{ marginTop: theme.spacing.xs }}>
          Repeated {message.errorCount} times
        </ThemedText>
      ) : null}
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
  }, [message.exitCode, message.status, theme.colors.accent, theme.colors.accentMuted, theme.colors.danger, theme.colors.success]);

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

function ToolMessageCard({
  message,
}: {
  message: DisplayedMessage & { type: "tool" };
}): JSX.Element {
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
  }, [message.status, theme.colors.accent, theme.colors.danger, theme.colors.foregroundSecondary, theme.colors.success, theme.colors.warning]);

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
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: theme.spacing.sm }}>
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

import type { JSX } from "react";
import { Text, View } from "react-native";
import { ThemedText } from "./ThemedText";
import { useTheme } from "../theme";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

interface TodoItemViewProps {
  todo: TodoItem;
}

interface StatusConfig {
  icon: string;
  iconColor: string;
  borderColor: string;
  backgroundColor: string;
  textColor: string;
}

function getStatusConfig(
  status: TodoItem["status"],
  colors: ReturnType<typeof useTheme>["colors"]
): StatusConfig {
  switch (status) {
    case "completed":
      return {
        icon: "✓",
        iconColor: colors.success,
        borderColor: colors.success,
        backgroundColor: "rgba(76, 175, 80, 0.08)",
        textColor: colors.foregroundSecondary,
      };
    case "in_progress":
      return {
        icon: "⟳",
        iconColor: colors.accent,
        borderColor: colors.accent,
        backgroundColor: "rgba(0, 122, 204, 0.08)",
        textColor: colors.foregroundPrimary,
      };
    case "pending":
      return {
        icon: "○",
        iconColor: colors.foregroundMuted,
        borderColor: colors.borderSubtle,
        backgroundColor: "rgba(154, 154, 154, 0.05)",
        textColor: colors.foregroundSecondary,
      };
  }
}

/**
 * Shared component for rendering a single todo item.
 * Used by FloatingTodoCard (live progress) and TodoToolCard (historical).
 */
export function TodoItemView({ todo }: TodoItemViewProps): JSX.Element {
  const theme = useTheme();
  const config = getStatusConfig(todo.status, theme.colors);

  return (
    <View
      style={{
        flexDirection: "row",
        gap: theme.spacing.xs,
        paddingVertical: theme.spacing.xs,
        paddingHorizontal: theme.spacing.sm,
        borderLeftWidth: 2,
        borderLeftColor: config.borderColor,
        backgroundColor: config.backgroundColor,
        borderRadius: theme.radii.xs,
        marginBottom: theme.spacing.xs,
      }}
    >
      <Text style={{ color: config.iconColor, fontSize: 14 }}>{config.icon}</Text>
      <ThemedText
        style={{
          flex: 1,
          color: config.textColor,
          textDecorationLine: todo.status === "completed" ? "line-through" : "none",
        }}
      >
        {todo.content}
      </ThemedText>
    </View>
  );
}

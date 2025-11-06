import type { JSX } from "react";
import { Text, View } from "react-native";
import { Surface } from "./Surface";
import { ThemedText } from "./ThemedText";
import { useTheme } from "../theme";

interface StatusSetToolCardProps {
  emoji: string;
  message: string;
  url?: string;
  status: "pending" | "executing" | "completed" | "failed" | "interrupted";
}

/**
 * Special rendering for status_set tool calls.
 * Shows emoji + message inline (no expand/collapse, always visible).
 * Matches desktop's compact display.
 */
export function StatusSetToolCard({ emoji, message, status }: StatusSetToolCardProps): JSX.Element {
  const theme = useTheme();

  const statusColor = (() => {
    switch (status) {
      case "completed":
        return theme.colors.success;
      case "failed":
        return theme.colors.danger;
      default:
        return theme.colors.foregroundSecondary;
    }
  })();

  return (
    <Surface
      variant="plain"
      style={{
        padding: theme.spacing.sm,
        paddingHorizontal: theme.spacing.md,
        marginBottom: theme.spacing.sm,
        backgroundColor: theme.colors.surfaceSunken,
        borderLeftWidth: 2,
        borderLeftColor: statusColor,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.sm }}>
        <Text style={{ fontSize: 18 }}>{emoji}</Text>
        <ThemedText
          variant="body"
          style={{ flex: 1, fontStyle: "italic", color: theme.colors.foregroundSecondary }}
        >
          {message}
        </ThemedText>
      </View>
    </Surface>
  );
}

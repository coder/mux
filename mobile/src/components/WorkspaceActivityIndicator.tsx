import type { JSX } from "react";
import { StyleSheet, View } from "react-native";
import type { WorkspaceActivitySnapshot } from "../types";
import { ThemedText } from "./ThemedText";
import { useTheme } from "../theme";

interface WorkspaceActivityIndicatorProps {
  activity?: WorkspaceActivitySnapshot;
  fallbackLabel: string;
}

export function WorkspaceActivityIndicator(props: WorkspaceActivityIndicatorProps): JSX.Element {
  const theme = useTheme();
  const isStreaming = props.activity?.streaming ?? false;
  const dotColor = isStreaming ? theme.colors.accent : theme.colors.borderSubtle;
  const label = isStreaming
    ? props.activity?.lastModel
      ? `Streaming • ${props.activity.lastModel}`
      : "Streaming"
    : props.fallbackLabel;

  return (
    <View style={[styles.container, { gap: theme.spacing.xs }]}>
      <View
        style={[
          styles.dot,
          {
            backgroundColor: dotColor,
            opacity: isStreaming ? 1 : 0.6,
          },
        ]}
      />
      <ThemedText
        variant="caption"
        numberOfLines={1}
        style={{ color: theme.colors.foregroundMuted, flexShrink: 1, textAlign: "right" }}
      >
        {label}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    minWidth: 0,
    maxWidth: "100%",
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});

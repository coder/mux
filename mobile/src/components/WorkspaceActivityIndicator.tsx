import type { JSX } from "react";
import { StyleSheet, View } from "react-native";
import type { WorkspaceActivitySnapshot } from "../types";
import { useTheme } from "../theme";
import { getWorkspaceActivityPresentation } from "../utils/workspaceActivity";
import { ThemedText } from "./ThemedText";

interface WorkspaceActivityIndicatorProps {
  activity?: WorkspaceActivitySnapshot;
  fallbackLabel: string;
}

export function WorkspaceActivityIndicator(props: WorkspaceActivityIndicatorProps): JSX.Element {
  const theme = useTheme();
  const presentation = getWorkspaceActivityPresentation(props.activity, props.fallbackLabel);
  const statusColor =
    presentation.tone === "active"
      ? theme.colors.accent
      : presentation.tone === "attention"
        ? theme.colors.warning
        : theme.colors.border;
  const labelColor = presentation.tone === "idle" ? theme.colors.foregroundSecondary : statusColor;

  return (
    <View style={[styles.container, { gap: theme.spacing.xs }]}>
      <View
        style={[
          styles.dot,
          {
            backgroundColor: statusColor,
            opacity: presentation.tone === "idle" ? 0.75 : 1,
          },
        ]}
      />
      <ThemedText variant="caption" numberOfLines={1} style={{ color: labelColor, flexShrink: 1 }}>
        {presentation.label}
      </ThemedText>
      {presentation.detail ? (
        <>
          <ThemedText variant="caption" style={{ color: theme.colors.foregroundMuted }}>
            •
          </ThemedText>
          <ThemedText
            variant="caption"
            numberOfLines={1}
            style={{ color: theme.colors.foregroundMuted, flexShrink: 1 }}
          >
            {presentation.detail}
          </ThemedText>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
    minWidth: 0,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});

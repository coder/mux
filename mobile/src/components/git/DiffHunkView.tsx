import type { JSX } from "react";
import { memo } from "react";
import { StyleSheet, Text, View, ScrollView } from "react-native";
import { useTheme } from "../../theme";
import type { DiffHunk } from "../../types/review";

interface DiffHunkViewProps {
  hunk: DiffHunk;
  isRead?: boolean;
  onPress?: () => void;
}

/**
 * Renders a single diff hunk with syntax highlighting
 * - Lines starting with + are highlighted in green (additions)
 * - Lines starting with - are highlighted in red (deletions)
 * - Lines starting with space are context (gray)
 */
export const DiffHunkView = memo<DiffHunkViewProps>(({ hunk, isRead = false, onPress }) => {
  const theme = useTheme();

  const renderDiffLine = (line: string, index: number) => {
    let backgroundColor: string;
    let textColor: string;
    let prefix = "";

    if (line.startsWith("+")) {
      backgroundColor = theme.colors.successBackground ?? "#e6ffec";
      textColor = theme.colors.success ?? "#22863a";
      prefix = "+";
    } else if (line.startsWith("-")) {
      backgroundColor = theme.colors.errorBackground ?? "#ffeef0";
      textColor = theme.colors.error ?? "#cb2431";
      prefix = "-";
    } else {
      backgroundColor = "transparent";
      textColor = theme.colors.foregroundSecondary ?? "#586069";
      prefix = " ";
    }

    const content = line.substring(1); // Remove prefix

    return (
      <View key={index} style={[styles.diffLine, { backgroundColor }]}>
        <Text style={[styles.diffPrefix, { color: textColor }]}>{prefix}</Text>
        <Text style={[styles.diffContent, { color: textColor }]}>{content}</Text>
      </View>
    );
  };

  const lines = hunk.content.split("\n");

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
        isRead && styles.readContainer,
      ]}
    >
      {/* File path header */}
      <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
        <Text
          style={[styles.filePath, { color: theme.colors.foregroundPrimary }]}
          numberOfLines={1}
        >
          {hunk.filePath}
        </Text>
        {hunk.changeType && (
          <View
            style={[
              styles.badge,
              {
                backgroundColor:
                  hunk.changeType === "added"
                    ? theme.colors.success
                    : hunk.changeType === "deleted"
                      ? theme.colors.error
                      : theme.colors.accent,
              },
            ]}
          >
            <Text style={[styles.badgeText, { color: "#fff" }]}>
              {hunk.changeType[0].toUpperCase()}
            </Text>
          </View>
        )}
      </View>

      {/* Hunk range */}
      <Text style={[styles.hunkRange, { color: theme.colors.foregroundTertiary }]}>
        {hunk.header}
      </Text>

      {/* Diff content with horizontal scroll */}
      <ScrollView horizontal style={styles.diffContainer} showsHorizontalScrollIndicator={true}>
        <View>{lines.map(renderDiffLine)}</View>
      </ScrollView>
    </View>
  );
});

DiffHunkView.displayName = "DiffHunkView";

const styles = StyleSheet.create({
  container: {
    marginBottom: 12,
    borderRadius: 8,
    borderWidth: 1,
    overflow: "hidden",
  },
  readContainer: {
    opacity: 0.6,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  filePath: {
    fontSize: 14,
    fontWeight: "600",
    flex: 1,
    marginRight: 8,
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    minWidth: 20,
    alignItems: "center",
  },
  badgeText: {
    fontSize: 10,
    fontWeight: "700",
  },
  hunkRange: {
    fontSize: 11,
    fontFamily: "Courier",
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  diffContainer: {
    maxHeight: 400,
  },
  diffLine: {
    flexDirection: "row",
    paddingVertical: 2,
    paddingHorizontal: 12,
  },
  diffPrefix: {
    width: 16,
    fontSize: 12,
    fontFamily: "Courier",
    fontWeight: "600",
  },
  diffContent: {
    fontSize: 12,
    fontFamily: "Courier",
    flex: 1,
  },
});

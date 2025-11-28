import type { JSX } from "react";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../theme";
import { useApiClient } from "../hooks/useApiClient";
import { parseDiff, extractAllHunks } from "../utils/git/diffParser";
import { parseNumstat, buildFileTree } from "../utils/git/numstatParser";
import { buildGitDiffCommand } from "../utils/git/gitCommands";
import type { DiffHunk } from "../types/review";
import type { FileTreeNode } from "../utils/git/numstatParser";
import { DiffHunkView } from "../components/git/DiffHunkView";
import { ReviewFilters } from "../components/git/ReviewFilters";

export default function GitReviewScreen(): JSX.Element {
  const theme = useTheme();
  const params = useLocalSearchParams<{ id?: string }>();
  const workspaceId = params.id ? String(params.id) : "";
  const api = useApiClient();

  const [hunks, setHunks] = useState<DiffHunk[]>([]);
  const [fileTree, setFileTree] = useState<FileTreeNode | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncationWarning, setTruncationWarning] = useState<string | null>(null);

  // Filters - default to "main" to show changes since branching
  const [diffBase, setDiffBase] = useState("main");
  const [includeUncommitted, setIncludeUncommitted] = useState(true);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);

  const loadGitData = useCallback(async () => {
    if (!workspaceId) {
      setError("No workspace ID provided");
      setIsLoading(false);
      return;
    }

    try {
      setError(null);
      setTruncationWarning(null);

      // Fetch file tree (numstat)
      const numstatCommand = buildGitDiffCommand(diffBase, includeUncommitted, "", "numstat");
      const numstatResult = await api.workspace.executeBash(workspaceId, numstatCommand, {
        timeout_secs: 30,
      });

      if (!numstatResult.success) {
        throw new Error(numstatResult.error);
      }

      const numstatData = numstatResult.data;
      if (!numstatData.success) {
        throw new Error(numstatData.error || "Failed to fetch file stats");
      }

      // Access nested data.data structure (executeBash returns Result<Result<BashOutput>>)
      const numstatBashResult = (numstatData as any).data;
      if (!numstatBashResult || !numstatBashResult.success) {
        const error = numstatBashResult?.error || "Failed to execute numstat command";
        throw new Error(error);
      }

      // Ensure output exists and is a string
      const numstatOutput = numstatBashResult.output ?? "";
      const fileStats = parseNumstat(numstatOutput);
      const tree = buildFileTree(fileStats);
      setFileTree(tree);

      // Fetch diff hunks (with optional path filter for truncation workaround)
      const pathFilter = selectedFilePath ? ` -- "${selectedFilePath}"` : "";
      const diffCommand = buildGitDiffCommand(diffBase, includeUncommitted, pathFilter, "diff");
      const diffResult = await api.workspace.executeBash(workspaceId, diffCommand, {
        timeout_secs: 30,
      });

      if (!diffResult.success) {
        throw new Error(diffResult.error);
      }

      const diffData = diffResult.data;
      if (!diffData.success) {
        throw new Error(diffData.error || "Failed to fetch diff");
      }

      // Access nested data.data structure (executeBash returns Result<Result<BashOutput>>)
      const diffBashResult = (diffData as any).data;
      if (!diffBashResult || !diffBashResult.success) {
        const error = diffBashResult?.error || "Failed to execute diff command";
        throw new Error(error);
      }

      // Ensure output exists and is a string
      const diffOutput = diffBashResult.output ?? "";
      const truncationInfo = diffBashResult.truncated;

      const fileDiffs = parseDiff(diffOutput);
      const allHunks = extractAllHunks(fileDiffs);

      // Set truncation warning only when not filtering by path
      if (truncationInfo && !selectedFilePath) {
        setTruncationWarning(
          `Diff truncated (${truncationInfo.reason}). Tap a file below to see its changes.`
        );
      }

      setHunks(allHunks);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      setError(errorMsg);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [workspaceId, diffBase, includeUncommitted, selectedFilePath, api]);

  useEffect(() => {
    void loadGitData();
  }, [loadGitData]);

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    void loadGitData();
  }, [loadGitData]);

  const renderHunk = useCallback(({ item }: { item: DiffHunk }) => {
    return <DiffHunkView hunk={item} />;
  }, []);

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {/* Always show filters, even when loading/empty/error */}
      <ReviewFilters
        diffBase={diffBase}
        includeUncommitted={includeUncommitted}
        selectedFilePath={selectedFilePath}
        fileTree={fileTree}
        onChangeDiffBase={setDiffBase}
        onChangeIncludeUncommitted={setIncludeUncommitted}
        onChangeSelectedFile={setSelectedFilePath}
      />

      {/* Truncation warning banner */}
      {truncationWarning && (
        <View
          style={[
            styles.warningBanner,
            {
              backgroundColor: "#FEF3C7",
              borderBottomColor: "#F59E0B",
            },
          ]}
        >
          <Ionicons name="warning" size={18} color="#F59E0B" />
          <Text style={[styles.warningText, { color: "#92400E" }]}>{truncationWarning}</Text>
        </View>
      )}

      {/* Show appropriate content based on state */}
      {isLoading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color={theme.colors.accent} />
          <Text style={[styles.loadingText, { color: theme.colors.foregroundSecondary }]}>
            Loading git changes...
          </Text>
        </View>
      ) : error ? (
        <View style={styles.centerContainer}>
          <Text style={[styles.errorText, { color: theme.colors.error }]}>Error: {error}</Text>
        </View>
      ) : hunks.length === 0 ? (
        <View style={styles.centerContainer}>
          <Text style={[styles.emptyText, { color: theme.colors.foregroundSecondary }]}>
            No changes to review
          </Text>
          <Text style={[styles.emptyHint, { color: theme.colors.foregroundTertiary }]}>
            Try changing the base branch above
          </Text>
        </View>
      ) : (
        <FlatList
          data={hunks}
          renderItem={renderHunk}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={handleRefresh}
              tintColor={theme.colors.accent}
            />
          }
          contentContainerStyle={styles.listContent}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centerContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  loadingText: {
    marginTop: 16,
    fontSize: 16,
  },
  errorText: {
    fontSize: 16,
    textAlign: "center",
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 16,
    textAlign: "center",
    marginBottom: 8,
  },
  emptyHint: {
    fontSize: 14,
    textAlign: "center",
  },
  listContent: {
    padding: 12,
  },
  warningBanner: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 8,
    borderBottomWidth: 2,
  },
  warningText: {
    flex: 1,
    fontSize: 13,
    fontWeight: "600",
  },
});

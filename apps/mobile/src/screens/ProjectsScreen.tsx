import type { JSX } from "react";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useProjectsData } from "../hooks/useProjectsData";
import { useTheme } from "../theme";
import { ThemedText } from "../components/ThemedText";
import { Surface } from "../components/Surface";
import { IconButton } from "../components/IconButton";
import type { FrontendWorkspaceMetadata } from "../types";

interface WorkspaceListItem {
  metadata: FrontendWorkspaceMetadata;
  lastActive: number;
  isOld: boolean;
}

interface ProjectGroup {
  path: string;
  displayName: string;
  workspaces: WorkspaceListItem[];
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function deriveProjectName(projectPath: string): string {
  if (!projectPath) {
    return "Unknown Project";
  }
  const normalized = projectPath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? projectPath;
}

function parseTimestamp(value?: string): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function calculateLastActive(metadata: FrontendWorkspaceMetadata): number {
  return parseTimestamp(metadata.createdAt);
}

function formatRelativeTime(timestamp: number): string {
  if (!timestamp) {
    return "Unknown";
  }
  const now = Date.now();
  const diff = now - timestamp;
  if (diff < 60_000) {
    return "Just now";
  }
  if (diff < 3_600_000) {
    const minutes = Math.round(diff / 60_000);
    return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  }
  if (diff < 86_400_000) {
    const hours = Math.round(diff / 3_600_000);
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  const days = Math.round(diff / 86_400_000);
  return days === 1 ? "Yesterday" : `${days} days ago`;
}

export function ProjectsScreen(): JSX.Element {
  const theme = useTheme();
  const spacing = theme.spacing;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { projectsQuery, workspacesQuery } = useProjectsData();
  const [search, setSearch] = useState("");

  const groupedProjects = useMemo((): ProjectGroup[] => {
    const projects = projectsQuery.data ?? [];
    const workspaces = workspacesQuery.data ?? [];
    const groups = new Map<string, ProjectGroup>();
    const normalizedSearch = search.trim().toLowerCase();

    const includeWorkspace = (workspace: FrontendWorkspaceMetadata): boolean => {
      if (!normalizedSearch) {
        return true;
      }
      const haystack = `${workspace.name} ${workspace.projectName} ${workspace.projectPath}`
        .toLowerCase()
        .replace(/\s+/g, " ");
      return haystack.includes(normalizedSearch);
    };

    const ensureGroup = (projectPath: string): ProjectGroup => {
      const existing = groups.get(projectPath);
      if (existing) {
        return existing;
      }
      const displayName = deriveProjectName(projectPath);
      const group: ProjectGroup = { path: projectPath, displayName, workspaces: [] };
      groups.set(projectPath, group);
      return group;
    };

    for (const [projectPath] of projects) {
      ensureGroup(projectPath);
    }

    for (const workspace of workspaces) {
      if (!includeWorkspace(workspace)) {
        continue;
      }
      const group = ensureGroup(workspace.projectPath);
      const lastActive = calculateLastActive(workspace);
      const isOld = Date.now() - lastActive >= ONE_DAY_MS;
      group.workspaces.push({ metadata: workspace, lastActive, isOld });
    }

    // Include workspaces for projects not yet registered
    if (!projects.length && workspaces.length > 0) {
      for (const workspace of workspaces) {
        if (!groups.has(workspace.projectPath)) {
          groups.set(workspace.projectPath, {
            path: workspace.projectPath,
            displayName: workspace.projectName,
            workspaces: [],
          });
        }
      }
    }

    const results = Array.from(groups.values())
      .map((group) => {
        const sorted = group.workspaces.slice().sort((a, b) => b.lastActive - a.lastActive);
        const recent: WorkspaceListItem[] = [];
        const old: WorkspaceListItem[] = [];
        for (const item of sorted) {
          (item.isOld ? old : recent).push(item);
        }
        if (recent.length === 0 && old.length > 0) {
          recent.push({ ...old[0], isOld: false });
          old.shift();
        }
        return {
          ...group,
          workspaces: [...recent, ...old],
        };
      })
      .filter((group) => {
        if (!normalizedSearch) {
          return true;
        }
        const haystack = `${group.displayName} ${group.path}`.toLowerCase();
        const hasWorkspaceMatch = group.workspaces.length > 0;
        return haystack.includes(normalizedSearch) || hasWorkspaceMatch;
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }));

    return results;
  }, [projectsQuery.data, workspacesQuery.data, search]);

  const isLoading = projectsQuery.isLoading || workspacesQuery.isLoading;
  const isRefreshing = projectsQuery.isRefetching || workspacesQuery.isRefetching;
  const hasError = Boolean(projectsQuery.error ?? workspacesQuery.error);

  const onRefresh = () => {
    void Promise.all([projectsQuery.refetch(), workspacesQuery.refetch()]);
  };

  const renderWorkspaceRow = (item: WorkspaceListItem) => {
    const { metadata, lastActive, isOld } = item;
    const accentWidth = 3;
    const formattedTimestamp = lastActive ? formatRelativeTime(lastActive) : "Unknown";

    return (
      <Pressable
        key={metadata.id}
        onPress={() =>
          router.push({ pathname: "/workspace/[id]", params: { id: metadata.id } })
        }
        style={({ pressed }) => [
          {
            flexDirection: "row",
            alignItems: "center",
            paddingVertical: spacing.sm,
            paddingHorizontal: spacing.md,
            borderRadius: theme.radii.sm,
            backgroundColor: pressed ? theme.colors.surfaceElevated : theme.colors.surface,
            marginBottom: spacing.xs,
          },
        ]}
      >
        <View
          style={{
            width: accentWidth,
            height: "100%",
            marginRight: spacing.md,
            borderRadius: theme.radii.xs,
            backgroundColor: isOld ? theme.colors.borderSubtle : theme.colors.accent,
          }}
        />
        <View style={{ flex: 1 }}>
          <ThemedText variant="titleSmall" weight="semibold">
            {metadata.name}
          </ThemedText>
          <ThemedText variant="caption" numberOfLines={1}>
            {metadata.namedWorkspacePath}
          </ThemedText>
        </View>
        <ThemedText variant="caption" style={{ marginLeft: spacing.md }}>
          {formattedTimestamp}
        </ThemedText>
      </Pressable>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ 
          paddingTop: insets.top + spacing.lg,
          paddingBottom: spacing.lg,
        }}
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor={theme.colors.accent} />}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ paddingHorizontal: spacing.lg, gap: spacing.lg }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View style={{ flex: 1 }}>
            <ThemedText variant="titleLarge" weight="bold">
              Projects
            </ThemedText>
            <ThemedText variant="caption">Select a workspace to open the chat timeline.</ThemedText>
          </View>
          <IconButton
            icon={<Ionicons name="settings-outline" size={20} color={theme.colors.foregroundPrimary} />}
            accessibilityLabel="Open settings"
            variant="ghost"
            onPress={() => router.push("/settings")}
          />
        </View>

        <View
          style={{
            backgroundColor: theme.colors.surface,
            borderRadius: theme.radii.md,
            borderWidth: 1,
            borderColor: theme.colors.border,
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: spacing.md,
          }}
        >
          <Ionicons
            name="search"
            size={18}
            color={theme.colors.foregroundMuted}
            style={{ marginRight: spacing.sm }}
          />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search projects or workspaces"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={{
              flex: 1,
              color: theme.colors.foregroundPrimary,
              paddingVertical: Platform.select({ ios: spacing.md, android: 0, default: spacing.md }),
            }}
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
          />
        </View>

        {isLoading ? (
          <View style={{ paddingVertical: spacing.xxl, alignItems: "center" }}>
            <ActivityIndicator size="large" color={theme.colors.accent} />
            <ThemedText variant="caption" style={{ marginTop: spacing.sm }}>
              Loading workspaces…
            </ThemedText>
          </View>
        ) : hasError ? (
          <Surface variant="raised" style={{ padding: spacing.lg }}>
            <ThemedText variant="titleSmall" weight="semibold">
              Unable to load data
            </ThemedText>
            <ThemedText variant="caption" style={{ marginTop: spacing.xs }}>
              Please check your connection and try again.
            </ThemedText>
            <Pressable
              onPress={onRefresh}
              style={({ pressed }) => ({
                marginTop: spacing.md,
                paddingVertical: spacing.sm,
                paddingHorizontal: spacing.lg,
                alignSelf: "flex-start",
                borderRadius: theme.radii.sm,
                backgroundColor: pressed ? theme.colors.accentHover : theme.colors.accent,
              })}
            >
              <ThemedText style={{ color: theme.colors.foregroundInverted }} weight="semibold">
                Retry
              </ThemedText>
            </Pressable>
          </Surface>
        ) : groupedProjects.length === 0 ? (
          <Surface variant="plain" style={{ padding: spacing.lg }}>
            <ThemedText variant="titleSmall" weight="semibold">
              No workspaces yet
            </ThemedText>
            <ThemedText variant="caption" style={{ marginTop: spacing.xs }}>
              Create a workspace from the desktop app, then pull to refresh.
            </ThemedText>
          </Surface>
        ) : (
          groupedProjects.map((group) => (
            <Surface key={group.path} variant="plain" style={{ padding: spacing.lg }}>
              <View style={{ flexDirection: "row", alignItems: "center", marginBottom: spacing.md }}>
                <View style={{ flex: 1 }}>
                  <ThemedText variant="titleSmall" weight="semibold">
                    {group.displayName}
                  </ThemedText>
                  <ThemedText variant="monoMuted" numberOfLines={1}>
                    {group.path}
                  </ThemedText>
                </View>
                <View
                  style={{
                    paddingHorizontal: spacing.sm,
                    paddingVertical: spacing.xs,
                    borderRadius: theme.radii.pill,
                    backgroundColor: theme.colors.chipBackground,
                    borderWidth: 1,
                    borderColor: theme.colors.chipBorder,
                  }}
                >
                  <ThemedText variant="caption" weight="medium">
                    {group.workspaces.length} {group.workspaces.length === 1 ? "workspace" : "workspaces"}
                  </ThemedText>
                </View>
              </View>

              {group.workspaces.map(renderWorkspaceRow)}
            </Surface>
          ))
        )}
      </View>
      </ScrollView>
      <Pressable
        accessibilityRole="button"
        onPress={() =>
          Alert.alert(
            "Add workspace",
            "Workspace creation from mobile is coming soon. Use the desktop app in the meantime."
          )
        }
        style={({ pressed }) => ({
          position: "absolute",
          bottom: spacing.xxl,
          right: spacing.lg,
          backgroundColor: pressed ? theme.colors.accentHover : theme.colors.accent,
          width: 56,
          height: 56,
          borderRadius: theme.radii.pill,
          alignItems: "center",
          justifyContent: "center",
          ...theme.shadows.subtle,
        })}
      >
        <Ionicons name="add" size={26} color={theme.colors.foregroundInverted} />
      </Pressable>
    </View>
  );
}

export default ProjectsScreen;

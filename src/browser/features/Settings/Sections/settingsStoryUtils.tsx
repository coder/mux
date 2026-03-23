import type { ReactNode } from "react";
import { useRef } from "react";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { ConfirmDialogProvider } from "@/browser/contexts/ConfirmDialogContext";
import { ExperimentsProvider } from "@/browser/contexts/ExperimentsContext";
import { PolicyProvider } from "@/browser/contexts/PolicyContext";
import { ProjectProvider } from "@/browser/contexts/ProjectContext";
import { ProviderOptionsProvider } from "@/browser/contexts/ProviderOptionsContext";
import { RouterProvider } from "@/browser/contexts/RouterContext";
import { SettingsProvider } from "@/browser/contexts/SettingsContext";
import { UILayoutsProvider } from "@/browser/contexts/UILayoutsContext";
import { WorkspaceProvider } from "@/browser/contexts/WorkspaceContext";
import { createWorkspace, groupWorkspacesByProject } from "@/browser/stories/mockFactory";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { selectWorkspace } from "@/browser/stories/storyHelpers";
import { getExperimentKey, type ExperimentId } from "@/common/constants/experiments";
import { SELECTED_WORKSPACE_KEY, UI_THEME_KEY } from "@/common/constants/storage";
import type { ServerAuthSession } from "@/common/orpc/types";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import type { ProjectConfig } from "@/common/types/project";
import type { TaskSettings } from "@/common/types/tasks";
import type { LayoutPresetsConfig } from "@/common/types/uiLayouts";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

interface SettingsSectionStoryProps {
  setup: () => APIClient;
  children: ReactNode;
}

function resetStorybookPersistedStateForStory(): void {
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(SELECTED_WORKSPACE_KEY);
    localStorage.setItem(UI_THEME_KEY, JSON.stringify("dark"));
  }
}

function getStorybookRenderKey(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const params = new URLSearchParams(window.location.search);
  const storyId = params.get("id") ?? params.get("path");
  const viewportBucket = window.innerWidth <= 768 ? "narrow" : "wide";
  return storyId ? `${storyId}:${viewportBucket}` : viewportBucket;
}

/**
 * Shared story wrapper for settings section stories.
 *
 * Mirrors the minimal provider stack needed by settings sections while allowing
 * each story to inject a mock ORPC client via setup().
 */
export function SettingsSectionStory(props: SettingsSectionStoryProps) {
  const lastRenderKeyRef = useRef<string | null>(null);
  const clientRef = useRef<APIClient | null>(null);

  const renderKey = getStorybookRenderKey();
  const shouldReset = clientRef.current === null || lastRenderKeyRef.current !== renderKey;

  if (shouldReset) {
    resetStorybookPersistedStateForStory();
    lastRenderKeyRef.current = renderKey;
    clientRef.current = null;
  }

  clientRef.current ??= props.setup();

  return (
    <APIProvider key={renderKey ?? "settings-section-story"} client={clientRef.current}>
      <PolicyProvider>
        <RouterProvider>
          <ProjectProvider>
            <WorkspaceProvider>
              <ExperimentsProvider>
                <UILayoutsProvider>
                  <SettingsProvider>
                    <ProviderOptionsProvider>
                      <ConfirmDialogProvider>{props.children}</ConfirmDialogProvider>
                    </ProviderOptionsProvider>
                  </SettingsProvider>
                </UILayoutsProvider>
              </ExperimentsProvider>
            </WorkspaceProvider>
          </ProjectProvider>
        </RouterProvider>
      </PolicyProvider>
    </APIProvider>
  );
}

interface SetupSettingsStoryOptions {
  layoutPresets?: LayoutPresetsConfig;
  providersConfig?: Record<
    string,
    {
      apiKeySet: boolean;
      isEnabled: boolean;
      isConfigured: boolean;
      baseUrl?: string;
      models?: string[];
    }
  >;
  providersList?: string[];
  agentAiDefaults?: AgentAiDefaults;
  taskSettings?: Partial<TaskSettings>;
  /** Sessions shown in Settings → Server Access. */
  serverAuthSessions?: ServerAuthSession[];
  /** Pre-set experiment states in localStorage before render */
  experiments?: Partial<Record<string, boolean>>;
}

/** Setup basic workspace for settings stories. */
export function setupSettingsStory(options: SetupSettingsStoryOptions): APIClient {
  const workspaces = [createWorkspace({ id: "ws-1", name: "main", projectName: "my-app" })];

  selectWorkspace(workspaces[0]);

  if (options.experiments) {
    for (const [experimentId, enabled] of Object.entries(options.experiments)) {
      const key = getExperimentKey(experimentId as ExperimentId);
      window.localStorage.setItem(key, JSON.stringify(enabled));
    }
  }

  return createMockORPCClient({
    projects: groupWorkspacesByProject(workspaces),
    workspaces,
    providersConfig: options.providersConfig ?? {},
    agentAiDefaults: options.agentAiDefaults,
    providersList: options.providersList ?? ["anthropic", "openai", "xai"],
    taskSettings: options.taskSettings,
    serverAuthSessions: options.serverAuthSessions,
    layoutPresets: options.layoutPresets,
  });
}

/** Setup projects with explicit trust states for Security section stories. */
export function setupSecurityStory(
  projectEntries: Array<{
    name: string;
    path: string;
    trusted: boolean;
    workspaces?: string[];
  }>
): APIClient {
  const allWorkspaces: FrontendWorkspaceMetadata[] = [];
  const projects = new Map<string, ProjectConfig>();

  for (const entry of projectEntries) {
    const workspaceNames = entry.workspaces ?? ["main"];
    const entryWorkspaces = workspaceNames.map((workspaceName) =>
      createWorkspace({
        id: `ws-${entry.name}-${workspaceName}`,
        name: workspaceName,
        projectName: entry.name,
        projectPath: entry.path,
      })
    );

    allWorkspaces.push(...entryWorkspaces);
    projects.set(entry.path, {
      workspaces: entryWorkspaces.map((workspace) => ({
        path: workspace.namedWorkspacePath,
        id: workspace.id,
        name: workspace.name,
      })),
      trusted: entry.trusted,
    });
  }

  if (allWorkspaces.length > 0) {
    selectWorkspace(allWorkspaces[0]);
  }

  return createMockORPCClient({
    projects,
    workspaces: allWorkspaces,
  });
}

export const MOCK_SERVER_AUTH_SESSIONS: ServerAuthSession[] = [
  {
    id: "session-current",
    label: "Safari on iPhone",
    createdAtMs: 1_735_689_600_000,
    lastUsedAtMs: 4_102_444_800_000,
    isCurrent: true,
  },
  {
    id: "session-macbook",
    label: "Chrome on Mac",
    createdAtMs: 1_735_776_000_000,
    lastUsedAtMs: 4_102_444_800_000,
    isCurrent: false,
  },
  {
    id: "session-tablet",
    label: "Firefox on Android",
    createdAtMs: 1_735_862_400_000,
    lastUsedAtMs: 4_102_444_800_000,
    isCurrent: false,
  },
];

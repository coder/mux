/**
 * Settings modal stories
 *
 * Shows different sections and states of the Settings modal:
 * - General (theme toggle)
 * - Agents (task parallelism / nesting)
 * - Providers (API key configuration)
 * - Models (custom model management)
 * - Modes (per-mode default model / reasoning)
 * - Experiments
 *
 * NOTE: Projects/MCP stories live in App.mcp.stories.tsx
 *
 * Uses play functions to open the settings modal and navigate to sections.
 */

import type { APIClient } from "@/browser/contexts/API";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { createWorkspace, groupWorkspacesByProject } from "./mockFactory";
import { selectWorkspace } from "./storyHelpers";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { within, userEvent, waitFor } from "@storybook/test";
import {
  getExperimentKey,
  EXPERIMENT_IDS,
  type ExperimentId,
} from "@/common/constants/experiments";
import type { ServerAuthSession } from "@/common/orpc/types";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import type { ProjectConfig } from "@/common/types/project";
import type { TaskSettings } from "@/common/types/tasks";
import type { LayoutPresetsConfig } from "@/common/types/uiLayouts";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

export default {
  ...appMeta,
  title: "App/Settings",
};

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/** Setup basic workspace for settings stories */
function setupSettingsStory(options: {
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
}): APIClient {
  const workspaces = [createWorkspace({ id: "ws-1", name: "main", projectName: "my-app" })];

  selectWorkspace(workspaces[0]);

  // Pre-set experiment states if provided
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

/** Setup projects with explicit trust states for Security section stories */
function setupSecurityStory(
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

/** Open settings route page and optionally navigate to a section. */
async function openSettingsToSection(canvasElement: HTMLElement, section?: string): Promise<void> {
  const canvas = within(canvasElement);

  // Wait for app to fully load (sidebar with settings button should appear).
  const settingsButton = await canvas.findByTestId("settings-button", {}, { timeout: 10000 });
  await userEvent.click(settingsButton);

  // Settings now render in the main pane (route-based), not in a modal dialog.
  const generalSectionButtons = await canvas.findAllByRole("button", { name: /^General$/i });
  if (generalSectionButtons.length === 0) {
    throw new Error("Settings page did not render the section navigation");
  }

  // Navigate to specific section if requested.
  if (section && section !== "general") {
    // Capitalize first letter to match nav labels (e.g., "experiments" -> "Experiments").
    const sectionLabel = section.charAt(0).toUpperCase() + section.slice(1);
    const sectionButtons = await canvas.findAllByRole("button", {
      name: new RegExp(sectionLabel, "i"),
    });
    const sectionButton = sectionButtons[0];
    if (!sectionButton) {
      throw new Error(`Settings section button not found for ${sectionLabel}`);
    }
    await userEvent.click(sectionButton);
  }
}

const MOCK_SERVER_AUTH_SESSIONS: ServerAuthSession[] = [
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

// ═══════════════════════════════════════════════════════════════════════════════
// STORIES
// ═══════════════════════════════════════════════════════════════════════════════

/** General settings section */
export const General: AppStory = {
  render: () => <AppWithMocks setup={() => setupSettingsStory({})} />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToSection(canvasElement, "general");

    const settingsCanvas = within(canvasElement);

    await settingsCanvas.findByText(/^Theme$/i);
    await settingsCanvas.findByText(/^Terminal Font$/i);
    await settingsCanvas.findByText(/^Terminal Font Size$/i);
  },
};

/** Agents settings section - task parallelism and nesting controls */
export const Tasks: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSettingsStory({
          taskSettings: { maxParallelAgentTasks: 2, maxTaskNestingDepth: 4 },
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToSection(canvasElement, "agents");

    const settingsCanvas = within(canvasElement);

    await settingsCanvas.findByText(/Max Parallel Agent Tasks/i);
    await settingsCanvas.findByText(/Max Task Nesting Depth/i);
    await settingsCanvas.findByText(/Agent Defaults/i);
    await settingsCanvas.findByRole("heading", { name: /UI agents/i });
    await settingsCanvas.findByRole("heading", { name: /Sub-agents/i });
    await settingsCanvas.findByRole("heading", { name: /Internal/i });

    await settingsCanvas.findAllByText(/^Plan$/i);
    await settingsCanvas.findAllByText(/^Exec$/i);
    await settingsCanvas.findAllByText(/^Explore$/i);
    await settingsCanvas.findAllByText(/^Compact$/i);

    // Re-query spinbuttons inside waitFor to avoid stale DOM refs after React re-renders.
    await waitFor(() => {
      const inputs = settingsCanvas.queryAllByRole("spinbutton");
      if (inputs.length !== 2) {
        throw new Error(`Expected 2 task settings inputs, got ${inputs.length}`);
      }
      const maxParallelAgentTasks = (inputs[0] as HTMLInputElement).value;
      const maxTaskNestingDepth = (inputs[1] as HTMLInputElement).value;
      if (maxParallelAgentTasks !== "2") {
        throw new Error(
          `Expected maxParallelAgentTasks=2, got ${JSON.stringify(maxParallelAgentTasks)}`
        );
      }
      if (maxTaskNestingDepth !== "4") {
        throw new Error(
          `Expected maxTaskNestingDepth=4, got ${JSON.stringify(maxTaskNestingDepth)}`
        );
      }
    });
  },
};

/** Providers section - no providers configured */
export const ProvidersEmpty: AppStory = {
  render: () => <AppWithMocks setup={() => setupSettingsStory({ providersConfig: {} })} />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToSection(canvasElement, "providers");
  },
};

/** Providers section - some providers configured */
export const ProvidersConfigured: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSettingsStory({
          providersConfig: {
            anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true, baseUrl: "" },
            openai: {
              apiKeySet: true,
              isEnabled: true,
              isConfigured: true,
              baseUrl: "https://custom.openai.com/v1",
            },
            xai: { apiKeySet: false, isEnabled: true, isConfigured: false, baseUrl: "" },
          },
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToSection(canvasElement, "providers");
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// Layouts
// ═══════════════════════════════════════════════════════════════════════════════

/** Layouts section - empty state (no layouts configured) */
export const LayoutsEmpty: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSettingsStory({
          layoutPresets: {
            version: 2,
            slots: [],
          },
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToSection(canvasElement, "layouts");

    const settingsCanvas = within(canvasElement);

    await settingsCanvas.findByRole("heading", { name: /layout slots/i });

    // Empty state should render no slot rows.
    await settingsCanvas.findByText(/^Add layout$/i);
    if (settingsCanvas.queryByText(/Slot 1/i)) {
      throw new Error("Expected no slot rows to be rendered in the empty state");
    }
  },
};

/** Layouts section - with a preset assigned to a slot */
export const LayoutsConfigured: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSettingsStory({
          layoutPresets: {
            version: 2,
            slots: [
              {
                slot: 1,
                preset: {
                  id: "preset-1",
                  name: "My Layout",
                  leftSidebarCollapsed: false,
                  rightSidebar: {
                    collapsed: false,
                    width: { mode: "px", value: 420 },
                    layout: {
                      version: 1,
                      nextId: 2,
                      focusedTabsetId: "tabset-1",
                      root: {
                        type: "tabset",
                        id: "tabset-1",
                        tabs: ["costs", "review", "terminal_new:t1"],
                        activeTab: "review",
                      },
                    },
                  },
                },
              },
              {
                slot: 10,
                preset: {
                  id: "preset-10",
                  name: "Extra Layout",
                  leftSidebarCollapsed: false,
                  rightSidebar: {
                    collapsed: true,
                    width: { mode: "px", value: 400 },
                    layout: {
                      version: 1,
                      nextId: 2,
                      focusedTabsetId: "tabset-1",
                      root: {
                        type: "tabset",
                        id: "tabset-1",
                        tabs: ["costs"],
                        activeTab: "costs",
                      },
                    },
                  },
                },
              },
            ],
          },
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToSection(canvasElement, "layouts");

    const settingsCanvas = within(canvasElement);

    await settingsCanvas.findByRole("heading", { name: /layout slots/i });

    // Wait for the async config load from the UILayoutsProvider.
    await settingsCanvas.findByText(/My Layout/i);
    await settingsCanvas.findByText(/Extra Layout/i);
    await settingsCanvas.findByText(/^Slot 1$/i);
    await settingsCanvas.findByText(/^Slot 10$/i);
    await settingsCanvas.findByText(/^Add layout$/i);

    if (settingsCanvas.queryByText(/Slot 2/i)) {
      throw new Error("Expected only configured layouts to render");
    }
  },
};
/** Providers section - expanded to show quick links (docs + get API key) */
export const ProvidersExpanded: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSettingsStory({
          providersConfig: {
            anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true, baseUrl: "" },
            openai: { apiKeySet: false, isEnabled: true, isConfigured: false, baseUrl: "" },
            xai: { apiKeySet: false, isEnabled: true, isConfigured: false, baseUrl: "" },
          },
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToSection(canvasElement, "providers");

    const settingsCanvas = within(canvasElement);

    // Click on a provider to expand it and reveal the API key link.
    const openaiButton = await settingsCanvas.findByRole("button", { name: /openai/i });
    await userEvent.click(openaiButton);

    // Verify "Get API Key" link is visible.
    await settingsCanvas.findByRole("link", { name: /get api key/i });
  },
};

/** Models section - no custom models */
export const ModelsEmpty: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSettingsStory({
          providersConfig: {
            anthropic: {
              apiKeySet: true,
              isEnabled: true,
              isConfigured: true,
              baseUrl: "",
              models: [],
            },
            openai: {
              apiKeySet: true,
              isEnabled: true,
              isConfigured: true,
              baseUrl: "",
              models: [],
            },
          },
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToSection(canvasElement, "models");
  },
};

/** Models section - with custom models configured */
export const ModelsConfigured: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        // Pre-set 1M context enabled for Opus 4.6 so the story shows the toggle active
        window.localStorage.setItem(
          "provider_options_anthropic",
          JSON.stringify({ use1MContextModels: ["anthropic:claude-opus-4-6"] })
        );
        return setupSettingsStory({
          providersConfig: {
            anthropic: {
              apiKeySet: true,
              isEnabled: true,
              isConfigured: true,
              baseUrl: "",
              models: ["claude-sonnet-4-20250514", "claude-opus-4-6"],
            },
            openai: {
              apiKeySet: true,
              isEnabled: true,
              isConfigured: true,
              baseUrl: "",
              models: ["gpt-4o", "gpt-4o-mini", "o1-preview"],
            },
            xai: {
              apiKeySet: false,
              isEnabled: true,
              isConfigured: false,
              baseUrl: "",
              models: ["grok-beta"],
            },
          },
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToSection(canvasElement, "models");
  },
};

/** System 1 section - experiment gated */
export const System1: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSettingsStory({
          experiments: { [EXPERIMENT_IDS.SYSTEM_1]: true },
          taskSettings: {
            bashOutputCompactionMinLines: 12,
            bashOutputCompactionMinTotalBytes: 8192,
            bashOutputCompactionMaxKeptLines: 55,
            bashOutputCompactionTimeoutMs: 9000,
          },
          providersConfig: {
            anthropic: {
              apiKeySet: true,
              isEnabled: true,
              isConfigured: true,
              baseUrl: "",
              models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
            },
            openai: {
              apiKeySet: true,
              isEnabled: true,
              isConfigured: true,
              baseUrl: "",
              models: ["gpt-4o", "gpt-4o-mini", "o1-preview"],
            },
          },
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToSection(canvasElement, "system 1");

    const settingsCanvas = within(canvasElement);

    await settingsCanvas.findByText(/System 1 Model/i);
    await settingsCanvas.findByText(/System 1 Reasoning/i);
    await settingsCanvas.findByRole("heading", { name: /bash output compaction/i });

    // Re-query spinbuttons inside waitFor to avoid stale DOM refs after React re-renders.
    await waitFor(() => {
      const inputs = settingsCanvas.queryAllByRole("spinbutton");
      if (inputs.length !== 4) {
        throw new Error(`Expected 4 System 1 inputs, got ${inputs.length}`);
      }
      const minLines = (inputs[0] as HTMLInputElement).value;
      const minTotalKb = (inputs[1] as HTMLInputElement).value;
      const maxKeptLines = (inputs[2] as HTMLInputElement).value;
      const timeoutSeconds = (inputs[3] as HTMLInputElement).value;

      if (minLines !== "12") {
        throw new Error(`Expected minLines=12, got ${JSON.stringify(minLines)}`);
      }
      if (minTotalKb !== "8") {
        throw new Error(`Expected minTotalKb=8, got ${JSON.stringify(minTotalKb)}`);
      }
      if (maxKeptLines !== "55") {
        throw new Error(`Expected maxKeptLines=55, got ${JSON.stringify(maxKeptLines)}`);
      }
      if (timeoutSeconds !== "9") {
        throw new Error(`Expected timeoutSeconds=9, got ${JSON.stringify(timeoutSeconds)}`);
      }
    });
  },
};

/** Server Access section - active device sessions */
export const ServerAccess: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSettingsStory({
          serverAuthSessions: MOCK_SERVER_AUTH_SESSIONS,
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToSection(canvasElement, "server access");

    const settingsCanvas = within(canvasElement);

    await settingsCanvas.findByText(/Server access sessions/i);
    await settingsCanvas.findByText(/Safari on iPhone \(Current\)/i);
    await settingsCanvas.findByText(/Chrome on Mac/i);
    await settingsCanvas.findByText(/Firefox on Android/i);
    await settingsCanvas.findByRole("button", { name: /^Refresh$/i });
    await settingsCanvas.findByRole("button", { name: /Revoke other sessions/i });
  },
};

/** Experiments section - shows available experiments */
export const Experiments: AppStory = {
  render: () => <AppWithMocks setup={() => setupSettingsStory({})} />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToSection(canvasElement, "experiments");
  },
};

/** Experiments section - shows experiment in ON state (pre-enabled via localStorage) */
export const ExperimentsToggleOn: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSettingsStory({
          experiments: { [EXPERIMENT_IDS.SYSTEM_1]: true },
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToSection(canvasElement, "experiments");
  },
};

/** Experiments section - shows experiment in OFF state (default) */
export const ExperimentsToggleOff: AppStory = {
  render: () => <AppWithMocks setup={() => setupSettingsStory({})} />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToSection(canvasElement, "experiments");
    // Default state is OFF - no clicks needed
  },
};

/** Keybinds section - shows keyboard shortcuts reference */
export const Keybinds: AppStory = {
  render: () => <AppWithMocks setup={() => setupSettingsStory({})} />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToSection(canvasElement, "keybinds");
  },
};

/** Security section - empty state when no user projects exist */
export const SecurityEmpty: AppStory = {
  render: () => <AppWithMocks setup={() => setupSecurityStory([])} />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToSection(canvasElement, "security");

    const settingsCanvas = within(canvasElement);

    await settingsCanvas.findByText(/Project Trust/i);
    await settingsCanvas.findByText(/No projects added yet\./i);
  },
};

/** Security section - mixed trusted and untrusted projects */
export const SecurityMixedTrust: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSecurityStory([
          { name: "my-app", path: "/Users/dev/my-app", trusted: true },
          { name: "untrusted-repo", path: "/Users/dev/untrusted-repo", trusted: false },
          { name: "another-project", path: "/Users/dev/another-project", trusted: true },
        ])
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToSection(canvasElement, "security");

    const settingsCanvas = within(canvasElement);

    await settingsCanvas.findByText(/Project Trust/i);
    // One untrusted project → exactly one "Trust" button
    await settingsCanvas.findByRole("button", { name: /^Trust untrusted-repo$/i });
    // Two trusted projects → use findAllByRole (findByRole errors on multiple matches)
    const revokeButtons = await settingsCanvas.findAllByRole("button", {
      name: /^Revoke trust for /i,
    });
    if (revokeButtons.length !== 2) {
      throw new Error(`Expected 2 Revoke trust buttons, got ${revokeButtons.length}`);
    }
  },
};

/** Security section - all projects trusted */
export const SecurityAllTrusted: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSecurityStory([
          { name: "my-app", path: "/Users/dev/my-app", trusted: true },
          { name: "payments-service", path: "/Users/dev/payments-service", trusted: true },
        ])
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToSection(canvasElement, "security");

    const settingsCanvas = within(canvasElement);

    await settingsCanvas.findByText(/Project Trust/i);
    const revokeButtons = await settingsCanvas.findAllByRole("button", {
      name: /^Revoke trust for /i,
    });
    if (revokeButtons.length === 0) {
      throw new Error("Expected at least one Revoke trust button");
    }

    if (settingsCanvas.queryByRole("button", { name: /^Trust /i })) {
      throw new Error("Expected no Trust buttons when all projects are trusted");
    }
  },
};

/** Security section - all projects untrusted */
export const SecurityAllUntrusted: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSecurityStory([
          { name: "my-app", path: "/Users/dev/my-app", trusted: false },
          { name: "legacy-repo", path: "/Users/dev/legacy-repo", trusted: false },
        ])
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToSection(canvasElement, "security");

    const settingsCanvas = within(canvasElement);

    await settingsCanvas.findByText(/Project Trust/i);
    const trustButtons = await settingsCanvas.findAllByRole("button", { name: /^Trust /i });
    if (trustButtons.length === 0) {
      throw new Error("Expected at least one Trust button");
    }

    if (settingsCanvas.queryByRole("button", { name: /^Revoke trust for /i })) {
      throw new Error("Expected no Revoke trust buttons when all projects are untrusted");
    }
  },
};

// NOTE: Projects section stories live in App.projectSettings.stories.tsx

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
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import type { TaskSettings } from "@/common/types/tasks";
import type { LayoutPresetsConfig } from "@/common/types/uiLayouts";

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
    { apiKeySet: boolean; isConfigured: boolean; baseUrl?: string; models?: string[] }
  >;
  providersList?: string[];
  agentAiDefaults?: AgentAiDefaults;
  taskSettings?: Partial<TaskSettings>;
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
    layoutPresets: options.layoutPresets,
  });
}

/** Open settings modal and optionally navigate to a section */
async function openSettingsToSection(canvasElement: HTMLElement, section?: string): Promise<void> {
  const canvas = within(canvasElement);
  // Use ownerDocument.body to scope to iframe, not parent Storybook UI
  const body = within(canvasElement.ownerDocument.body);

  // Wait for app to fully load (sidebar with settings button should appear)
  const settingsButton = await canvas.findByTestId("settings-button", {}, { timeout: 10000 });
  await userEvent.click(settingsButton);

  // Wait for dialog to appear (portal renders outside canvasElement but inside iframe body)
  await body.findByRole("dialog");

  // Navigate to specific section if requested
  if (section && section !== "general") {
    // Capitalize first letter to match the button text (e.g., "experiments" -> "Experiments")
    const sectionLabel = section.charAt(0).toUpperCase() + section.slice(1);
    const sectionButton = await body.findByRole("button", {
      name: new RegExp(sectionLabel, "i"),
    });
    await userEvent.click(sectionButton);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STORIES
// ═══════════════════════════════════════════════════════════════════════════════

/** General settings section */
export const General: AppStory = {
  render: () => <AppWithMocks setup={() => setupSettingsStory({})} />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToSection(canvasElement, "general");

    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole("dialog");
    const dialogCanvas = within(dialog);

    await dialogCanvas.findByText(/^Theme$/i);
    await dialogCanvas.findByText(/^Terminal Font$/i);
    await dialogCanvas.findByText(/^Terminal Font Size$/i);
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

    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole("dialog");
    const dialogCanvas = within(dialog);

    await dialogCanvas.findByText(/Max Parallel Agent Tasks/i);
    await dialogCanvas.findByText(/Max Task Nesting Depth/i);
    await dialogCanvas.findByText(/Agent Defaults/i);
    await dialogCanvas.findByRole("heading", { name: /UI agents/i });
    await dialogCanvas.findByRole("heading", { name: /Sub-agents/i });
    await dialogCanvas.findByRole("heading", { name: /Internal/i });

    await dialogCanvas.findByText(/^Plan$/i);
    await dialogCanvas.findByText(/^Exec$/i);
    await dialogCanvas.findByText(/^Explore$/i);
    await dialogCanvas.findByText(/^Compact$/i);

    const inputs = await dialogCanvas.findAllByRole("spinbutton");
    if (inputs.length !== 2) {
      throw new Error(`Expected 2 task settings inputs, got ${inputs.length}`);
    }

    await waitFor(() => {
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
            anthropic: { apiKeySet: true, isConfigured: true, baseUrl: "" },
            openai: {
              apiKeySet: true,
              isConfigured: true,
              baseUrl: "https://custom.openai.com/v1",
            },
            xai: { apiKeySet: false, isConfigured: false, baseUrl: "" },
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

    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole("dialog");
    const dialogCanvas = within(dialog);

    await dialogCanvas.findByRole("heading", { name: /layout slots/i });

    // Empty state should render no slot rows.
    await dialogCanvas.findByText(/^Add layout$/i);
    if (dialogCanvas.queryByText(/Slot 1/i)) {
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

    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole("dialog");
    const dialogCanvas = within(dialog);

    await dialogCanvas.findByRole("heading", { name: /layout slots/i });

    // Wait for the async config load from the UILayoutsProvider.
    await dialogCanvas.findByText(/My Layout/i);
    await dialogCanvas.findByText(/Extra Layout/i);
    await dialogCanvas.findByText(/^Slot 1$/i);
    await dialogCanvas.findByText(/^Slot 10$/i);
    await dialogCanvas.findByText(/^Add layout$/i);

    if (dialogCanvas.queryByText(/Slot 2/i)) {
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
            anthropic: { apiKeySet: true, isConfigured: true, baseUrl: "" },
            openai: { apiKeySet: false, isConfigured: false, baseUrl: "" },
            xai: { apiKeySet: false, isConfigured: false, baseUrl: "" },
          },
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToSection(canvasElement, "providers");

    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole("dialog");
    const dialogCanvas = within(dialog);

    // Click on a provider to expand it and reveal the API key link
    const openaiButton = await dialogCanvas.findByRole("button", { name: /openai/i });
    await userEvent.click(openaiButton);

    // Verify "Get API Key" link is visible
    await dialogCanvas.findByRole("link", { name: /get api key/i });
  },
};

/** Models section - no custom models */
export const ModelsEmpty: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSettingsStory({
          providersConfig: {
            anthropic: { apiKeySet: true, isConfigured: true, baseUrl: "", models: [] },
            openai: { apiKeySet: true, isConfigured: true, baseUrl: "", models: [] },
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
      setup={() =>
        setupSettingsStory({
          providersConfig: {
            anthropic: {
              apiKeySet: true,
              isConfigured: true,
              baseUrl: "",
              models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
            },
            openai: {
              apiKeySet: true,
              isConfigured: true,
              baseUrl: "",
              models: ["gpt-4o", "gpt-4o-mini", "o1-preview"],
            },
            xai: {
              apiKeySet: false,
              isConfigured: false,
              baseUrl: "",
              models: ["grok-beta"],
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
              isConfigured: true,
              baseUrl: "",
              models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
            },
            openai: {
              apiKeySet: true,
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

    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole("dialog");
    const dialogCanvas = within(dialog);

    await dialogCanvas.findByText(/System 1 Model/i);
    await dialogCanvas.findByText(/System 1 Reasoning/i);
    await dialogCanvas.findByRole("heading", { name: /bash output compaction/i });

    const inputs = await dialogCanvas.findAllByRole("spinbutton");
    if (inputs.length !== 4) {
      throw new Error(`Expected 4 System 1 inputs, got ${inputs.length}`);
    }

    await waitFor(() => {
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

// NOTE: Projects section stories live in App.projectSettings.stories.tsx

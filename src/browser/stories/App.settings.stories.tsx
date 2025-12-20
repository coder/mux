/**
 * Settings modal stories
 *
 * Shows different sections and states of the Settings modal:
 * - General (theme toggle)
 * - Providers (API key configuration)
 * - Models (custom model management)
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
import { createMockORPCClient } from "../../../.storybook/mocks/orpc";
import { within, userEvent, waitFor } from "@storybook/test";
import { getExperimentKey, EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { TaskSettings } from "@/common/types/tasks";

export default {
  ...appMeta,
  title: "App/Settings",
};

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/** Setup basic workspace for settings stories */
function setupSettingsStory(options: {
  providersConfig?: Record<string, { apiKeySet: boolean; baseUrl?: string; models?: string[] }>;
  providersList?: string[];
  taskSettings?: Partial<TaskSettings>;
  /** Pre-set experiment states in localStorage before render */
  experiments?: Partial<Record<string, boolean>>;
}): APIClient {
  const workspaces = [createWorkspace({ id: "ws-1", name: "main", projectName: "my-app" })];

  selectWorkspace(workspaces[0]);

  // Pre-set experiment states if provided
  if (options.experiments) {
    for (const [experimentId, enabled] of Object.entries(options.experiments)) {
      const key = getExperimentKey(experimentId as typeof EXPERIMENT_IDS.POST_COMPACTION_CONTEXT);
      window.localStorage.setItem(key, JSON.stringify(enabled));
    }
  }

  return createMockORPCClient({
    projects: groupWorkspacesByProject(workspaces),
    workspaces,
    providersConfig: options.providersConfig ?? {},
    providersList: options.providersList ?? ["anthropic", "openai", "xai"],
    taskSettings: options.taskSettings,
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

/** General settings section with theme toggle */
export const General: AppStory = {
  render: () => <AppWithMocks setup={() => setupSettingsStory({})} />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToSection(canvasElement, "general");
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

    await body.findByText(/Max Parallel Agent Tasks/i);
    await body.findByText(/Max Task Nesting Depth/i);
    const subagentsHeading = await body.findByRole("heading", { name: /Sub-agents/i });
    const subagentsSection = subagentsHeading.parentElement;
    if (!subagentsSection) {
      throw new Error("Expected Sub-agents section container to exist");
    }

    const subagents = within(subagentsSection);

    await subagents.findByText(/^Explore$/i);

    const execMatches = subagents.queryAllByText(/^Exec$/i);
    if (execMatches.length > 0) {
      throw new Error("Expected Exec sub-agent settings to be hidden (always inherits)");
    }

    const inputs = await body.findAllByRole("spinbutton");
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
            anthropic: { apiKeySet: true, baseUrl: "" },
            openai: { apiKeySet: true, baseUrl: "https://custom.openai.com/v1" },
            xai: { apiKeySet: false, baseUrl: "" },
          },
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToSection(canvasElement, "providers");
  },
};

/** Models section - no custom models */
export const ModelsEmpty: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSettingsStory({
          providersConfig: {
            anthropic: { apiKeySet: true, baseUrl: "", models: [] },
            openai: { apiKeySet: true, baseUrl: "", models: [] },
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
              baseUrl: "",
              models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
            },
            openai: {
              apiKeySet: true,
              baseUrl: "",
              models: ["gpt-4o", "gpt-4o-mini", "o1-preview"],
            },
            xai: {
              apiKeySet: false,
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
          experiments: { [EXPERIMENT_IDS.POST_COMPACTION_CONTEXT]: true },
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

// NOTE: Projects section stories live in App.projectSettings.stories.tsx

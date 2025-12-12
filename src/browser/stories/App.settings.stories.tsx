/**
 * Settings modal stories
 *
 * Shows different sections and states of the Settings modal:
 * - General (theme toggle)
 * - Providers (API key configuration)
 * - Models (custom model management)
 *
 * Uses play functions to open the settings modal and navigate to sections.
 */

import type { APIClient } from "@/browser/contexts/API";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { createWorkspace, groupWorkspacesByProject } from "./mockFactory";
import { selectWorkspace } from "./storyHelpers";
import { createMockORPCClient } from "../../../.storybook/mocks/orpc";
import { within, userEvent, screen } from "@storybook/test";

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
}): APIClient {
  const workspaces = [createWorkspace({ id: "ws-1", name: "main", projectName: "my-app" })];

  selectWorkspace(workspaces[0]);

  return createMockORPCClient({
    projects: groupWorkspacesByProject(workspaces),
    workspaces,
    providersConfig: options.providersConfig ?? {},
    providersList: options.providersList ?? ["anthropic", "openai", "xai"],
  });
}

/** Open settings modal and optionally navigate to a section */
async function openSettingsToSection(canvasElement: HTMLElement, section?: string): Promise<void> {
  const canvas = within(canvasElement);

  // Wait for app to fully load (sidebar with settings button should appear)
  const settingsButton = await canvas.findByTestId("settings-button", {}, { timeout: 10000 });
  await userEvent.click(settingsButton);

  // Wait for dialog to appear (portal renders outside canvasElement)
  await screen.findByRole("dialog");

  // Navigate to specific section if requested
  if (section && section !== "general") {
    // Capitalize first letter to match the button text (e.g., "experiments" -> "Experiments")
    const sectionLabel = section.charAt(0).toUpperCase() + section.slice(1);
    const sectionButton = await screen.findByRole("button", {
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

/** Experiments section - toggle experiment on */
export const ExperimentsToggleOn: AppStory = {
  render: () => <AppWithMocks setup={() => setupSettingsStory({})} />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToSection(canvasElement, "experiments");

    // Find and click the switch to toggle it on (dialog is a portal, use screen)
    const toggle = await screen.findByRole("switch", { name: /Post-Compaction Context/i });
    await userEvent.click(toggle);

    // Wait for toggle to be checked before Chromatic snapshot
    await screen.findByRole("switch", { name: /Post-Compaction Context/i, checked: true });
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

/**
 * Coder workspace integration stories.
 * Tests the UI for creating and connecting to Coder cloud workspaces.
 */

import { within, userEvent, waitFor } from "@storybook/test";

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { expandProjects } from "./storyHelpers";
import type { ProjectConfig } from "@/node/config";
import type { CoderTemplate, CoderPreset, CoderWorkspace } from "@/common/orpc/schemas/coder";
import { getLastRuntimeConfigKey, getRuntimeKey } from "@/common/constants/storage";

async function openProjectCreationView(storyRoot: HTMLElement): Promise<void> {
  // App now boots into the built-in mux-chat workspace.
  // Navigate to the project creation page so runtime controls are visible.
  if (typeof localStorage !== "undefined") {
    // Ensure runtime selection state doesn't leak between stories.
    localStorage.removeItem(getLastRuntimeConfigKey("/Users/dev/my-project"));
    localStorage.removeItem(getRuntimeKey("/Users/dev/my-project"));
  }

  const projectRow = await waitFor(
    () => {
      const el = storyRoot.querySelector(
        '[data-project-path="/Users/dev/my-project"][aria-controls]'
      );
      if (!el) throw new Error("Project row not found");
      return el;
    },
    { timeout: 10_000 }
  );

  await userEvent.click(projectRow);
}
export default {
  ...appMeta,
  title: "App/Coder",
};

/** Helper to create a project config for a path with no workspaces */
function projectWithNoWorkspaces(path: string): [string, ProjectConfig] {
  return [path, { workspaces: [] }];
}

/** Mock Coder templates */
const mockTemplates: CoderTemplate[] = [
  {
    name: "coder-on-coder",
    displayName: "Coder on Coder",
    organizationName: "default",
  },
  {
    name: "kubernetes-dev",
    displayName: "Kubernetes Development",
    organizationName: "default",
  },
  {
    name: "aws-windows",
    displayName: "AWS Windows Instance",
    organizationName: "default",
  },
];

/** Mock presets for coder-on-coder template */
const mockPresetsCoderOnCoder: CoderPreset[] = [
  {
    id: "preset-sydney",
    name: "Sydney",
    description: "Australia region",
    isDefault: false,
  },
  {
    id: "preset-helsinki",
    name: "Helsinki",
    description: "Europe region",
    isDefault: false,
  },
  {
    id: "preset-pittsburgh",
    name: "Pittsburgh",
    description: "US East region",
    isDefault: true,
  },
];

/** Mock presets for kubernetes template (only one) */
const mockPresetsK8s: CoderPreset[] = [
  {
    id: "preset-k8s-1",
    name: "Standard",
    description: "Default configuration",
    isDefault: true,
  },
];

/** Mock existing Coder workspaces */
const mockWorkspaces: CoderWorkspace[] = [
  {
    name: "mux-dev",
    templateName: "coder-on-coder",
    templateDisplayName: "Coder on Coder",
    status: "running",
  },
  {
    name: "api-testing",
    templateName: "kubernetes-dev",
    templateDisplayName: "Kubernetes Dev",
    status: "running",
  },
  {
    name: "frontend-v2",
    templateName: "coder-on-coder",
    templateDisplayName: "Coder on Coder",
    status: "running",
  },
];

const mockParseError = "Unexpected token u in JSON at position 0";

const mockCoderInfo = {
  state: "available" as const,
  version: "2.28.0",
  // Include username + URL so Storybook renders the logged-in label in Coder stories.
  username: "coder-user",
  url: "https://coder.example.com",
};

/**
 * Coder available - shows Coder runtime button.
 * When Coder CLI is available, the Coder button appears in the runtime selector.
 */
export const SSHWithCoderAvailable: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/my-project"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/my-project")]),
          workspaces: [],
          coderInfo: mockCoderInfo,
          coderTemplates: mockTemplates,
          coderPresets: new Map([
            ["coder-on-coder", mockPresetsCoderOnCoder],
            ["kubernetes-dev", mockPresetsK8s],
            ["aws-windows", []],
          ]),
          coderWorkspaces: mockWorkspaces,
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await openProjectCreationView(storyRoot);
    const canvas = within(storyRoot);

    // Wait for the runtime button group to appear
    await canvas.findByRole("group", { name: "Runtime type" }, { timeout: 10000 });

    // Coder button should appear when Coder CLI is available
    await canvas.findByRole("button", { name: /Coder/i });
  },
};

/**
 * Coder new workspace flow - shows template and preset dropdowns.
 * User clicks Coder runtime button, then selects template and optionally a preset.
 */
export const CoderNewWorkspace: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/my-project"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/my-project")]),
          workspaces: [],
          coderInfo: mockCoderInfo,
          coderTemplates: mockTemplates,
          coderPresets: new Map([
            ["coder-on-coder", mockPresetsCoderOnCoder],
            ["kubernetes-dev", mockPresetsK8s],
            ["aws-windows", []],
          ]),
          coderWorkspaces: mockWorkspaces,
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await openProjectCreationView(storyRoot);
    const canvas = within(storyRoot);

    // Wait for runtime controls
    await canvas.findByRole("group", { name: "Runtime type" }, { timeout: 10000 });

    // Click Coder runtime button directly
    const coderButton = await canvas.findByRole("button", { name: /Coder/i });
    await userEvent.click(coderButton);

    // Wait for Coder controls to appear
    await canvas.findByTestId("coder-controls-inner");

    // The template dropdown should be visible with templates loaded
    await canvas.findByTestId("coder-template-select");
  },
};

/**
 * Coder existing workspace flow - shows workspace dropdown.
 * User clicks Coder runtime, switches to "Existing" mode and selects from running workspaces.
 */
export const CoderExistingWorkspace: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/my-project"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/my-project")]),
          workspaces: [],
          coderInfo: mockCoderInfo,
          coderTemplates: mockTemplates,
          coderPresets: new Map([
            ["coder-on-coder", mockPresetsCoderOnCoder],
            ["kubernetes-dev", mockPresetsK8s],
            ["aws-windows", []],
          ]),
          coderWorkspaces: mockWorkspaces,
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await openProjectCreationView(storyRoot);
    const canvas = within(storyRoot);

    // Wait for runtime controls
    await canvas.findByRole("group", { name: "Runtime type" }, { timeout: 10000 });

    // Click Coder runtime button directly
    const coderButton = await canvas.findByRole("button", { name: /Coder/i });
    await userEvent.click(coderButton);

    // Wait for Coder controls
    await canvas.findByTestId("coder-controls-inner");

    // Click "Existing" button
    const existingButton = canvas.getByRole("button", { name: "Existing" });
    await userEvent.click(existingButton);

    // Wait for workspace dropdown to appear
    await canvas.findByTestId("coder-workspace-select");
  },
};

/**
 * Coder existing workspace flow with parse error.
 * Shows the error state when listing workspaces fails to parse.
 */
export const CoderExistingWorkspaceParseError: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/my-project"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/my-project")]),
          workspaces: [],
          coderInfo: mockCoderInfo,
          coderTemplates: mockTemplates,
          coderPresets: new Map([
            ["coder-on-coder", mockPresetsCoderOnCoder],
            ["kubernetes-dev", mockPresetsK8s],
            ["aws-windows", []],
          ]),
          coderWorkspaces: mockWorkspaces,
          coderWorkspacesResult: { ok: false, error: mockParseError },
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await openProjectCreationView(storyRoot);
    const canvas = within(storyRoot);

    // Wait for runtime controls
    await canvas.findByRole("group", { name: "Runtime type" }, { timeout: 10000 });

    // Click Coder runtime button directly
    const coderButton = await canvas.findByRole("button", { name: /Coder/i });
    await userEvent.click(coderButton);

    // Wait for Coder controls
    await canvas.findByTestId("coder-controls-inner");

    // Click "Existing" button
    const existingButton = canvas.getByRole("button", { name: "Existing" });
    await userEvent.click(existingButton);

    // Error message should appear for workspace listing
    await canvas.findByText(mockParseError);
  },
};

/**
 * Coder new workspace flow with template parse error.
 * Shows the error state when listing templates fails to parse.
 */
export const CoderTemplatesParseError: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/my-project"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/my-project")]),
          workspaces: [],
          coderInfo: mockCoderInfo,
          coderTemplatesResult: { ok: false, error: mockParseError },
          coderWorkspaces: mockWorkspaces,
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await openProjectCreationView(storyRoot);
    const canvas = within(storyRoot);

    // Wait for runtime controls
    await canvas.findByRole("group", { name: "Runtime type" }, { timeout: 10000 });

    // Click Coder runtime button directly
    const coderButton = await canvas.findByRole("button", { name: /Coder/i });
    await userEvent.click(coderButton);

    // Wait for Coder controls
    await canvas.findByTestId("coder-controls-inner");

    await canvas.findByText(mockParseError);

    // Re-query inside waitFor to avoid stale DOM refs after React re-renders.
    await waitFor(() => {
      const templateSelect = canvas.queryByTestId("coder-template-select");
      if (!templateSelect?.hasAttribute("data-disabled")) {
        throw new Error("Template dropdown should be disabled when templates fail to load");
      }
    });
  },
};

/**
 * Coder new workspace flow with preset parse error.
 * Shows the error state when listing presets fails to parse.
 */
export const CoderPresetsParseError: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/my-project"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/my-project")]),
          workspaces: [],
          coderInfo: mockCoderInfo,
          coderTemplates: mockTemplates,
          coderPresets: new Map([
            ["coder-on-coder", mockPresetsCoderOnCoder],
            ["kubernetes-dev", mockPresetsK8s],
            ["aws-windows", []],
          ]),
          coderPresetsResult: new Map([["coder-on-coder", { ok: false, error: mockParseError }]]),
          coderWorkspaces: mockWorkspaces,
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await openProjectCreationView(storyRoot);
    const canvas = within(storyRoot);

    // Wait for runtime controls
    await canvas.findByRole("group", { name: "Runtime type" }, { timeout: 10000 });

    // Click Coder runtime button directly
    const coderButton = await canvas.findByRole("button", { name: /Coder/i });
    await userEvent.click(coderButton);

    // Wait for Coder controls and template select
    await canvas.findByTestId("coder-controls-inner");
    await canvas.findByTestId("coder-template-select");

    await canvas.findByText(mockParseError);
  },
};

/**
 * Coder not available - Coder button should not appear.
 * When Coder CLI is not installed, the runtime selector only shows SSH (no Coder).
 */
export const CoderNotAvailable: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/my-project"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/my-project")]),
          workspaces: [],
          coderInfo: { state: "unavailable", reason: "missing" },
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await openProjectCreationView(storyRoot);
    const canvas = within(storyRoot);

    // Wait for runtime controls to load
    await canvas.findByRole("group", { name: "Runtime type" }, { timeout: 10000 });

    // SSH button should be present
    await canvas.findByRole("button", { name: /SSH/i });

    // Coder button should NOT appear when Coder CLI is unavailable
    const coderButton = canvas.queryByRole("button", { name: /Coder/i });
    if (coderButton) {
      throw new Error("Coder button should not appear when Coder CLI is unavailable");
    }
  },
};

/**
 * Coder CLI outdated - Coder button appears but is disabled with tooltip.
 * When Coder CLI is installed but version is below minimum, shows explanation on hover.
 */
export const CoderOutdated: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/my-project"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/my-project")]),
          workspaces: [],
          coderInfo: { state: "outdated", version: "2.20.0", minVersion: "2.25.0" },
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await openProjectCreationView(storyRoot);
    const canvas = within(storyRoot);

    // Wait for runtime controls
    await canvas.findByRole("group", { name: "Runtime type" }, { timeout: 10000 });

    // Coder button should appear but be disabled.
    // Re-query inside waitFor to avoid stale DOM refs after React re-renders.
    await waitFor(() => {
      const btn = canvas.queryByRole("button", { name: /Coder/i });
      if (!btn?.hasAttribute("disabled")) {
        throw new Error("Coder button should be disabled when CLI is outdated");
      }
    });

    // Hover over Coder button to trigger tooltip with version error
    const coderButton = canvas.getByRole("button", { name: /Coder/i });
    await userEvent.hover(coderButton);

    // Wait for tooltip to appear with version info
    await waitFor(() => {
      const tooltip = document.querySelector('[role="tooltip"]');
      if (!tooltip) throw new Error("Tooltip not found");
      if (!tooltip.textContent?.includes("2.20.0")) {
        throw new Error("Tooltip should mention the current CLI version");
      }
      if (!tooltip.textContent?.includes("2.25.0")) {
        throw new Error("Tooltip should mention the minimum required version");
      }
    });
  },
};

/**
 * Coder with template that has no presets.
 * When selecting a template with 0 presets, the preset dropdown is visible but disabled.
 */
export const CoderNoPresets: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/my-project"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/my-project")]),
          workspaces: [],
          coderInfo: mockCoderInfo,
          coderTemplates: [
            { name: "simple-vm", displayName: "Simple VM", organizationName: "default" },
          ],
          coderPresets: new Map([["simple-vm", []]]),
          coderWorkspaces: [],
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await openProjectCreationView(storyRoot);
    const canvas = within(storyRoot);

    // Wait for runtime controls
    await canvas.findByRole("group", { name: "Runtime type" }, { timeout: 10000 });

    // Click Coder runtime button directly
    const coderButton = await canvas.findByRole("button", { name: /Coder/i });
    await userEvent.click(coderButton);

    // Wait for Coder controls
    await canvas.findByTestId("coder-controls-inner");

    // Template dropdown should be visible
    await canvas.findByTestId("coder-template-select");

    // Preset dropdown should be visible but disabled (shows "No presets" placeholder).
    // Re-query inside waitFor to avoid stale DOM refs after React re-renders.
    await waitFor(() => {
      // Radix UI Select sets data-disabled="" (empty string) when disabled
      const presetSelect = canvas.queryByTestId("coder-preset-select");
      if (!presetSelect?.hasAttribute("data-disabled")) {
        throw new Error("Preset dropdown should be disabled when template has no presets");
      }
    });
  },
};

/**
 * Coder with no running workspaces.
 * When switching to "Existing" mode with no running workspaces, shows empty state.
 */
export const CoderNoRunningWorkspaces: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/my-project"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/my-project")]),
          workspaces: [],
          coderInfo: mockCoderInfo,
          coderTemplates: mockTemplates,
          coderPresets: new Map([
            ["coder-on-coder", mockPresetsCoderOnCoder],
            ["kubernetes-dev", mockPresetsK8s],
          ]),
          coderWorkspaces: [], // No running workspaces
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await openProjectCreationView(storyRoot);
    const canvas = within(storyRoot);

    // Wait for runtime controls
    await canvas.findByRole("group", { name: "Runtime type" }, { timeout: 10000 });

    // Click Coder runtime button directly
    const coderButton = await canvas.findByRole("button", { name: /Coder/i });
    await userEvent.click(coderButton);

    // Click "Existing" button
    const existingButton = await canvas.findByRole("button", { name: "Existing" });
    await userEvent.click(existingButton);

    // Workspace dropdown should show "No workspaces found" placeholder.
    // Note: Radix UI Select doesn't render native <option> elements - the placeholder
    // text appears directly in the SelectTrigger element.
    // Re-query inside waitFor to avoid stale DOM refs after React re-renders.
    await waitFor(() => {
      const workspaceSelect = canvas.queryByTestId("coder-workspace-select");
      if (!workspaceSelect?.textContent?.includes("No workspaces found")) {
        throw new Error("Should show 'No workspaces found' placeholder");
      }
    });
  },
};

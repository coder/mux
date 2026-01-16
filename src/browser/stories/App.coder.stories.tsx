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

/**
 * SSH runtime with Coder available - shows Coder checkbox.
 * When user selects SSH runtime, they can enable Coder workspace mode.
 */
export const SSHWithCoderAvailable: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/my-project"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/my-project")]),
          workspaces: [],
          coderInfo: { state: "available", version: "2.28.0" },
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
    const canvas = within(storyRoot);

    // Wait for the runtime button group to appear
    await canvas.findByRole("group", { name: "Runtime type" }, { timeout: 10000 });

    // Click SSH runtime button
    const sshButton = canvas.getByRole("button", { name: /SSH/i });
    await userEvent.click(sshButton);

    // Wait for SSH mode to be active and Coder checkbox to appear
    await waitFor(
      () => {
        const coderCheckbox = canvas.queryByTestId("coder-checkbox");
        if (!coderCheckbox) throw new Error("Coder checkbox not found");
      },
      { timeout: 5000 }
    );
  },
};

/**
 * Coder new workspace flow - shows template and preset dropdowns.
 * User enables Coder, selects template, and optionally a preset.
 */
export const CoderNewWorkspace: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/my-project"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/my-project")]),
          workspaces: [],
          coderInfo: { state: "available", version: "2.28.0" },
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
    const canvas = within(storyRoot);

    // Wait for runtime controls
    await canvas.findByRole("group", { name: "Runtime type" }, { timeout: 10000 });

    // Click SSH runtime button
    const sshButton = canvas.getByRole("button", { name: /SSH/i });
    await userEvent.click(sshButton);

    // Enable Coder
    const coderCheckbox = await canvas.findByTestId("coder-checkbox", {}, { timeout: 5000 });
    await userEvent.click(coderCheckbox);

    // Wait for Coder controls to appear
    await canvas.findByTestId("coder-controls-inner", {}, { timeout: 5000 });

    // The template dropdown should be visible with templates loaded
    await canvas.findByTestId("coder-template-select", {}, { timeout: 5000 });
  },
};

/**
 * Coder existing workspace flow - shows workspace dropdown.
 * User switches to "Existing" mode and selects from running workspaces.
 */
export const CoderExistingWorkspace: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/my-project"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/my-project")]),
          workspaces: [],
          coderInfo: { state: "available", version: "2.28.0" },
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
    const canvas = within(storyRoot);

    // Wait for runtime controls
    await canvas.findByRole("group", { name: "Runtime type" }, { timeout: 10000 });

    // Click SSH runtime button
    const sshButton = canvas.getByRole("button", { name: /SSH/i });
    await userEvent.click(sshButton);

    // Enable Coder
    const coderCheckbox = await canvas.findByTestId("coder-checkbox", {}, { timeout: 5000 });
    await userEvent.click(coderCheckbox);

    // Wait for Coder controls
    await canvas.findByTestId("coder-controls-inner", {}, { timeout: 5000 });

    // Click "Existing" button
    const existingButton = canvas.getByRole("button", { name: "Existing" });
    await userEvent.click(existingButton);

    // Wait for workspace dropdown to appear
    await canvas.findByTestId("coder-workspace-select", {}, { timeout: 5000 });
  },
};

/**
 * Coder not available - checkbox should not appear.
 * When Coder CLI is not installed, the SSH runtime shows normal host input.
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
    const canvas = within(storyRoot);

    // Wait for runtime controls
    await canvas.findByRole("group", { name: "Runtime type" }, { timeout: 10000 });

    // Click SSH runtime button
    const sshButton = canvas.getByRole("button", { name: /SSH/i });
    await userEvent.click(sshButton);

    // SSH host input should appear (normal SSH mode)
    await waitFor(
      () => {
        const hostInput = canvas.queryByPlaceholderText("user@host");
        if (!hostInput) throw new Error("SSH host input not found");
      },
      { timeout: 5000 }
    );

    // Coder checkbox should NOT appear
    const coderCheckbox = canvas.queryByTestId("coder-checkbox");
    if (coderCheckbox) {
      throw new Error("Coder checkbox should not appear when Coder is unavailable");
    }
  },
};

/**
 * Coder CLI outdated - checkbox appears but is disabled with tooltip.
 * When Coder CLI is installed but version is below minimum, shows explanation.
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
    const canvas = within(storyRoot);

    // Wait for runtime controls
    await canvas.findByRole("group", { name: "Runtime type" }, { timeout: 10000 });

    // Click SSH runtime button
    const sshButton = canvas.getByRole("button", { name: /SSH/i });
    await userEvent.click(sshButton);

    // Coder checkbox should appear but be disabled
    const coderCheckbox = await canvas.findByTestId("coder-checkbox", {}, { timeout: 5000 });
    await waitFor(() => {
      if (!(coderCheckbox instanceof HTMLInputElement)) {
        throw new Error("Coder checkbox should be an input element");
      }
      if (!coderCheckbox.disabled) {
        throw new Error("Coder checkbox should be disabled when CLI is outdated");
      }
      if (coderCheckbox.checked) {
        throw new Error("Coder checkbox should be unchecked when CLI is outdated");
      }
    });

    // Hover over checkbox to trigger tooltip
    await userEvent.hover(coderCheckbox.parentElement!);

    // Wait for tooltip to appear with version info
    await waitFor(
      () => {
        const tooltip = document.querySelector('[role="tooltip"]');
        if (!tooltip) throw new Error("Tooltip not found");
        if (!tooltip.textContent?.includes("2.20.0")) {
          throw new Error("Tooltip should mention the current CLI version");
        }
        if (!tooltip.textContent?.includes("2.25.0")) {
          throw new Error("Tooltip should mention the minimum required version");
        }
      },
      { timeout: 5000 }
    );
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
          coderInfo: { state: "available", version: "2.28.0" },
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
    const canvas = within(storyRoot);

    // Wait for runtime controls
    await canvas.findByRole("group", { name: "Runtime type" }, { timeout: 10000 });

    // Click SSH runtime button
    const sshButton = canvas.getByRole("button", { name: /SSH/i });
    await userEvent.click(sshButton);

    // Enable Coder
    const coderCheckbox = await canvas.findByTestId("coder-checkbox", {}, { timeout: 5000 });
    await userEvent.click(coderCheckbox);

    // Wait for Coder controls
    await canvas.findByTestId("coder-controls-inner", {}, { timeout: 5000 });

    // Template dropdown should be visible
    await canvas.findByTestId("coder-template-select", {}, { timeout: 5000 });

    // Preset dropdown should be visible but disabled (shows "No presets" placeholder)
    const presetSelect = await canvas.findByTestId("coder-preset-select", {}, { timeout: 5000 });
    await waitFor(() => {
      // Radix UI Select sets data-disabled="" (empty string) when disabled
      if (!presetSelect.hasAttribute("data-disabled")) {
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
          coderInfo: { state: "available", version: "2.28.0" },
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
    const canvas = within(storyRoot);

    // Wait for runtime controls
    await canvas.findByRole("group", { name: "Runtime type" }, { timeout: 10000 });

    // Click SSH runtime button
    const sshButton = canvas.getByRole("button", { name: /SSH/i });
    await userEvent.click(sshButton);

    // Enable Coder
    const coderCheckbox = await canvas.findByTestId("coder-checkbox", {}, { timeout: 5000 });
    await userEvent.click(coderCheckbox);

    // Click "Existing" button
    const existingButton = await canvas.findByRole(
      "button",
      { name: "Existing" },
      { timeout: 5000 }
    );
    await userEvent.click(existingButton);

    // Workspace dropdown should show "No workspaces found" placeholder
    // Note: Radix UI Select doesn't render native <option> elements - the placeholder
    // text appears directly in the SelectTrigger element
    const workspaceSelect = await canvas.findByTestId(
      "coder-workspace-select",
      {},
      { timeout: 5000 }
    );
    await waitFor(() => {
      const triggerText = workspaceSelect.textContent;
      if (!triggerText?.includes("No workspaces found")) {
        throw new Error("Should show 'No workspaces found' placeholder");
      }
    });
  },
};

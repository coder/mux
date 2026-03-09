/**
 * Dev container runtime selection stories.
 * Exercises the UI for choosing devcontainer runtimes/configs during creation.
 */

import { within, userEvent, expect, waitFor } from "@storybook/test";

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { createMockORPCClient, type MockORPCClientOptions } from "@/browser/stories/mocks/orpc";
import { expandProjects } from "./storyHelpers";
import type { ProjectConfig } from "@/node/config";

async function openProjectCreationView(storyRoot: HTMLElement, projectPath: string): Promise<void> {
  // App now boots into the built-in mux-chat workspace.
  // Navigate to the project creation page so runtime controls are visible.
  const projectRow = await waitFor(
    () => {
      const el = storyRoot.querySelector(`[data-project-path="${projectPath}"][aria-controls]`);
      if (!el) throw new Error("Project row not found");
      return el;
    },
    { timeout: 10_000 }
  );

  await userEvent.click(projectRow);
}

/**
 * Workspace Type is now a Radix Select dropdown.
 * These helpers open the menu and select options from the portal.
 */
async function openWorkspaceTypeMenu(storyRoot: HTMLElement): Promise<void> {
  const canvas = within(storyRoot);
  await canvas.findByRole("group", { name: "Runtime type" }, { timeout: 10000 });
  const trigger = await canvas.findByLabelText("Workspace type", {}, { timeout: 10000 });
  await userEvent.click(trigger);
}

async function selectWorkspaceType(storyRoot: HTMLElement, label: string): Promise<void> {
  await openWorkspaceTypeMenu(storyRoot);
  const option = await within(document.body).findByRole(
    "option",
    { name: new RegExp(`^${label}`, "i") },
    { timeout: 10000 }
  );
  await userEvent.click(option);
}
export default {
  ...appMeta,
  title: "App/Dev container",
};

type RuntimeAvailability = NonNullable<MockORPCClientOptions["runtimeAvailability"]>;

/** Helper to create a project config for a path with no workspaces */
function projectWithNoWorkspaces(path: string): [string, ProjectConfig] {
  return [path, { workspaces: [] }];
}

const baseRuntimeAvailability: Pick<RuntimeAvailability, "local" | "worktree" | "ssh" | "docker"> =
  {
    local: { available: true },
    worktree: { available: true },
    ssh: { available: true },
    docker: { available: true },
  };

const unavailableDevcontainer: RuntimeAvailability = {
  ...baseRuntimeAvailability,
  devcontainer: {
    available: false,
    reason: "devcontainer CLI not found. Install from https://containers.dev/",
  },
};

const singleConfigAvailability: RuntimeAvailability = {
  ...baseRuntimeAvailability,
  devcontainer: {
    available: true,
    cliVersion: "0.81.1",
    configs: [
      {
        path: ".devcontainer/devcontainer.json",
        label: "Default (.devcontainer/devcontainer.json)",
      },
    ],
  },
};

const multiConfigAvailability: RuntimeAvailability = {
  ...baseRuntimeAvailability,
  devcontainer: {
    available: true,
    cliVersion: "0.81.1",
    configs: [
      {
        path: ".devcontainer/devcontainer.json",
        label: "Default (.devcontainer/devcontainer.json)",
      },
      {
        path: ".devcontainer/backend/devcontainer.json",
        label: "Backend (.devcontainer/backend/devcontainer.json)",
      },
      {
        path: ".devcontainer/frontend/devcontainer.json",
        label: "Frontend (.devcontainer/frontend/devcontainer.json)",
      },
    ],
  },
};

/**
 * Dev container runtime unavailable - button should be disabled with tooltip.
 */
export const DevcontainerUnavailable: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/no-devcontainer-cli"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/no-devcontainer-cli")]),
          workspaces: [],
          runtimeAvailability: unavailableDevcontainer,
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await openProjectCreationView(storyRoot, "/Users/dev/no-devcontainer-cli");

    // Open the workspace type dropdown and verify the Dev container option is disabled.
    await waitFor(async () => {
      await openWorkspaceTypeMenu(storyRoot);

      const devcontainerOption = await within(document.body).findByRole("option", {
        name: /^Dev container/i,
      });
      await expect(devcontainerOption).toHaveAttribute("aria-disabled", "true");

      await userEvent.keyboard("{Escape}");
    });
  },
};

/**
 * Dev container runtime with a single config - shows dropdown with one option.
 */
export const DevcontainerSingleConfig: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/devcontainer-app"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/devcontainer-app")]),
          workspaces: [],
          runtimeAvailability: singleConfigAvailability,
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await openProjectCreationView(storyRoot, "/Users/dev/devcontainer-app");
    const canvas = within(storyRoot);

    // Select Dev container runtime from Workspace Type dropdown.
    await selectWorkspaceType(storyRoot, "Dev container");

    // Wait for the config controls box to appear with a disabled dropdown
    await waitFor(() => {
      const configSelect = canvas.queryByRole("combobox", { name: "Dev container config" });
      if (!configSelect) throw new Error("Dev container config dropdown not found");
    });

    // Should show the dropdown with the single config selected.
    // Use findByRole (retry-capable) to handle transient DOM gaps between awaits.
    const configSelect = await canvas.findByRole("combobox", { name: "Dev container config" });
    await expect(configSelect).toBeEnabled();
    await expect(
      canvas.findByText("Default (.devcontainer/devcontainer.json)")
    ).resolves.toBeInTheDocument();
  },
};

/**
 * Dev container runtime with multiple configs - shows the config dropdown.
 */
export const DevcontainerMultiConfig: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/devcontainer-multi"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/devcontainer-multi")]),
          workspaces: [],
          runtimeAvailability: multiConfigAvailability,
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await openProjectCreationView(storyRoot, "/Users/dev/devcontainer-multi");
    const canvas = within(storyRoot);
    const body = within(storyRoot.ownerDocument.body);

    // Select Dev container runtime from Workspace Type dropdown.
    await selectWorkspaceType(storyRoot, "Dev container");

    // Wait for Dev container mode to be active and config dropdown to appear
    await waitFor(() => {
      const configSelect = canvas.queryByRole("combobox", { name: "Dev container config" });
      if (!configSelect) throw new Error("Dev container config dropdown not found");
    });

    // Use findByRole (retry-capable) to handle transient DOM gaps between awaits.
    const configSelect = await canvas.findByRole("combobox", { name: "Dev container config" });
    await userEvent.click(configSelect);

    const backendOption = await body.findByRole("option", {
      name: /Backend \(\.devcontainer\/backend\/devcontainer\.json\)/i,
    });
    await userEvent.click(backendOption);

    await expect(
      canvas.findByText("Backend (.devcontainer/backend/devcontainer.json)")
    ).resolves.toBeInTheDocument();
  },
};

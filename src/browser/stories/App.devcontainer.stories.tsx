/**
 * Dev container runtime selection stories.
 * Exercises the UI for choosing devcontainer runtimes/configs during creation.
 */

import { within, userEvent, expect, waitFor } from "@storybook/test";

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { createMockORPCClient, type MockORPCClientOptions } from "@/browser/stories/mocks/orpc";
import { expandProjects } from "./storyHelpers";
import type { ProjectConfig } from "@/node/config";

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
    const canvas = within(storyRoot);

    // Wait for the runtime button group to appear
    const runtimeGroup = await canvas.findByRole(
      "group",
      { name: "Runtime type" },
      { timeout: 10000 }
    );

    // Dev container button should be disabled (wait for availability data to load)
    const groupCanvas = within(runtimeGroup);
    const devcontainerButton = groupCanvas.getByText("Dev container").closest("button");
    if (!devcontainerButton) throw new Error("Dev container button not found");
    await waitFor(
      async () => {
        await expect(devcontainerButton).toBeDisabled();
      },
      { timeout: 5000 }
    );
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
    const canvas = within(storyRoot);

    // Wait for the runtime button group to appear
    const runtimeGroup = await canvas.findByRole(
      "group",
      { name: "Runtime type" },
      { timeout: 10000 }
    );

    // Click Dev container runtime button (find within the group to avoid ambiguity)
    const groupCanvas = within(runtimeGroup);
    const devcontainerButton = groupCanvas.getByText("Dev container").closest("button");
    if (!devcontainerButton) throw new Error("Dev container button not found");
    await userEvent.click(devcontainerButton);

    // Wait for the config controls box to appear with a disabled dropdown
    await waitFor(
      () => {
        const configSelect = canvas.queryByRole("combobox", { name: "Dev container config" });
        if (!configSelect) throw new Error("Dev container config dropdown not found");
      },
      { timeout: 5000 }
    );

    // Should show the dropdown with the single config selected
    const configSelect = canvas.getByRole("combobox", { name: "Dev container config" });
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
    const canvas = within(storyRoot);
    const body = within(storyRoot.ownerDocument.body);

    // Wait for the runtime button group to appear
    const runtimeGroup = await canvas.findByRole(
      "group",
      { name: "Runtime type" },
      { timeout: 10000 }
    );

    // Click Dev container runtime button (find within the group to avoid ambiguity)
    const groupCanvas = within(runtimeGroup);
    const devcontainerButton = groupCanvas.getByText("Dev container").closest("button");
    if (!devcontainerButton) throw new Error("Dev container button not found");
    await userEvent.click(devcontainerButton);

    // Wait for Dev container mode to be active and config dropdown to appear
    await waitFor(
      () => {
        const configSelect = canvas.queryByRole("combobox", { name: "Dev container config" });
        if (!configSelect) throw new Error("Dev container config dropdown not found");
      },
      { timeout: 5000 }
    );

    const configSelect = canvas.getByRole("combobox", { name: "Dev container config" });
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

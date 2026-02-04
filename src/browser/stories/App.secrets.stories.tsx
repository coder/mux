/**
 * Secrets settings stories
 *
 * Covers Settings → Secrets in both scopes:
 * - Global secrets (stored in ~/.mux/secrets.json)
 * - Project secrets (scoped to a projectPath)
 */

import type { Secret } from "@/common/types/secrets";
import type { APIClient } from "@/browser/contexts/API";
import { UI_THEME_KEY } from "@/common/constants/storage";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { createWorkspace, groupWorkspacesByProject } from "./mockFactory";
import { selectWorkspace } from "./storyHelpers";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { within, userEvent, waitFor } from "@storybook/test";

export default {
  ...appMeta,
  title: "App/Settings/Secrets",
};

interface SecretsStoryOptions {
  globalSecrets?: Secret[];
  projectSecrets?: Map<string, Secret[]>;
}

function setupSecretsStory(options: SecretsStoryOptions = {}): APIClient {
  const projectPathA = "/Users/test/my-app";
  const projectPathB = "/Users/test/other-app";

  const workspaces = [
    createWorkspace({
      id: "ws-secrets-a",
      name: "main",
      projectName: "my-app",
      projectPath: projectPathA,
    }),
    createWorkspace({
      id: "ws-secrets-b",
      name: "main",
      projectName: "other-app",
      projectPath: projectPathB,
    }),
  ];

  selectWorkspace(workspaces[0]);

  const projectSecrets =
    options.projectSecrets ??
    new Map<string, Secret[]>([
      [projectPathA, [{ key: "PROJECT_TOKEN", value: "project-secret" }]],
      [projectPathB, [{ key: "OTHER_TOKEN", value: "other-secret" }]],
    ]);

  return createMockORPCClient({
    projects: groupWorkspacesByProject(workspaces),
    workspaces,
    globalSecrets: options.globalSecrets ?? [{ key: "GLOBAL_TOKEN", value: "global-secret" }],
    projectSecrets,
  });
}

async function openSettingsToSecrets(canvasElement: HTMLElement): Promise<void> {
  const canvas = within(canvasElement);
  const body = within(canvasElement.ownerDocument.body);

  const settingsButton = await canvas.findByTestId("settings-button", {}, { timeout: 10000 });
  await userEvent.click(settingsButton);

  await body.findByRole("dialog", {}, { timeout: 10000 });

  const secretsButton = await body.findByRole("button", { name: /^Secrets$/i });
  await userEvent.click(secretsButton);
}

export const SecretsGlobal: AppStory = {
  render: () => <AppWithMocks setup={() => setupSecretsStory({})} />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToSecrets(canvasElement);

    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole("dialog", {}, { timeout: 10000 });
    const dialogCanvas = within(dialog);

    await dialogCanvas.findByText(/secrets are stored in/i);
    await dialogCanvas.findByDisplayValue("GLOBAL_TOKEN");
  },
};

export const SecretsGlobalPopulated: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSecretsStory({
          globalSecrets: [
            { key: "OPENAI_API_KEY", value: "sk-openai" },
            { key: "ANTHROPIC_API_KEY", value: "sk-anthropic" },
            { key: "GITHUB_TOKEN", value: "ghp_123" },
            { key: "SENTRY_AUTH_TOKEN", value: "sentry" },
          ],
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToSecrets(canvasElement);

    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole("dialog", {}, { timeout: 10000 });
    const dialogCanvas = within(dialog);

    // Radix ToggleGroup (type="single") items render with role="radio".
    const globalScopeToggle = await dialogCanvas.findByRole("radio", { name: /^Global$/i });
    await userEvent.click(globalScopeToggle);

    await dialogCanvas.findByText(/secrets are stored in/i);
    await dialogCanvas.findByDisplayValue("OPENAI_API_KEY");
    await dialogCanvas.findByDisplayValue("ANTHROPIC_API_KEY");
    await dialogCanvas.findByDisplayValue("GITHUB_TOKEN");
    await dialogCanvas.findByDisplayValue("SENTRY_AUTH_TOKEN");
  },
};

export const SecretsProject: AppStory = {
  render: () => <AppWithMocks setup={() => setupSecretsStory({})} />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToSecrets(canvasElement);

    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole("dialog", {}, { timeout: 10000 });
    const dialogCanvas = within(dialog);

    // Radix ToggleGroup (type="single") items render with role="radio".
    const projectScopeToggle = await dialogCanvas.findByRole("radio", { name: /^Project$/i });
    await userEvent.click(projectScopeToggle);

    await dialogCanvas.findByText(/Select a project to configure/i);
    await dialogCanvas.findByDisplayValue("PROJECT_TOKEN");
  },
};

export const SecretsLightModeFilled: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        // Set theme before AppLoader mounts so Chromatic captures the correct (light) color scheme.
        if (typeof localStorage !== "undefined") {
          localStorage.setItem(UI_THEME_KEY, JSON.stringify("light"));
        }

        return setupSecretsStory({
          globalSecrets: [{ key: "OPENAI_API_KEY", value: "sk-openai-visible" }],
        });
      }}
    />
  ),
  parameters: {
    backgrounds: {
      default: "light",
    },
  },
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToSecrets(canvasElement);

    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole("dialog", {}, { timeout: 10000 });
    const dialogCanvas = within(dialog);

    await dialogCanvas.findByDisplayValue("OPENAI_API_KEY");

    const showSecretButton = await dialogCanvas.findByRole("button", { name: /^Show secret$/i });
    await userEvent.click(showSecretButton);

    // Ensure the secret value is revealed so text color regressions (e.g. text-white) are visible.
    await waitFor(() => {
      const valueInput = dialogCanvas.getByDisplayValue("sk-openai-visible");
      if (!(valueInput instanceof HTMLInputElement)) {
        throw new Error("Expected secret value to be shown in an input");
      }

      if (valueInput.type !== "text") {
        throw new Error(
          `Expected secret value input type to be "text" after clicking "Show secret" (got "${valueInput.type}")`
        );
      }
    });
  },
};

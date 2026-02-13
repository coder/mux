import { within, userEvent, waitFor } from "@storybook/test";

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { expandProjects } from "./storyHelpers";
import type { NameGenerationError } from "@/common/types/errors";
import { getLastRuntimeConfigKey, getRuntimeKey } from "@/common/constants/storage";
import type { ProjectConfig } from "@/node/config";

const PROJECT_PATH = "/Users/dev/my-project";
const NAME_GENERATION_PROMPT = "Fix the sidebar layout";

async function openProjectCreationView(storyRoot: HTMLElement): Promise<void> {
  // App now boots into the built-in mux-chat workspace.
  // Navigate to the project creation page so runtime controls are visible.
  if (typeof localStorage !== "undefined") {
    // Ensure runtime selection state doesn't leak between stories.
    localStorage.removeItem(getLastRuntimeConfigKey(PROJECT_PATH));
    localStorage.removeItem(getRuntimeKey(PROJECT_PATH));
  }

  const projectRow = await waitFor(
    () => {
      const el = storyRoot.querySelector(`[data-project-path="${PROJECT_PATH}"][aria-controls]`);
      if (!el) throw new Error("Project row not found");
      return el;
    },
    { timeout: 10_000 }
  );

  await userEvent.click(projectRow);
}

function projectWithNoWorkspaces(path: string): [string, ProjectConfig] {
  return [path, { workspaces: [] }];
}

function setupNameGenerationErrorStory(
  error: NameGenerationError
): () => ReturnType<typeof createMockORPCClient> {
  return () => {
    expandProjects([PROJECT_PATH]);
    return createMockORPCClient({
      projects: new Map([projectWithNoWorkspaces(PROJECT_PATH)]),
      workspaces: [],
      nameGenerationResult: {
        success: false,
        error,
      },
    });
  };
}

async function triggerNameGenerationFailure(
  storyRoot: HTMLElement,
  expectedTitle: string
): Promise<void> {
  const textarea = await waitFor(
    () => {
      const el = storyRoot.querySelector("textarea");
      if (!el) throw new Error("Textarea not found");
      return el;
    },
    { timeout: 10_000 }
  );

  await userEvent.type(textarea, NAME_GENERATION_PROMPT);
  await within(storyRoot).findByText(expectedTitle, {}, { timeout: 10_000 });
}

export default {
  ...appMeta,
  title: "App/WorkspaceCreationErrors",
};

export const NameGenerationPermissionDenied: AppStory = {
  render: () => (
    <AppWithMocks
      setup={setupNameGenerationErrorStory({
        type: "permission_denied",
        provider: "anthropic",
        raw: "Forbidden",
      })}
    />
  ),
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await openProjectCreationView(storyRoot);
    await triggerNameGenerationFailure(storyRoot, "Access denied");
  },
};

export const NameGenerationRateLimited: AppStory = {
  render: () => (
    <AppWithMocks
      setup={setupNameGenerationErrorStory({
        type: "rate_limit",
        raw: "Too many requests",
      })}
    />
  ),
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await openProjectCreationView(storyRoot);
    await triggerNameGenerationFailure(storyRoot, "Rate limited");
  },
};

export const NameGenerationAuthError: AppStory = {
  render: () => (
    <AppWithMocks
      setup={setupNameGenerationErrorStory({
        type: "authentication",
        authKind: "invalid_credentials",
        provider: "openai",
        raw: "Invalid API key",
      })}
    />
  ),
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await openProjectCreationView(storyRoot);
    await triggerNameGenerationFailure(storyRoot, "Authentication failed");
  },
};

export const NameValidationError: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects([PROJECT_PATH]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces(PROJECT_PATH)]),
          workspaces: [],
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await openProjectCreationView(storyRoot);

    const canvas = within(storyRoot);
    const disableAutoNaming = await canvas.findByRole("button", {
      name: "Disable auto-naming",
    });
    await userEvent.click(disableAutoNaming);

    const nameInput = await waitFor(
      () => {
        const el = storyRoot.querySelector("#workspace-name");
        if (!(el instanceof HTMLInputElement)) {
          throw new Error("Workspace name input not found");
        }
        return el;
      },
      { timeout: 10_000 }
    );

    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "invalid name!");

    await canvas.findByText(
      "Workspace names can only contain lowercase letters, numbers, hyphens, and underscores"
    );
  },
};

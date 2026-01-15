/**
 * Slash command autocomplete stories
 *
 * Demonstrates the command suggestions popup with:
 * - Built-in commands
 * - Custom commands (from .mux/commands/)
 * - Visual distinction between built-in and custom
 * - Docs link for adding custom commands
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { setupSimpleChatStory, setWorkspaceInput } from "./storyHelpers";
import { userEvent, within, waitFor } from "@storybook/test";

export default {
  ...appMeta,
  title: "App/Slash Commands",
};

const DEFAULT_WORKSPACE_ID = "ws-slash";

/** Shows built-in slash commands only */
export const BuiltInCommands: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const client = setupSimpleChatStory({
          workspaceId: DEFAULT_WORKSPACE_ID,
          messages: [],
        });
        // Pre-fill input with "/" to trigger suggestions
        setWorkspaceInput(DEFAULT_WORKSPACE_ID, "/");
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for textarea to be available and focused
    const textarea = await canvas.findByLabelText("Message Claude", undefined, {
      timeout: 10_000,
    });
    textarea.focus();

    // Trigger suggestions by typing "/" (input is pre-filled, but we need to trigger the event)
    await userEvent.clear(textarea);
    await userEvent.type(textarea, "/");

    // Wait for suggestions popup to appear
    await waitFor(
      () => {
        const suggestions = document.querySelector("[data-command-suggestions]");
        if (!suggestions) throw new Error("Suggestions popup not found");
      },
      { timeout: 5_000 }
    );

    // Double RAF for scroll stabilization
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  },
};

/** Shows custom commands alongside built-in commands */
export const WithCustomCommands: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const client = setupSimpleChatStory({
          workspaceId: DEFAULT_WORKSPACE_ID,
          messages: [],
          slashCommands: new Map([
            [
              DEFAULT_WORKSPACE_ID,
              [
                { name: "dry", description: "Do a dry run without making changes" },
                { name: "review", description: "Review changes before committing" },
                { name: "context", description: "Summarize project context" },
                { name: "pr-summary", description: "Generate a PR description" },
              ],
            ],
          ]),
        });
        setWorkspaceInput(DEFAULT_WORKSPACE_ID, "/");
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const textarea = await canvas.findByLabelText("Message Claude", undefined, {
      timeout: 10_000,
    });
    textarea.focus();

    await userEvent.clear(textarea);
    await userEvent.type(textarea, "/");

    // Wait for suggestions popup with custom commands
    await waitFor(
      () => {
        const suggestions = document.querySelector("[data-command-suggestions]");
        if (!suggestions) throw new Error("Suggestions popup not found");
        // Verify custom badge appears
        if (!suggestions.textContent?.includes("custom")) {
          throw new Error("Custom command badge not found");
        }
      },
      { timeout: 5_000 }
    );

    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  },
};

/** Filtering commands by typing */
export const FilteredCommands: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const client = setupSimpleChatStory({
          workspaceId: DEFAULT_WORKSPACE_ID,
          messages: [],
          slashCommands: new Map([
            [
              DEFAULT_WORKSPACE_ID,
              [
                { name: "dry", description: "Do a dry run" },
                { name: "review" },
                { name: "context", description: "Summarize project context" },
              ],
            ],
          ]),
        });
        setWorkspaceInput(DEFAULT_WORKSPACE_ID, "/co");
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const textarea = await canvas.findByLabelText("Message Claude", undefined, {
      timeout: 10_000,
    });
    textarea.focus();

    await userEvent.clear(textarea);
    await userEvent.type(textarea, "/co");

    // Wait for filtered suggestions (should show /compact and /context)
    await waitFor(
      () => {
        const suggestions = document.querySelector("[data-command-suggestions]");
        if (!suggestions) throw new Error("Suggestions popup not found");
        // Should have filtered to commands starting with "co"
        if (!suggestions.textContent?.includes("compact")) {
          throw new Error("Expected /compact in filtered results");
        }
      },
      { timeout: 5_000 }
    );

    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  },
};

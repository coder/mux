/**
 * File @ mention autocomplete stories
 *
 * Visual regression tests for the @ mention file picker UX.
 * These stories interact with the chat input to trigger the file suggestions dropdown.
 * The play functions type slowly to ensure the component has time to fetch suggestions.
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./storyHelpers";
import { within, userEvent, waitFor } from "@storybook/test";

export default {
  ...appMeta,
  title: "App/AtMention",
};

/** Shows file suggestions when typing @ in the chat input */
export const FileSuggestions: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-at-mention",
          messages: [],
        })
      }
    />
  ),
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    const canvas = within(storyRoot);

    // Wait for the app to load
    const textarea = await canvas.findByLabelText("Message Claude", {}, { timeout: 8000 });

    // Type @ to trigger file suggestions - use delay to allow debounce
    await userEvent.click(textarea);
    await userEvent.type(textarea, "@src", { delay: 50 });

    // Wait for file suggestions to appear
    await waitFor(
      () => {
        const suggestionBox = document.querySelector("[data-command-suggestions]");
        if (!suggestionBox) throw new Error("Suggestions not visible");
      },
      { timeout: 8000 }
    );

    // Double RAF to let ResizeObserver + scroll settle
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  },
};

/** Shows highlighted match text and file type badges */
export const HighlightedMatches: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-at-highlight",
          messages: [],
        })
      }
    />
  ),
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    const canvas = within(storyRoot);

    const textarea = await canvas.findByLabelText("Message Claude", {}, { timeout: 8000 });
    await userEvent.click(textarea);
    await userEvent.type(textarea, "@ChatInput", { delay: 50 });

    await waitFor(
      () => {
        const suggestionBox = document.querySelector("[data-command-suggestions]");
        if (!suggestionBox) throw new Error("Suggestions not visible");
      },
      { timeout: 8000 }
    );

    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  },
};

/** Demonstrates keyboard navigation through suggestions */
export const KeyboardNavigation: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-at-nav",
          messages: [],
        })
      }
    />
  ),
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    const canvas = within(storyRoot);

    const textarea = await canvas.findByLabelText("Message Claude", {}, { timeout: 8000 });
    await userEvent.click(textarea);
    await userEvent.type(textarea, "@src", { delay: 50 });

    await waitFor(
      () => {
        const suggestionBox = document.querySelector("[data-command-suggestions]");
        if (!suggestionBox) throw new Error("Suggestions not visible");
      },
      { timeout: 8000 }
    );

    // Navigate down twice with arrow keys
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{ArrowDown}");

    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  },
};

/** Shows different file type indicators (TSX, TS, JSON, MD) */
export const FileTypeIndicators: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-at-types",
          messages: [],
        })
      }
    />
  ),
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    const canvas = within(storyRoot);

    const textarea = await canvas.findByLabelText("Message Claude", {}, { timeout: 8000 });
    await userEvent.click(textarea);
    await userEvent.type(textarea, "@", { delay: 50 });

    await waitFor(
      () => {
        const suggestionBox = document.querySelector("[data-command-suggestions]");
        if (!suggestionBox) throw new Error("Suggestions not visible");
      },
      { timeout: 8000 }
    );

    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  },
};

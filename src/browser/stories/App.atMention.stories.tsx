/**
 * File @ mention autocomplete stories
 *
 * Tests the @ mention file tagging UX:
 * - Typing @ triggers file suggestions
 * - Enter/Tab accepts selection
 * - Arrow keys navigate
 * - Esc dismisses
 * - Match highlighting
 * - File type indicators
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

    // Wait for the app to load - find the textarea by aria-label
    const textarea = await canvas.findByLabelText("Message Claude", {}, { timeout: 8000 });

    // Type @ to trigger file suggestions
    await userEvent.click(textarea);
    await userEvent.type(textarea, "@src");

    // Wait for file suggestions to appear
    await waitFor(
      () => {
        const suggestionBox = document.querySelector("[data-command-suggestions]");
        if (!suggestionBox) throw new Error("Suggestions not visible");
      },
      { timeout: 5000 }
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

    // Wait for app to load
    const textarea = await canvas.findByLabelText("Message Claude", {}, { timeout: 8000 });

    // Type a query that will match multiple files
    await userEvent.click(textarea);
    await userEvent.type(textarea, "@ChatInput");

    // Wait for suggestions with highlighted text
    await waitFor(
      () => {
        const suggestionBox = document.querySelector("[data-command-suggestions]");
        if (!suggestionBox) throw new Error("Suggestions not visible");
        // Check that highlighted text appears (the query should be highlighted)
        const highlighted = suggestionBox.querySelector(".text-light");
        if (!highlighted) throw new Error("No highlighted text found");
      },
      { timeout: 5000 }
    );

    // Double RAF for scroll stabilization
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

    // Wait for app to load
    const textarea = await canvas.findByLabelText("Message Claude", {}, { timeout: 8000 });

    // Type @ to trigger suggestions
    await userEvent.click(textarea);
    await userEvent.type(textarea, "@src");

    // Wait for suggestions
    await waitFor(
      () => {
        const suggestionBox = document.querySelector("[data-command-suggestions]");
        if (!suggestionBox) throw new Error("Suggestions not visible");
      },
      { timeout: 5000 }
    );

    // Navigate down twice with arrow keys
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{ArrowDown}");

    // Double RAF for scroll/visual update
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

    // Wait for app to load
    const textarea = await canvas.findByLabelText("Message Claude", {}, { timeout: 8000 });

    // Type @ (empty query shows all file types)
    await userEvent.click(textarea);
    await userEvent.type(textarea, "@");

    // Wait for suggestions with various file types
    await waitFor(
      () => {
        const suggestionBox = document.querySelector("[data-command-suggestions]");
        if (!suggestionBox) throw new Error("Suggestions not visible");
        // Check for different file type indicators
        const text = suggestionBox.textContent ?? "";
        if (!text.includes("TSX") && !text.includes("TS")) {
          throw new Error("File type indicators not showing");
        }
      },
      { timeout: 5000 }
    );

    // Double RAF
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  },
};

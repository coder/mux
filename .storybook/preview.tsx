import React from "react";
import type { Preview } from "@storybook/react-vite";
import { ThemeProvider, type ThemeMode } from "../src/browser/contexts/ThemeContext";
import "../src/browser/styles/globals.css";
import {
  TUTORIAL_STATE_KEY,
  RIGHT_SIDEBAR_COLLAPSED_KEY,
  type TutorialState,
} from "../src/common/constants/storage";
import { NOW } from "../src/browser/stories/mockFactory";

// Mock Date.now() globally for deterministic snapshots
// Components using Date.now() for elapsed time calculations need stable reference
Date.now = () => NOW;

// Disable tutorials by default in Storybook to prevent them from interfering with stories
// Individual stories can override this by setting localStorage before rendering
function disableTutorials() {
  if (typeof localStorage !== "undefined") {
    const disabledState: TutorialState = {
      disabled: true,
      completed: { settings: true, creation: true, workspace: true },
    };
    localStorage.setItem(TUTORIAL_STATE_KEY, JSON.stringify(disabledState));
  }
}

// Collapse right sidebar by default to ensure deterministic snapshots
// Stories that need expanded sidebar call expandRightSidebar() in their setup
function collapseRightSidebar() {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(RIGHT_SIDEBAR_COLLAPSED_KEY, JSON.stringify(true));
  }
}

const preview: Preview = {
  globalTypes: {
    theme: {
      name: "Theme",
      description: "Choose between light and dark UI themes",
      toolbar: {
        icon: "mirror",
        items: [
          { value: "dark", title: "Dark" },
          { value: "light", title: "Light" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    theme: "dark",
  },
  decorators: [
    // Theme provider
    (Story, context) => {
      // Default to dark if mode not set (e.g., Chromatic headless browser defaults to light)
      const mode = (context.globals.theme as ThemeMode | undefined) ?? "dark";

      // Apply theme synchronously before React renders - critical for Chromatic snapshots
      if (typeof document !== "undefined") {
        document.documentElement.dataset.theme = mode;
        document.documentElement.style.colorScheme = mode;
      }

      // Disable tutorials by default unless explicitly enabled for this story
      if (!context.parameters?.tutorialEnabled) {
        disableTutorials();
      }

      // Collapse right sidebar by default for deterministic snapshots
      // Stories can expand via expandRightSidebar() in setup after this runs
      collapseRightSidebar();

      return (
        <ThemeProvider forcedTheme={mode}>
          <Story />
        </ThemeProvider>
      );
    },
  ],
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    chromatic: {
      modes: {
        dark: { theme: "dark" },
        light: { theme: "light" },
      },
    },
  },
};

export default preview;

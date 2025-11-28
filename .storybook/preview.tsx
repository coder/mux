import React from "react";
import type { Preview } from "@storybook/react-vite";
import { ThemeProvider, type ThemeMode } from "../src/browser/contexts/ThemeContext";
import "../src/browser/styles/globals.css";

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
    (Story, context) => {
      // Default to dark if mode not set (e.g., Chromatic headless browser defaults to light)
      const mode = (context.globals.theme as ThemeMode | undefined) ?? "dark";

      // Apply theme synchronously before React renders - critical for Chromatic snapshots
      if (typeof document !== "undefined") {
        document.documentElement.dataset.theme = mode;
        document.documentElement.style.colorScheme = mode;
      }

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

import React, { useEffect } from "react";
import type { Preview } from "@storybook/react-vite";
import {
  ThemeProvider,
  useTheme,
  type ThemeMode,
} from "../src/browser/contexts/ThemeContext";
import "../src/browser/styles/globals.css";

const ThemeStorySync: React.FC<{ mode: ThemeMode }> = ({ mode }) => {
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    if (theme !== mode) {
      setTheme(mode);
    }
  }, [mode, setTheme, theme]);

  return null;
};

const preview: Preview = {
  globalTypes: {
    theme: {
      name: "Theme",
      description: "Choose between light and dark UI themes",
      defaultValue: "dark",
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
  decorators: [
    (Story, context) => {
      const mode = (context.globals.theme ?? "dark") as ThemeMode;
      return (
        <ThemeProvider>
          <ThemeStorySync mode={mode} />
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
        dark: { globals: { theme: "dark" } },
        light: { globals: { theme: "light" } },
      },
    },
  },
};

export default preview;

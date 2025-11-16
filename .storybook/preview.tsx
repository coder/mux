import type { Preview } from "@storybook/react-vite";
import { useEffect } from "react";
import "../src/browser/styles/globals.css";

const preview: Preview = {
  globalTypes: {
    theme: {
      description: "Global theme for components",
      defaultValue: "dark",
      toolbar: {
        title: "Theme",
        icon: "circlehollow",
        items: [
          { value: "light", title: "Light", icon: "sun" },
          { value: "dark", title: "Dark", icon: "moon" },
        ],
        dynamicTitle: true,
      },
    },
  },
  decorators: [
    (Story, context) => {
      const theme = context.globals.theme || "dark";

      useEffect(() => {
        // Apply theme to document root
        document.documentElement.dataset.theme = theme;
        
        // Also apply to body to ensure it persists
        document.body.dataset.theme = theme;
      }, [theme]);

      return (
        <div data-theme={theme} style={{ minHeight: "100vh", backgroundColor: "var(--color-background)", color: "var(--color-foreground)" }}>
          <Story />
        </div>
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
  },
};

export default preview;

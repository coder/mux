import type { StorybookConfig } from "@storybook/react-vite";
import { mergeConfig } from "vite";
import path from "path";

const config: StorybookConfig = {
  stories: ["../src/browser/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-links", "@storybook/addon-docs"],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  viteFinal: async (config) => {
    return mergeConfig(config, {
      // Inherit project aliases
      resolve: {
        alias: {
          "@": path.join(process.cwd(), "src"),
          // Note: VERSION mocking for stable visual testing is handled by overwriting
          // src/version.ts in the Chromatic CI workflow, not via alias here
        },
      },
      // Prevent Vite from discovering new deps mid-test and forcing a full reload (test-storybook
      // interprets reloads as navigations and flakes). Keep this list minimal.
      optimizeDeps: {
        include: ["@radix-ui/react-checkbox"],
      },
    });
  },
};

export default config;

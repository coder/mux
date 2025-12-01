/**
 * Shared Storybook meta configuration and wrapper components.
 *
 * All App stories share the same meta config and AppWithMocks wrapper
 * to ensure consistent setup across all story files.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import type { FC } from "react";
import { useRef } from "react";
import { AppLoader } from "../components/AppLoader";

// ═══════════════════════════════════════════════════════════════════════════════
// META CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

export const appMeta: Meta<typeof AppLoader> = {
  title: "App",
  component: AppLoader,
  parameters: {
    layout: "fullscreen",
    backgrounds: {
      default: "dark",
      values: [{ name: "dark", value: "#1e1e1e" }],
    },
  },
};

export type AppStory = StoryObj<typeof appMeta>;

// ═══════════════════════════════════════════════════════════════════════════════
// STORY WRAPPER
// ═══════════════════════════════════════════════════════════════════════════════

interface AppWithMocksProps {
  setup: () => void;
}

/** Wrapper that runs setup once before rendering */
export const AppWithMocks: FC<AppWithMocksProps> = ({ setup }) => {
  const initialized = useRef(false);
  if (!initialized.current) {
    setup();
    initialized.current = true;
  }
  return <AppLoader />;
};

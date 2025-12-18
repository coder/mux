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
import type { APIClient } from "@/browser/contexts/API";

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
  setup: () => APIClient;
}

/** Wrapper that runs setup once and passes the client to AppLoader */
function getStorybookStoryId(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const params = new URLSearchParams(window.location.search);
  return params.get("id") ?? params.get("path");
}

export const AppWithMocks: FC<AppWithMocksProps> = ({ setup }) => {
  const lastStoryIdRef = useRef<string | null>(null);
  const clientRef = useRef<APIClient | null>(null);

  const storyId = getStorybookStoryId();
  if (lastStoryIdRef.current !== storyId) {
    lastStoryIdRef.current = storyId;
    clientRef.current = setup();
  }

  clientRef.current ??= setup();

  return <AppLoader client={clientRef.current} />;
};

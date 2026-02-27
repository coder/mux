/**
 * Shared Storybook meta configuration and wrapper components.
 *
 * All App stories share the same meta config and AppWithMocks wrapper
 * to ensure consistent setup across all story files.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import type { FC } from "react";
import { useRef } from "react";
import { AppLoader } from "../components/AppLoader/AppLoader";
import { SELECTED_WORKSPACE_KEY, UI_THEME_KEY } from "@/common/constants/storage";
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
      values: [
        { name: "dark", value: "#1e1e1e" },
        { name: "light", value: "#f5f6f8" },
      ],
    },
    chromatic: { delay: 500 },
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

function resetStorybookPersistedStateForStory(): void {
  // Storybook/Chromatic can preserve localStorage across story captures.
  // Reset persisted state so each story starts from a known route + theme.
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(SELECTED_WORKSPACE_KEY);
    localStorage.setItem(UI_THEME_KEY, JSON.stringify("dark"));
  }
}
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
  const shouldReset = clientRef.current === null || lastStoryIdRef.current !== storyId;
  if (shouldReset) {
    resetStorybookPersistedStateForStory();
    lastStoryIdRef.current = storyId;
    clientRef.current = null;
  }

  clientRef.current ??= setup();

  // Key by storyId to force full remount between stories.
  // Without this, RouterProvider keeps its initial route and APIProvider
  // doesn't re-initialize, causing flaky "loading page vs left screen" states.
  return <AppLoader key={storyId} client={clientRef.current} />;
};

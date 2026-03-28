import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import type { APIClient } from "@/browser/contexts/API";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import {
  DEFAULT_CODER_ARCHIVE_BEHAVIOR,
  type CoderWorkspaceArchiveBehavior,
} from "@/common/config/coderArchiveBehavior";

interface MockAPIContextValue {
  api: APIClient;
  status: "connected";
  error: null;
  authenticate: () => void;
  retry: () => void;
}

const MockAPIContext = createContext<MockAPIContextValue | null>(null);

void mock.module("@/browser/contexts/API", () => ({
  APIProvider: (props: { client?: APIClient; children: ReactNode }) => {
    if (!props.client) {
      throw new Error("GeneralSection tests require an API client");
    }

    return (
      <MockAPIContext.Provider
        value={{
          api: props.client,
          status: "connected",
          error: null,
          authenticate: () => undefined,
          retry: () => undefined,
        }}
      >
        {props.children}
      </MockAPIContext.Provider>
    );
  },
  useAPI: () => {
    const context = useContext(MockAPIContext);
    if (!context) {
      throw new Error("useAPI must be used within the mocked APIProvider");
    }
    return context;
  },
}));

import { GeneralSection } from "./GeneralSection";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils";

interface RenderGeneralSectionOptions {
  coderWorkspaceArchiveBehavior?: CoderWorkspaceArchiveBehavior;
  deleteWorktreeOnArchive?: boolean;
}

describe("GeneralSection", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalNavigator: typeof globalThis.navigator;
  let originalLocalStorage: Storage;
  let originalStorageEvent: typeof globalThis.StorageEvent;
  let originalCustomEvent: typeof globalThis.CustomEvent;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalNavigator = globalThis.navigator;
    originalLocalStorage = globalThis.localStorage;
    originalStorageEvent = globalThis.StorageEvent;
    originalCustomEvent = globalThis.CustomEvent;

    const window = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
      typeof globalThis;

    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.navigator = window.navigator;
    globalThis.localStorage = window.localStorage;
    globalThis.StorageEvent = window.StorageEvent as unknown as typeof StorageEvent;
    globalThis.CustomEvent = window.CustomEvent as unknown as typeof CustomEvent;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.navigator = originalNavigator;
    globalThis.localStorage = originalLocalStorage;
    globalThis.StorageEvent = originalStorageEvent;
    globalThis.CustomEvent = originalCustomEvent;
  });

  function renderGeneralSection(options: RenderGeneralSectionOptions = {}) {
    const api = setupSettingsStory({});
    const originalGetConfig = api.config.getConfig;
    api.config.getConfig = async () => {
      const config = await originalGetConfig();
      return {
        ...config,
        coderWorkspaceArchiveBehavior:
          options.coderWorkspaceArchiveBehavior ?? config.coderWorkspaceArchiveBehavior,
        deleteWorktreeOnArchive: options.deleteWorktreeOnArchive ?? config.deleteWorktreeOnArchive,
      };
    };

    const originalUpdateCoderPrefs = api.config.updateCoderPrefs;
    const updateCoderPrefsMock = mock(
      (input: {
        coderWorkspaceArchiveBehavior: CoderWorkspaceArchiveBehavior;
        deleteWorktreeOnArchive: boolean;
      }) => originalUpdateCoderPrefs(input)
    );
    api.config.updateCoderPrefs = updateCoderPrefsMock;

    const view = render(
      <ThemeProvider forcedTheme="dark">
        <SettingsSectionStory setup={() => api}>
          <GeneralSection />
        </SettingsSectionStory>
      </ThemeProvider>
    );

    return { updateCoderPrefsMock, view };
  }

  test("renders the delete worktree on archive copy and loads the saved value", async () => {
    const { view } = renderGeneralSection({
      coderWorkspaceArchiveBehavior: "delete",
      deleteWorktreeOnArchive: true,
    });

    expect(view.getByText("Delete worktree on archive")).toBeTruthy();
    expect(
      view.getByText(/When enabled, mux-managed worktrees are deleted when archiving a workspace/i)
    ).toBeTruthy();

    const toggle = view.getByRole("switch", { name: "Toggle Delete worktree on archive" });
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("true");
    });
  });

  test("persists the toggle with the current archive behavior", async () => {
    const { updateCoderPrefsMock, view } = renderGeneralSection({
      coderWorkspaceArchiveBehavior: "delete",
      deleteWorktreeOnArchive: false,
    });

    const toggle = view.getByRole("switch", { name: "Toggle Delete worktree on archive" });
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("false");
    });

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(updateCoderPrefsMock).toHaveBeenCalledWith({
        coderWorkspaceArchiveBehavior: "delete",
        deleteWorktreeOnArchive: true,
      });
    });

    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  test("keeps the delete-worktree toggle after the user changes it before config finishes loading", async () => {
    const api = setupSettingsStory({});
    const originalGetConfig = api.config.getConfig;
    const loadedConfig = await originalGetConfig();
    let resolveGetConfig: ((value: typeof loadedConfig) => void) | undefined;
    api.config.getConfig = mock(
      () =>
        new Promise<typeof loadedConfig>((resolve) => {
          resolveGetConfig = resolve;
        })
    );

    const originalUpdateCoderPrefs = api.config.updateCoderPrefs;
    const updateCoderPrefsMock = mock(
      (input: {
        coderWorkspaceArchiveBehavior: CoderWorkspaceArchiveBehavior;
        deleteWorktreeOnArchive: boolean;
      }) => originalUpdateCoderPrefs(input)
    );
    api.config.updateCoderPrefs = updateCoderPrefsMock;

    const view = render(
      <ThemeProvider forcedTheme="dark">
        <SettingsSectionStory setup={() => api}>
          <GeneralSection />
        </SettingsSectionStory>
      </ThemeProvider>
    );

    const toggle = view.getByRole("switch", { name: "Toggle Delete worktree on archive" });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(updateCoderPrefsMock).toHaveBeenCalledWith({
        coderWorkspaceArchiveBehavior: DEFAULT_CODER_ARCHIVE_BEHAVIOR,
        deleteWorktreeOnArchive: true,
      });
    });

    resolveGetConfig?.({
      ...loadedConfig,
      deleteWorktreeOnArchive: false,
    });

    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("true");
    });
  });
});

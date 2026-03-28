import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import type { CoderWorkspaceArchiveBehavior } from "@/common/config/coderArchiveBehavior";
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

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalNavigator = globalThis.navigator;
    originalLocalStorage = globalThis.localStorage;

    const window = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
      typeof globalThis;

    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.navigator = window.navigator;
    globalThis.localStorage = window.localStorage;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.navigator = originalNavigator;
    globalThis.localStorage = originalLocalStorage;
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
});

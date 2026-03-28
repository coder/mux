import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import {
  DEFAULT_CODER_ARCHIVE_BEHAVIOR,
  type CoderWorkspaceArchiveBehavior,
} from "@/common/config/coderArchiveBehavior";

interface MockConfig {
  coderWorkspaceArchiveBehavior: CoderWorkspaceArchiveBehavior;
  deleteWorktreeOnArchive: boolean;
  llmDebugLogs: boolean;
}

interface MockAPIClient {
  config: {
    getConfig: () => Promise<MockConfig>;
    updateCoderPrefs: (input: {
      coderWorkspaceArchiveBehavior: CoderWorkspaceArchiveBehavior;
      deleteWorktreeOnArchive: boolean;
    }) => Promise<void>;
    updateLlmDebugLogs: (input: { enabled: boolean }) => Promise<void>;
  };
  server: {
    getSshHost: () => Promise<string | null>;
    setSshHost: (input: { sshHost: string | null }) => Promise<void>;
  };
  projects: {
    getDefaultProjectDir: () => Promise<string>;
    setDefaultProjectDir: (input: { path: string }) => Promise<void>;
  };
}

let mockApi: MockAPIClient;

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: mockApi,
    status: "connected" as const,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

import { GeneralSection } from "./GeneralSection";

interface RenderGeneralSectionOptions {
  coderWorkspaceArchiveBehavior?: CoderWorkspaceArchiveBehavior;
  deleteWorktreeOnArchive?: boolean;
}

interface MockAPISetup {
  api: MockAPIClient;
  getConfigMock: ReturnType<typeof mock<() => Promise<MockConfig>>>;
  updateCoderPrefsMock: ReturnType<
    typeof mock<
      (input: {
        coderWorkspaceArchiveBehavior: CoderWorkspaceArchiveBehavior;
        deleteWorktreeOnArchive: boolean;
      }) => Promise<void>
    >
  >;
}

function createCustomEventPolyfill(
  window: Window & typeof globalThis
): typeof globalThis.CustomEvent {
  class CustomEventPolyfill<T = unknown> extends window.Event implements CustomEvent<T> {
    detail: T;

    constructor(type: string, params?: CustomEventInit<T>) {
      super(type, params);
      this.detail = params?.detail as T;
    }

    initCustomEvent(type: string, bubbles?: boolean, cancelable?: boolean, detail?: T): void {
      this.initEvent(type, bubbles ?? false, cancelable ?? false);
      this.detail = detail as T;
    }
  }

  return CustomEventPolyfill as unknown as typeof globalThis.CustomEvent;
}

function createMockAPI(configOverrides: Partial<MockConfig> = {}): MockAPISetup {
  const config: MockConfig = {
    coderWorkspaceArchiveBehavior: DEFAULT_CODER_ARCHIVE_BEHAVIOR,
    deleteWorktreeOnArchive: false,
    llmDebugLogs: false,
    ...configOverrides,
  };

  const getConfigMock = mock(() => Promise.resolve({ ...config }));
  const updateCoderPrefsMock = mock(
    (input: {
      coderWorkspaceArchiveBehavior: CoderWorkspaceArchiveBehavior;
      deleteWorktreeOnArchive: boolean;
    }) => {
      config.coderWorkspaceArchiveBehavior = input.coderWorkspaceArchiveBehavior;
      config.deleteWorktreeOnArchive = input.deleteWorktreeOnArchive;

      return Promise.resolve();
    }
  );

  return {
    api: {
      config: {
        getConfig: getConfigMock,
        updateCoderPrefs: updateCoderPrefsMock,
        updateLlmDebugLogs: mock(({ enabled }: { enabled: boolean }) => {
          config.llmDebugLogs = enabled;

          return Promise.resolve();
        }),
      },
      server: {
        getSshHost: mock(() => Promise.resolve(null)),
        setSshHost: mock((_input: { sshHost: string | null }) => Promise.resolve()),
      },
      projects: {
        getDefaultProjectDir: mock(() => Promise.resolve("")),
        setDefaultProjectDir: mock((_input: { path: string }) => Promise.resolve()),
      },
    },
    getConfigMock,
    updateCoderPrefsMock,
  };
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
    const customEvent = window.CustomEvent ?? createCustomEventPolyfill(window);

    Object.defineProperty(window, "CustomEvent", {
      value: customEvent,
      configurable: true,
      writable: true,
    });

    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.navigator = window.navigator;
    globalThis.localStorage = window.localStorage;
    globalThis.StorageEvent = window.StorageEvent as unknown as typeof StorageEvent;
    globalThis.CustomEvent = customEvent;
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.navigator = originalNavigator;
    globalThis.localStorage = originalLocalStorage;
    globalThis.StorageEvent = originalStorageEvent;
    globalThis.CustomEvent = originalCustomEvent;
  });

  function renderGeneralSection(options: RenderGeneralSectionOptions = {}) {
    const { api, updateCoderPrefsMock } = createMockAPI({
      coderWorkspaceArchiveBehavior: options.coderWorkspaceArchiveBehavior,
      deleteWorktreeOnArchive: options.deleteWorktreeOnArchive,
    });
    mockApi = api;

    const view = render(
      <ThemeProvider forcedTheme="dark">
        <GeneralSection />
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

  test("serializes rapid delete-worktree toggle writes so only the latest value is persisted", async () => {
    const { api, updateCoderPrefsMock } = createMockAPI();
    let resolveFirstUpdate: (() => void) | undefined;
    let resolveSecondUpdate: (() => void) | undefined;

    api.config.updateCoderPrefs = updateCoderPrefsMock.mockImplementation(
      ({
        coderWorkspaceArchiveBehavior: _coderWorkspaceArchiveBehavior,
        deleteWorktreeOnArchive: _deleteWorktreeOnArchive,
      }: {
        coderWorkspaceArchiveBehavior: CoderWorkspaceArchiveBehavior;
        deleteWorktreeOnArchive: boolean;
      }) =>
        new Promise<void>((resolve) => {
          if (!resolveFirstUpdate) {
            resolveFirstUpdate = resolve;
            return;
          }

          resolveSecondUpdate = resolve;
        })
    );
    mockApi = api;

    const view = render(
      <ThemeProvider forcedTheme="dark">
        <GeneralSection />
      </ThemeProvider>
    );

    const toggle = view.getByRole("switch", { name: "Toggle Delete worktree on archive" });
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("false");
    });

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(updateCoderPrefsMock).toHaveBeenCalledTimes(1);
      expect(updateCoderPrefsMock).toHaveBeenNthCalledWith(1, {
        coderWorkspaceArchiveBehavior: DEFAULT_CODER_ARCHIVE_BEHAVIOR,
        deleteWorktreeOnArchive: true,
      });
    });

    fireEvent.click(toggle);
    expect(updateCoderPrefsMock).toHaveBeenCalledTimes(1);

    resolveFirstUpdate?.();

    await waitFor(() => {
      expect(updateCoderPrefsMock).toHaveBeenCalledTimes(2);
      expect(updateCoderPrefsMock).toHaveBeenNthCalledWith(2, {
        coderWorkspaceArchiveBehavior: DEFAULT_CODER_ARCHIVE_BEHAVIOR,
        deleteWorktreeOnArchive: false,
      });
    });

    resolveSecondUpdate?.();

    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("false");
    });
  });

  test("re-enables archive settings with defaults after config load errors", async () => {
    const { api, updateCoderPrefsMock } = createMockAPI({
      deleteWorktreeOnArchive: false,
    });
    let rejectGetConfig: ((error?: unknown) => void) | undefined;
    api.config.getConfig = mock(
      () =>
        new Promise<MockConfig>((_resolve, reject) => {
          rejectGetConfig = reject;
        })
    );
    mockApi = api;

    const view = render(
      <ThemeProvider forcedTheme="dark">
        <GeneralSection />
      </ThemeProvider>
    );

    await waitFor(() => {
      expect(rejectGetConfig).toBeDefined();
    });

    const toggle = view.getByRole("switch", { name: "Toggle Delete worktree on archive" });
    expect(toggle.hasAttribute("disabled")).toBe(true);

    rejectGetConfig?.(new Error("config read failed"));

    await waitFor(() => {
      expect(toggle.hasAttribute("disabled")).toBe(false);
    });

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(updateCoderPrefsMock).toHaveBeenCalledWith({
        coderWorkspaceArchiveBehavior: DEFAULT_CODER_ARCHIVE_BEHAVIOR,
        deleteWorktreeOnArchive: true,
      });
    });
  });

  test("disables archive settings until config finishes loading", async () => {
    const { api, getConfigMock, updateCoderPrefsMock } = createMockAPI({
      deleteWorktreeOnArchive: false,
    });
    const loadedConfig = await getConfigMock();
    let resolveGetConfig: ((value: MockConfig) => void) | undefined;
    api.config.getConfig = mock(
      () =>
        new Promise<MockConfig>((resolve) => {
          resolveGetConfig = resolve;
        })
    );
    mockApi = api;

    const view = render(
      <ThemeProvider forcedTheme="dark">
        <GeneralSection />
      </ThemeProvider>
    );

    await waitFor(() => {
      expect(resolveGetConfig).toBeDefined();
    });

    const toggle = view.getByRole("switch", { name: "Toggle Delete worktree on archive" });
    expect(toggle.hasAttribute("disabled")).toBe(true);

    fireEvent.click(toggle);
    expect(updateCoderPrefsMock).not.toHaveBeenCalled();
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    resolveGetConfig?.({
      ...loadedConfig,
      coderWorkspaceArchiveBehavior: "delete",
      deleteWorktreeOnArchive: false,
    });

    await waitFor(() => {
      expect(updateCoderPrefsMock).not.toHaveBeenCalled();
      expect(toggle.getAttribute("aria-checked")).toBe("false");
    });
  });
});

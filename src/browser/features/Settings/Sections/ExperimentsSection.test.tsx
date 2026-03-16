import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";

type PrereqStatus =
  | { available: true }
  | { available: false; reason: "binary_not_found" | "unsupported_platform" | "startup_failed" };

interface MockApiClient {
  desktop: {
    getPrereqStatus: () => Promise<PrereqStatus>;
  };
  general: {
    restartApp: () => Promise<{ supported: true } | { supported: false; message: string }>;
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let mockApi: MockApiClient;
let experimentEnabled = false;

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: mockApi,
    status: "connected" as const,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

void mock.module("@/browser/contexts/ExperimentsContext", () => ({
  useExperimentValue: () => experimentEnabled,
}));

import { PortableDesktopExperimentWarning } from "./ExperimentsSection";

let originalWindow: typeof globalThis.window;
let originalDocument: typeof globalThis.document;
let originalLocalStorage: typeof globalThis.localStorage;
let originalLocation: typeof globalThis.location;
let originalStorageEvent: typeof globalThis.StorageEvent;
let originalCustomEvent: typeof globalThis.CustomEvent;
let originalSetTimeout: typeof globalThis.setTimeout;
let originalClearTimeout: typeof globalThis.clearTimeout;
let originalSetInterval: typeof globalThis.setInterval;
let originalClearInterval: typeof globalThis.clearInterval;

function renderWarning() {
  return render(<PortableDesktopExperimentWarning />);
}

describe("PortableDesktopExperimentWarning", () => {
  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalLocalStorage = globalThis.localStorage;
    originalLocation = globalThis.location;
    originalStorageEvent = globalThis.StorageEvent;
    originalCustomEvent = globalThis.CustomEvent;
    originalSetTimeout = globalThis.setTimeout;
    originalClearTimeout = globalThis.clearTimeout;
    originalSetInterval = globalThis.setInterval;
    originalClearInterval = globalThis.clearInterval;

    const dom = new GlobalWindow({ url: "https://example.com/settings/experiments" });
    globalThis.window = dom as unknown as Window & typeof globalThis;
    globalThis.document = dom.document as unknown as Document;
    globalThis.localStorage = dom.localStorage;
    globalThis.location = dom.location as unknown as Location;
    globalThis.StorageEvent = dom.StorageEvent as unknown as typeof StorageEvent;
    globalThis.CustomEvent = dom.CustomEvent as unknown as typeof CustomEvent;
    globalThis.setTimeout = dom.setTimeout.bind(dom) as unknown as typeof globalThis.setTimeout;
    globalThis.clearTimeout = dom.clearTimeout.bind(
      dom
    ) as unknown as typeof globalThis.clearTimeout;
    globalThis.setInterval = dom.setInterval.bind(dom) as unknown as typeof globalThis.setInterval;
    globalThis.clearInterval = dom.clearInterval.bind(
      dom
    ) as unknown as typeof globalThis.clearInterval;

    globalThis.window.api = { platform: "linux", versions: {} };
    experimentEnabled = true;
    mockApi = {
      desktop: {
        getPrereqStatus: mock(() => Promise.resolve({ available: true as const })),
      },
      general: {
        restartApp: mock(() => Promise.resolve({ supported: true as const })),
      },
    };
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
    globalThis.location = originalLocation;
    globalThis.StorageEvent = originalStorageEvent;
    globalThis.CustomEvent = originalCustomEvent;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });

  test("loads prereq status on mount and shows the missing-binary warning when needed", async () => {
    const getPrereqStatus = mock(() =>
      Promise.resolve({ available: false as const, reason: "binary_not_found" as const })
    );
    mockApi = {
      desktop: { getPrereqStatus },
      general: {
        restartApp: mock(() => Promise.resolve({ supported: true as const })),
      },
    };

    const view = renderWarning();

    await waitFor(() => {
      expect(getPrereqStatus).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(view.container.textContent).toContain("Portable Desktop is currently disabled");
    });
  });

  test("clicking Check again re-runs the prereq lookup and hides the warning after recovery", async () => {
    let callCount = 0;
    const getPrereqStatus = mock(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve({ available: false as const, reason: "binary_not_found" as const });
      }

      return Promise.resolve({ available: true as const });
    });
    mockApi = {
      desktop: { getPrereqStatus },
      general: {
        restartApp: mock(() => Promise.resolve({ supported: true as const })),
      },
    };

    const view = renderWarning();

    await waitFor(() => {
      expect(view.container.textContent).toContain("Portable Desktop is currently disabled");
    });

    fireEvent.click(view.getByRole("button", { name: "Check again" }));

    await waitFor(() => {
      expect(getPrereqStatus).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(view.container.textContent).not.toContain("Portable Desktop is currently disabled");
    });
  });

  test("ignores stale Check again responses when a newer lookup finishes later", async () => {
    const staleRequest = createDeferred<PrereqStatus>();
    const freshRequest = createDeferred<PrereqStatus>();
    let callCount = 0;
    const getPrereqStatus = mock(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve({ available: false as const, reason: "binary_not_found" as const });
      }
      if (callCount === 2) {
        return staleRequest.promise;
      }
      if (callCount === 3) {
        return freshRequest.promise;
      }
      return Promise.resolve({ available: true as const });
    });
    mockApi = {
      desktop: { getPrereqStatus },
      general: {
        restartApp: mock(() => Promise.resolve({ supported: true as const })),
      },
    };

    const view = renderWarning();

    await waitFor(() => {
      expect(view.container.textContent).toContain("Portable Desktop is currently disabled");
    });

    const checkAgainButton = view.getByRole("button", { name: "Check again" });
    fireEvent.click(checkAgainButton);
    fireEvent.click(checkAgainButton);

    await waitFor(() => {
      expect(getPrereqStatus).toHaveBeenCalledTimes(3);
    });

    await act(async () => {
      freshRequest.resolve({ available: true as const });
      await freshRequest.promise;
    });

    await waitFor(() => {
      expect(view.container.textContent).not.toContain("Portable Desktop is currently disabled");
    });

    await act(async () => {
      staleRequest.resolve({ available: false as const, reason: "binary_not_found" as const });
      await staleRequest.promise;
    });

    expect(view.container.textContent).not.toContain("Portable Desktop is currently disabled");
  });

  test("keeps the restart path available when re-check still reports a missing binary", async () => {
    const getPrereqStatus = mock(() =>
      Promise.resolve({ available: false as const, reason: "binary_not_found" as const })
    );
    const restartApp = mock(() => Promise.resolve({ supported: true as const }));
    mockApi = {
      desktop: { getPrereqStatus },
      general: { restartApp },
    };

    const view = renderWarning();

    await waitFor(() => {
      expect(view.container.textContent).toContain("Portable Desktop is currently disabled");
    });

    fireEvent.click(view.getByRole("button", { name: "Check again" }));

    await waitFor(() => {
      expect(getPrereqStatus).toHaveBeenCalledTimes(2);
    });
    expect(view.getByRole("button", { name: "Restart Mux" })).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Restart Mux" }));

    await waitFor(() => {
      expect(restartApp).toHaveBeenCalledTimes(1);
    });
  });

  test("shows a graceful message when restart is unavailable in this runtime", async () => {
    const getPrereqStatus = mock(() =>
      Promise.resolve({ available: false as const, reason: "binary_not_found" as const })
    );
    const restartApp = mock(() =>
      Promise.resolve({
        supported: false as const,
        message: "Restart is only available in the desktop app.",
      })
    );
    mockApi = {
      desktop: { getPrereqStatus },
      general: { restartApp },
    };

    const view = renderWarning();

    await waitFor(() => {
      expect(view.container.textContent).toContain("Portable Desktop is currently disabled");
    });

    fireEvent.click(view.getByRole("button", { name: "Restart Mux" }));

    await waitFor(() => {
      expect(view.container.textContent).toContain("Restart is only available in the desktop app.");
    });
  });

  test("keeps the warning hidden when Portable Desktop prerequisites are available", async () => {
    const getPrereqStatus = mock(() => Promise.resolve({ available: true as const }));
    mockApi = {
      desktop: { getPrereqStatus },
      general: {
        restartApp: mock(() => Promise.resolve({ supported: true as const })),
      },
    };

    const view = renderWarning();

    await waitFor(() => {
      expect(getPrereqStatus).toHaveBeenCalledTimes(1);
    });
    expect(view.container.textContent).not.toContain("Portable Desktop is currently disabled");
  });
});

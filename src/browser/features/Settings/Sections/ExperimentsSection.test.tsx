import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";

type PrereqStatus =
  | { available: true }
  | { available: false; reason: "binary_not_found" | "unsupported_platform" | "unknown" };

interface MockApiClient {
  desktop: {
    getPrereqStatus: () => Promise<PrereqStatus>;
  };
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

  test("shows the missing-binary warning on the settings route when Portable Desktop is enabled", async () => {
    const getPrereqStatus = mock(() =>
      Promise.resolve({ available: false as const, reason: "binary_not_found" as const })
    );
    experimentEnabled = true;
    mockApi = {
      desktop: {
        getPrereqStatus,
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

  test("keeps the warning hidden when Portable Desktop prerequisites are available", async () => {
    const getPrereqStatus = mock(() => Promise.resolve({ available: true as const }));
    experimentEnabled = true;
    mockApi = {
      desktop: {
        getPrereqStatus,
      },
    };

    const view = renderWarning();

    await waitFor(() => {
      expect(getPrereqStatus).toHaveBeenCalledTimes(1);
    });
    expect(view.container.textContent).not.toContain("Portable Desktop is currently disabled");
  });
});

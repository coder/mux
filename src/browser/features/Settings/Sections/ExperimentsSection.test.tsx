import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { ExperimentsProvider } from "@/browser/contexts/ExperimentsContext";
import { EXPERIMENT_IDS, getExperimentKey } from "@/common/constants/experiments";
import type { RecursivePartial } from "@/browser/testUtils";
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

function renderWarning(client: RecursivePartial<APIClient>) {
  return render(
    <APIProvider client={client as APIClient}>
      <ExperimentsProvider>
        <PortableDesktopExperimentWarning />
      </ExperimentsProvider>
    </APIProvider>
  );
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
    globalThis.localStorage.setItem(
      getExperimentKey(EXPERIMENT_IDS.PORTABLE_DESKTOP),
      JSON.stringify(true)
    );
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

    const view = renderWarning({
      desktop: {
        getPrereqStatus,
      },
      experiments: {
        getAll: mock(() => Promise.resolve({})),
        reload: mock(() => Promise.resolve()),
        setOverride: mock(() => Promise.resolve()),
      },
    });

    await waitFor(() => {
      expect(getPrereqStatus).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(view.container.textContent).toContain("Portable Desktop is currently disabled");
    });
  });

  test("keeps the warning hidden when Portable Desktop prerequisites are available", async () => {
    const getPrereqStatus = mock(() => Promise.resolve({ available: true as const }));

    const view = renderWarning({
      desktop: {
        getPrereqStatus,
      },
      experiments: {
        getAll: mock(() => Promise.resolve({})),
        reload: mock(() => Promise.resolve()),
        setOverride: mock(() => Promise.resolve()),
      },
    });

    await waitFor(() => {
      expect(getPrereqStatus).toHaveBeenCalledTimes(1);
    });
    expect(view.container.textContent).not.toContain("Portable Desktop is currently disabled");
  });
});

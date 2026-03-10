import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GlobalWindow } from "happy-dom";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { ExperimentValue } from "@/common/orpc/types";
import type { APIClient } from "./API";
import type { RecursivePartial } from "@/browser/testUtils";

// Keep the API client local to each render so this suite does not leak a process-global
// mock.module override into ProjectContext and other later context tests.
let currentClientMock: RecursivePartial<APIClient> = {};

let APIProvider!: typeof import("./API").APIProvider;
let ExperimentsProvider!: typeof import("./ExperimentsContext").ExperimentsProvider;
let useExperimentValue!: typeof import("./ExperimentsContext").useExperimentValue;
let isolatedModuleDir: string | null = null;

const contextsDir = dirname(fileURLToPath(import.meta.url));

// Import unique temp copies of the real modules so leaked Bun mock.module registrations and
// module cache entries from earlier suites cannot replace the API/Experiments implementations.
async function importIsolatedExperimentModules() {
  const tempDir = await mkdtemp(join(contextsDir, ".experiments-context-test-"));
  const isolatedApiPath = join(tempDir, "API.real.tsx");
  const isolatedExperimentsPath = join(tempDir, "ExperimentsContext.real.tsx");

  await copyFile(join(contextsDir, "API.tsx"), isolatedApiPath);

  const experimentsSource = await readFile(join(contextsDir, "ExperimentsContext.tsx"), "utf8");
  const isolatedExperimentsSource = experimentsSource.replace(
    'from "@/browser/contexts/API";',
    'from "./API.real.tsx";'
  );

  if (isolatedExperimentsSource === experimentsSource) {
    throw new Error("Failed to rewrite ExperimentsContext API import for the isolated test copy");
  }

  await writeFile(isolatedExperimentsPath, isolatedExperimentsSource);

  ({ APIProvider } = await import(pathToFileURL(isolatedApiPath).href));
  ({ ExperimentsProvider, useExperimentValue } = await import(
    pathToFileURL(isolatedExperimentsPath).href
  ));

  return tempDir;
}

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

describe("ExperimentsProvider", () => {
  beforeEach(async () => {
    isolatedModuleDir = await importIsolatedExperimentModules();

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

    const dom = new GlobalWindow({ url: "https://example.com/" });
    globalThis.window = dom as unknown as Window & typeof globalThis;
    globalThis.document = dom.document as unknown as Document;

    // Broader browser runs can leave bare globals, event constructors, and timer functions pointed
    // at stale or fake implementations from earlier suites. Rebind the globals
    // ExperimentsProvider reaches through indirectly so the polling test always exercises the fresh
    // happy-dom window installed for this case.
    globalThis.localStorage = dom.localStorage;
    globalThis.location = dom.location as unknown as Location;
    globalThis.StorageEvent = dom.StorageEvent as unknown as typeof StorageEvent;
    globalThis.CustomEvent = dom.CustomEvent as unknown as typeof CustomEvent;
    globalThis.setTimeout = dom.setTimeout.bind(dom);
    globalThis.clearTimeout = dom.clearTimeout.bind(dom);
    globalThis.setInterval = dom.setInterval.bind(dom);
    globalThis.clearInterval = dom.clearInterval.bind(dom);
    globalThis.localStorage.clear();
  });

  afterEach(async () => {
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
    currentClientMock = {};

    if (isolatedModuleDir) {
      await rm(isolatedModuleDir, { recursive: true, force: true });
      isolatedModuleDir = null;
    }
  });

  test("polls getAll until remote variants are available", async () => {
    let callCount = 0;

    const getAllMock = mock(() => {
      callCount += 1;

      if (callCount === 1) {
        return Promise.resolve({
          [EXPERIMENT_IDS.SYSTEM_1]: { value: null, source: "cache" },
        } satisfies Record<string, ExperimentValue>);
      }

      return Promise.resolve({
        [EXPERIMENT_IDS.SYSTEM_1]: { value: "test", source: "posthog" },
      } satisfies Record<string, ExperimentValue>);
    });

    currentClientMock = {
      experiments: {
        getAll: getAllMock,
        reload: mock(() => Promise.resolve()),
      },
    };

    let scheduledPoll: (() => void) | null = null;
    const expectedInitialPollDelayMs = 100;
    const scheduledPollHandle = Symbol("scheduled-poll") as ReturnType<typeof setTimeout>;

    // Capture the provider's first poll callback so this assertion does not depend on whichever
    // timer implementation earlier suites left behind.
    globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
      if (delay === expectedInitialPollDelayMs && typeof callback === "function") {
        scheduledPoll = callback;
        return scheduledPollHandle;
      }

      return originalSetTimeout(callback, delay);
    }) as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((timeout: ReturnType<typeof setTimeout>) => {
      if (timeout === scheduledPollHandle) {
        scheduledPoll = null;
        return;
      }

      originalClearTimeout(timeout);
    }) as typeof globalThis.clearTimeout;

    function Observer() {
      const enabled = useExperimentValue(EXPERIMENT_IDS.SYSTEM_1);
      return <div data-testid="enabled">{String(enabled)}</div>;
    }

    const { getByTestId } = render(
      <APIProvider client={currentClientMock as APIClient}>
        <ExperimentsProvider>
          <Observer />
        </ExperimentsProvider>
      </APIProvider>
    );

    expect(getByTestId("enabled").textContent).toBe("false");

    await waitFor(() => {
      expect(scheduledPoll).not.toBeNull();
    });

    const pollRemoteExperiments = scheduledPoll;
    expect(pollRemoteExperiments).not.toBeNull();

    await act(async () => {
      pollRemoteExperiments?.();
    });

    await waitFor(() => {
      expect(getByTestId("enabled").textContent).toBe("true");
    });

    expect(getAllMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("syncs existing local overrides to the backend on connect", async () => {
    globalThis.window.localStorage.setItem(
      getExperimentKey(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES),
      JSON.stringify(true)
    );

    const setOverrideMock = mock(() => Promise.resolve());
    currentClientMock = {
      experiments: {
        getAll: mock(() => Promise.resolve({} satisfies Record<string, ExperimentValue>)),
        setOverride: setOverrideMock,
        reload: mock(() => Promise.resolve()),
      },
    };

    render(
      <ExperimentsProvider>
        <div />
      </ExperimentsProvider>
    );

    await waitFor(() => {
      expect(setOverrideMock).toHaveBeenCalledWith({
        experimentId: EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES,
        enabled: true,
      });
    });
  });

  test("persists backend overrides when a user toggles an experiment", async () => {
    const setOverrideMock = mock(() => Promise.resolve());
    currentClientMock = {
      experiments: {
        getAll: mock(() => Promise.resolve({} satisfies Record<string, ExperimentValue>)),
        setOverride: setOverrideMock,
        reload: mock(() => Promise.resolve()),
      },
    };

    function Toggle() {
      const [enabled, setEnabled] = useExperiment(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES);
      return (
        <button data-testid="toggle" onClick={() => setEnabled(!enabled)}>
          {String(enabled)}
        </button>
      );
    }

    const { getByTestId } = render(
      <ExperimentsProvider>
        <Toggle />
      </ExperimentsProvider>
    );

    fireEvent.click(getByTestId("toggle"));

    await waitFor(() => {
      expect(setOverrideMock).toHaveBeenCalledWith({
        experimentId: EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES,
        enabled: true,
      });
      expect(getByTestId("toggle").textContent).toBe("true");
    });
  });
});

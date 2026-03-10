import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { ExperimentsProvider, useExperiment, useExperimentValue } from "./ExperimentsContext";
import { EXPERIMENT_IDS, getExperimentKey } from "@/common/constants/experiments";
import type { ExperimentValue } from "@/common/orpc/types";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import type { RecursivePartial } from "@/browser/testUtils";

// Keep the API client local to each render so this suite does not leak a process-global
// mock.module override into ProjectContext and other later context tests.
let currentClientMock: RecursivePartial<APIClient> = {};

describe("ExperimentsProvider", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
    currentClientMock = {};
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

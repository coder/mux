import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { ExperimentsProvider, useExperimentValue } from "./ExperimentsContext";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { ExperimentValue } from "@/common/orpc/types";
import type { APIClient } from "@/browser/contexts/API";
import type { RecursivePartial } from "@/browser/testUtils";

let currentClientMock: RecursivePartial<APIClient> = {};
void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: currentClientMock as APIClient,
    status: "connected" as const,
    error: null,
  }),
  APIProvider: ({ children }: { children: React.ReactNode }) => children,
}));

describe("ExperimentsProvider", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
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
      <ExperimentsProvider>
        <Observer />
      </ExperimentsProvider>
    );

    expect(getByTestId("enabled").textContent).toBe("false");

    await waitFor(() => {
      expect(getByTestId("enabled").textContent).toBe("true");
    });

    expect(getAllMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

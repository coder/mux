import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { installDom } from "../../../tests/ui/dom";

import {
  subscribePersistedStateWrites,
  syncPersistedStateFromBackend,
  updatePersistedState,
  usePersistedState,
  type PersistedStateWriteEvent,
} from "./usePersistedState";

describe("usePersistedState backend sync", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("backend cache hydration updates subscribers that did not opt into storage listening", () => {
    const { result } = renderHook(() => usePersistedState("backend-synced-key", "initial"));

    expect(result.current[0]).toBe("initial");

    act(() => {
      syncPersistedStateFromBackend("backend-synced-key", "from-backend");
    });

    expect(result.current[0]).toBe("from-backend");
  });

  test("write observers receive local and backend source labels", () => {
    const events: PersistedStateWriteEvent[] = [];
    const unsubscribe = subscribePersistedStateWrites((event) => {
      events.push(event);
    });

    updatePersistedState("observed-key", "local-value");
    syncPersistedStateFromBackend("observed-key", "backend-value");
    unsubscribe();

    expect(events).toEqual([
      { key: "observed-key", newValue: "local-value", source: "local" },
      { key: "observed-key", newValue: "backend-value", source: "backend" },
    ]);
  });
});

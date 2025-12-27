/**
 * Tests for useIdleCompactionHandler hook
 *
 * Verifies the hook correctly:
 * - Subscribes/unsubscribes to idle compaction events
 * - Triggers compaction when events are received
 * - Deduplicates in-flight compactions
 * - Clears state after completion (success or failure)
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { renderHook, cleanup } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

// Mock workspaceStore.onIdleCompactionNeeded
let mockUnsubscribe: () => void;
let capturedCallback: ((workspaceId: string) => void) | null = null;
let onIdleCompactionNeededCallCount = 0;

void mock.module("@/browser/stores/WorkspaceStore", () => ({
  workspaceStore: {
    onIdleCompactionNeeded: (callback: (workspaceId: string) => void) => {
      onIdleCompactionNeededCallCount++;
      capturedCallback = callback;
      return mockUnsubscribe;
    },
  },
}));

// Mock buildSendMessageOptions
void mock.module("@/browser/hooks/useSendMessageOptions", () => ({
  buildSendMessageOptions: () => ({
    model: "test-model",
    thinkingLevel: undefined,
    providerOptions: undefined,
    experiments: undefined,
  }),
}));

// Mock workspace.compactHistory - tracks calls and can be configured per test
let compactHistoryResolver: ((value: unknown) => void) | null = null;
let compactHistoryResult:
  | { success: true; data: { operationId: string } }
  | { success: false; error: unknown } = {
  success: true,
  data: { operationId: "op-1" },
};

// Import after mocks are set up
import { useIdleCompactionHandler } from "./useIdleCompactionHandler";

describe("useIdleCompactionHandler", () => {
  let mockApi: object;
  let compactHistoryMock: ReturnType<typeof mock>;
  let unsubscribeCalled: boolean;

  beforeEach(() => {
    // Set up DOM environment for React
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    compactHistoryMock = mock((_args: unknown) => {
      if (compactHistoryResolver) {
        // Return a promise that hangs until manually resolved
        return new Promise((resolve) => {
          const savedResolver = compactHistoryResolver;
          compactHistoryResolver = (val) => {
            savedResolver?.(val);
            resolve(val);
          };
        });
      }
      return Promise.resolve(compactHistoryResult);
    });

    mockApi = { workspace: { compactHistory: compactHistoryMock } };
    unsubscribeCalled = false;
    mockUnsubscribe = () => {
      unsubscribeCalled = true;
    };
    capturedCallback = null;
    onIdleCompactionNeededCallCount = 0;
    compactHistoryResult = { success: true, data: { operationId: "op-1" } };
    compactHistoryResolver = null;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("subscribes to onIdleCompactionNeeded on mount", () => {
    renderHook(() => useIdleCompactionHandler({ api: mockApi as never }));

    expect(onIdleCompactionNeededCallCount).toBe(1);
    expect(capturedCallback).not.toBeNull();
  });

  test("unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useIdleCompactionHandler({ api: mockApi as never }));

    expect(unsubscribeCalled).toBe(false);
    unmount();
    expect(unsubscribeCalled).toBe(true);
  });

  test("does not subscribe when api is null", () => {
    renderHook(() => useIdleCompactionHandler({ api: null }));

    expect(onIdleCompactionNeededCallCount).toBe(0);
  });

  test("calls workspace.compactHistory when event received", async () => {
    renderHook(() => useIdleCompactionHandler({ api: mockApi as never }));

    expect(capturedCallback).not.toBeNull();
    capturedCallback!("workspace-123");

    // Wait for async execution
    await Promise.resolve();
    await Promise.resolve(); // Extra tick for .then()

    expect(compactHistoryMock.mock.calls).toHaveLength(1);
    expect(compactHistoryMock.mock.calls[0][0]).toEqual({
      workspaceId: "workspace-123",
      source: "idle-compaction",
      sendMessageOptions: {
        model: "test-model",
        thinkingLevel: undefined,
        providerOptions: undefined,
        experiments: undefined,
      },
    });
  });

  test("prevents duplicate triggers for same workspace while in-flight", async () => {
    // Make compactHistory hang until we resolve it - this no-op will be replaced when promise is created
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    compactHistoryResolver = () => {};

    renderHook(() => useIdleCompactionHandler({ api: mockApi as never }));

    // Trigger first event
    capturedCallback!("workspace-123");
    await Promise.resolve();

    // Trigger second event for same workspace while first is in-flight
    capturedCallback!("workspace-123");
    await Promise.resolve();

    // Should only have called once
    expect(compactHistoryMock.mock.calls).toHaveLength(1);

    // Resolve the first compaction
    compactHistoryResolver({ success: true, data: { operationId: "op-1" } });
    await Promise.resolve();
    await Promise.resolve(); // Extra tick for .finally()
  });

  test("allows different workspaces to compact simultaneously", async () => {
    renderHook(() => useIdleCompactionHandler({ api: mockApi as never }));

    capturedCallback!("workspace-1");
    capturedCallback!("workspace-2");
    await Promise.resolve();

    expect(compactHistoryMock.mock.calls).toHaveLength(2);
  });

  test("clears workspace from triggered set after success", async () => {
    renderHook(() => useIdleCompactionHandler({ api: mockApi as never }));

    // First trigger
    capturedCallback!("workspace-123");
    await Promise.resolve();
    await Promise.resolve(); // Extra tick for .then()

    expect(compactHistoryMock.mock.calls).toHaveLength(1);
    await Promise.resolve(); // Extra tick for .finally()

    // Should be able to trigger again after completion
    capturedCallback!("workspace-123");
    await Promise.resolve();

    expect(compactHistoryMock.mock.calls).toHaveLength(2);
  });

  test("clears workspace from triggered set after failure", async () => {
    // Make first call fail
    compactHistoryResult = { success: false, error: "test error" };

    // Suppress console.error for this test
    const originalError = console.error;
    console.error = mock(() => undefined);

    renderHook(() => useIdleCompactionHandler({ api: mockApi as never }));

    // First trigger (will fail)
    capturedCallback!("workspace-123");
    await Promise.resolve();
    await Promise.resolve(); // Extra tick for .then()

    expect(compactHistoryMock.mock.calls).toHaveLength(1);
    await Promise.resolve(); // Extra tick for .finally()

    // Should be able to trigger again after failure
    capturedCallback!("workspace-123");
    await Promise.resolve();

    expect(compactHistoryMock.mock.calls).toHaveLength(2);

    console.error = originalError;
  });
});

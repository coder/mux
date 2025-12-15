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
    gateway: "anthropic",
  }),
}));

// Mock executeCompaction - tracks calls and can be configured per test
let executeCompactionCalls: Array<{
  api: unknown;
  workspaceId: string;
  sendMessageOptions: unknown;
  source: string;
}> = [];
let executeCompactionResult: { success: true } | { success: false; error: string } = {
  success: true,
};
let executeCompactionResolver:
  | ((value: { success: true } | { success: false; error: string }) => void)
  | null = null;

void mock.module("@/browser/utils/chatCommands", () => ({
  executeCompaction: (opts: {
    api: unknown;
    workspaceId: string;
    sendMessageOptions: unknown;
    source: string;
  }) => {
    executeCompactionCalls.push(opts);
    if (executeCompactionResolver) {
      // Return a promise that hangs until manually resolved
      return new Promise((resolve) => {
        const savedResolver = executeCompactionResolver;
        executeCompactionResolver = (val) => {
          savedResolver?.(val);
          resolve(val);
        };
      });
    }
    return Promise.resolve(executeCompactionResult);
  },
}));

// Import after mocks are set up
import { useIdleCompactionHandler } from "./useIdleCompactionHandler";

describe("useIdleCompactionHandler", () => {
  let mockApi: object;
  let unsubscribeCalled: boolean;

  beforeEach(() => {
    // Set up DOM environment for React
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    mockApi = { workspace: { sendMessage: mock() } };
    unsubscribeCalled = false;
    mockUnsubscribe = () => {
      unsubscribeCalled = true;
    };
    capturedCallback = null;
    onIdleCompactionNeededCallCount = 0;
    executeCompactionCalls = [];
    executeCompactionResult = { success: true };
    executeCompactionResolver = null;
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

  test("calls executeCompaction when event received", async () => {
    renderHook(() => useIdleCompactionHandler({ api: mockApi as never }));

    expect(capturedCallback).not.toBeNull();
    capturedCallback!("workspace-123");

    // Wait for async execution
    await Promise.resolve();

    expect(executeCompactionCalls).toHaveLength(1);
    expect(executeCompactionCalls[0]).toEqual({
      api: mockApi,
      workspaceId: "workspace-123",
      sendMessageOptions: { model: "test-model", gateway: "anthropic" },
      source: "idle-compaction",
    });
  });

  test("prevents duplicate triggers for same workspace while in-flight", async () => {
    // Make executeCompaction hang until we resolve it - this no-op will be replaced when promise is created
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    executeCompactionResolver = () => {};

    renderHook(() => useIdleCompactionHandler({ api: mockApi as never }));

    // Trigger first event
    capturedCallback!("workspace-123");
    await Promise.resolve();

    // Trigger second event for same workspace while first is in-flight
    capturedCallback!("workspace-123");
    await Promise.resolve();

    // Should only have called once
    expect(executeCompactionCalls).toHaveLength(1);

    // Resolve the first compaction
    executeCompactionResolver({ success: true });
    await Promise.resolve();
  });

  test("allows different workspaces to compact simultaneously", async () => {
    renderHook(() => useIdleCompactionHandler({ api: mockApi as never }));

    capturedCallback!("workspace-1");
    capturedCallback!("workspace-2");
    await Promise.resolve();

    expect(executeCompactionCalls).toHaveLength(2);
  });

  test("clears workspace from triggered set after success", async () => {
    renderHook(() => useIdleCompactionHandler({ api: mockApi as never }));

    // First trigger
    capturedCallback!("workspace-123");
    await Promise.resolve();
    await Promise.resolve(); // Extra tick for .then()

    expect(executeCompactionCalls).toHaveLength(1);

    // Should be able to trigger again after completion
    capturedCallback!("workspace-123");
    await Promise.resolve();

    expect(executeCompactionCalls).toHaveLength(2);
  });

  test("clears workspace from triggered set after failure", async () => {
    // Make first call fail
    executeCompactionResult = { success: false, error: "test error" };

    // Suppress console.error for this test
    const originalError = console.error;
    console.error = mock(() => undefined);

    renderHook(() => useIdleCompactionHandler({ api: mockApi as never }));

    // First trigger (will fail)
    capturedCallback!("workspace-123");
    await Promise.resolve();
    await Promise.resolve(); // Extra tick for .then()

    expect(executeCompactionCalls).toHaveLength(1);

    // Should be able to trigger again after failure
    capturedCallback!("workspace-123");
    await Promise.resolve();

    expect(executeCompactionCalls).toHaveLength(2);

    console.error = originalError;
  });
});

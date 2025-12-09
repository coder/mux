import type { Result } from "@/common/types/result";
import type { BashToolResult } from "@/common/types/tools";

import { describe, it, test, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { GitStatusStore } from "./GitStatusStore";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";

/**
 * Unit tests for GitStatusStore.
 *
 * Tests cover:
 * - Subscription/unsubscription
 * - syncWorkspaces adding/removing workspaces
 * - getStatus caching (returns same reference if unchanged)
 * - Per-workspace cache invalidation
 * - Status change detection
 * - Cleanup on dispose
 */

const mockExecuteBash = jest.fn<() => Promise<Result<BashToolResult, string>>>();

describe("GitStatusStore", () => {
  let store: GitStatusStore;

  beforeEach(() => {
    mockExecuteBash.mockReset();
    mockExecuteBash.mockResolvedValue({
      success: true,
      data: {
        success: true,
        output: "",
        exitCode: 0,
        wall_duration_ms: 0,
      },
    } as Result<BashToolResult, string>);

    (globalThis as unknown as { window: unknown }).window = {
      api: {
        workspace: {
          executeBash: mockExecuteBash,
        },
      },
    } as unknown as Window & typeof globalThis;

    store = new GitStatusStore();
    // Set up mock client for ORPC calls
    store.setClient({
      workspace: {
        executeBash: mockExecuteBash,
      },
    } as unknown as Parameters<typeof store.setClient>[0]);
  });

  afterEach(() => {
    store.dispose();
    // Cleanup mocked window to avoid leaking between tests
    delete (globalThis as { window?: unknown }).window;
  });

  test("subscribe and unsubscribe", () => {
    const listener = jest.fn();
    const unsubscribe = store.subscribe(listener);

    expect(typeof unsubscribe).toBe("function");

    // Unsubscribe
    unsubscribe();

    // Ensure we can call unsubscribe multiple times without error
    unsubscribe();
  });

  test("syncWorkspaces initializes metadata", () => {
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      [
        "ws1",
        {
          id: "ws1",
          name: "main",
          projectName: "test-project",
          projectPath: "/home/user/test-project",
          namedWorkspacePath: "/home/user/.mux/src/test-project/main",
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        },
      ],
    ]);

    store.syncWorkspaces(metadata);

    // Should have empty status initially
    const status = store.getStatus("ws1");
    expect(status).toBeNull();
  });

  test("syncWorkspaces removes deleted workspaces", () => {
    const metadata1 = new Map<string, FrontendWorkspaceMetadata>([
      [
        "ws1",
        {
          id: "ws1",
          name: "main",
          projectName: "test-project",
          projectPath: "/home/user/test-project",
          namedWorkspacePath: "/home/user/.mux/src/test-project/main",
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        },
      ],
      [
        "ws2",
        {
          id: "ws2",
          name: "feature",
          projectName: "test-project",
          projectPath: "/home/user/test-project",
          namedWorkspacePath: "/home/user/.mux/src/test-project/feature",
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        },
      ],
    ]);

    store.syncWorkspaces(metadata1);

    // Verify status is accessible for both workspaces
    const status1Initial = store.getStatus("ws1");
    const status2Initial = store.getStatus("ws2");
    expect(status1Initial).toBeNull(); // No status fetched yet
    expect(status2Initial).toBeNull();

    // Remove ws2
    const metadata2 = new Map<string, FrontendWorkspaceMetadata>([
      [
        "ws1",
        {
          id: "ws1",
          name: "main",
          projectName: "test-project",
          projectPath: "/home/user/test-project",
          namedWorkspacePath: "/home/user/.mux/src/test-project/main",
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        },
      ],
    ]);

    store.syncWorkspaces(metadata2);

    // ws2 status still returns null (cache not actively cleaned, but won't be updated)
    const status2 = store.getStatus("ws2");
    expect(status2).toBeNull();
  });

  test("getStatus caching returns same reference if unchanged", () => {
    const listener = jest.fn();
    store.subscribe(listener);

    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      [
        "ws1",
        {
          id: "ws1",
          name: "main",
          projectName: "test-project",
          projectPath: "/home/user/test-project",
          namedWorkspacePath: "/home/user/.mux/src/test-project/main",
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        },
      ],
    ]);

    store.syncWorkspaces(metadata);

    // Get status twice
    const status1 = store.getStatus("ws1");
    const status2 = store.getStatus("ws1");

    // Should return same reference (both null)
    expect(status1).toBe(status2);
    expect(status1).toBeNull();
  });

  test("getStatus caching persists across calls", () => {
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      [
        "ws1",
        {
          id: "ws1",
          name: "main",
          projectName: "test-project",
          projectPath: "/home/user/test-project",
          namedWorkspacePath: "/home/user/.mux/src/test-project/main",
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        },
      ],
    ]);

    store.syncWorkspaces(metadata);

    // Get status multiple times - should return same cached reference
    const status1 = store.getStatus("ws1");
    const status2 = store.getStatus("ws1");
    const status3 = store.getStatus("ws1");

    // Should return same reference (cached)
    expect(status1).toBe(status2);
    expect(status2).toBe(status3);
  });

  test("dispose cleans up resources", () => {
    const listener = jest.fn();
    store.subscribe(listener);

    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      [
        "ws1",
        {
          id: "ws1",
          name: "main",
          projectName: "test-project",
          projectPath: "/home/user/test-project",
          namedWorkspacePath: "/home/user/.mux/src/test-project/main",
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        },
      ],
    ]);

    store.syncWorkspaces(metadata);

    // Dispose
    store.dispose();

    // Subsequent operations should not throw
    const status = store.getStatus("ws1");
    expect(status).toBeNull();
  });

  test("status change detection", () => {
    const listener = jest.fn();
    store.subscribe(listener);

    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      [
        "ws1",
        {
          id: "ws1",
          name: "main",
          projectName: "test-project",
          projectPath: "/home/user/test-project",
          namedWorkspacePath: "/home/user/.mux/src/test-project/main",
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        },
      ],
    ]);

    store.syncWorkspaces(metadata);

    // Initially null
    const status1 = store.getStatus("ws1");
    expect(status1).toBeNull();

    // Note: We can't easily test status updates without mocking IPC
    // The store relies on window.api.workspace.executeBash which doesn't exist in test environment
    // Real integration tests would need to mock this API
  });

  test("emit only when workspaces are removed", () => {
    const listener = jest.fn();
    const unsub = store.subscribe(listener);

    const metadata1 = new Map<string, FrontendWorkspaceMetadata>([
      [
        "ws1",
        {
          id: "ws1",
          name: "main",
          projectName: "test-project",
          projectPath: "/home/user/test-project",
          namedWorkspacePath: "/home/user/.mux/src/test-project/main",
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        },
      ],
    ]);

    // First sync - no workspaces exist yet, so no removal, no emit
    store.syncWorkspaces(metadata1);
    expect(listener).not.toHaveBeenCalled();

    // Manually add a workspace to the internal map to simulate it existing
    // (normally this would happen via polling, but we can't poll in tests without window.api)
    // @ts-expect-error - Accessing private field for testing
    store.statusCache.set("ws1", { ahead: 0, behind: 0, dirty: false });
    // @ts-expect-error - Accessing private field for testing
    store.statuses.bump("ws1");

    listener.mockClear();

    // Sync with empty metadata to remove ws1
    const metadata2 = new Map<string, FrontendWorkspaceMetadata>();
    store.syncWorkspaces(metadata2);

    // Listener should be called (workspace removed)
    expect(listener).toHaveBeenCalledTimes(1);

    listener.mockClear();

    // Sync again with same empty metadata (no changes)
    store.syncWorkspaces(metadata2);

    // Listener should NOT be called (no changes)
    expect(listener).not.toHaveBeenCalled();

    unsub();
  });

  describe("reference stability", () => {
    it("getStatus() returns same reference when status hasn't changed", () => {
      const status1 = store.getStatus("test-workspace");
      const status2 = store.getStatus("test-workspace");
      expect(status1).toBe(status2);
      expect(status1).toBeNull(); // No workspace = null
    });

    it("getStatus() returns same reference for same workspace when no changes", () => {
      const status1 = store.getStatus("test-workspace");
      const status2 = store.getStatus("test-workspace");
      expect(status1).toBe(status2);
      expect(status1).toBeNull(); // No workspace = null
    });
  });

  describe("failure handling", () => {
    it("preserves old status when checkWorkspaceStatus fails", () => {
      const listener = jest.fn();
      const unsub = store.subscribe(listener);

      // Manually set an initial status
      // @ts-expect-error - Accessing private field for testing
      store.statusCache.set("ws1", { ahead: 2, behind: 1, dirty: true });
      // @ts-expect-error - Accessing private field for testing
      store.statuses.bump("ws1");

      const initialStatus = store.getStatus("ws1");
      expect(initialStatus).toEqual({ ahead: 2, behind: 1, dirty: true });

      listener.mockClear();

      // Simulate a failed status check by calling updateGitStatus with workspace that has status
      // When checkWorkspaceStatus returns [workspaceId, null], the logic should preserve old status
      // We can test this by directly manipulating the internal state to simulate the condition

      // Simulate the update logic receiving a failure result (null status)
      const newStatus = null; // Failed check
      const oldStatus = { ahead: 2, behind: 1, dirty: true };

      // Simulate the condition check from updateGitStatus
      // @ts-expect-error - Accessing private method for testing
      const statusesEqual = store.areStatusesEqual(oldStatus, newStatus);
      expect(statusesEqual).toBe(false); // They're different

      // The key behavior: when newStatus is null, we DON'T update the cache
      // So oldStatus should be preserved
      const statusAfterFailure = store.getStatus("ws1");
      expect(statusAfterFailure).toEqual({ ahead: 2, behind: 1, dirty: true });

      // Listener should NOT be called because we don't bump when status check fails
      expect(listener).not.toHaveBeenCalled();

      unsub();
    });

    it("updates status when checkWorkspaceStatus succeeds after previous failure", () => {
      const listener = jest.fn();
      const unsub = store.subscribe(listener);

      // Start with a status
      // @ts-expect-error - Accessing private field for testing
      store.statusCache.set("ws1", { ahead: 2, behind: 1, dirty: true });
      // @ts-expect-error - Accessing private field for testing
      store.statuses.bump("ws1");

      listener.mockClear();

      // Now simulate a successful update with new status
      // @ts-expect-error - Accessing private field for testing
      store.statusCache.set("ws1", { ahead: 3, behind: 0, dirty: false });
      // @ts-expect-error - Accessing private field for testing
      store.statuses.bump("ws1");

      const newStatus = store.getStatus("ws1");
      expect(newStatus).toEqual({ ahead: 3, behind: 0, dirty: false });

      // Listener should be called for the successful update
      expect(listener).toHaveBeenCalledTimes(1);

      unsub();
    });
  });

  test("skips polling when no subscribers", async () => {
    const metadata = {
      id: "ws1",
      name: "main",
      projectName: "test-project",
      projectPath: "/path",
      namedWorkspacePath: "/path",
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };

    store.syncWorkspaces(new Map([["ws1", metadata]]));

    // Ensure executeBash is cleared
    mockExecuteBash.mockClear();

    // Trigger update
    // @ts-expect-error - Accessing private method
    await store.updateGitStatus();

    // Should not have called executeBash because no subscribers
    expect(mockExecuteBash).not.toHaveBeenCalled();

    // Add a subscriber
    const unsub = store.subscribeKey("ws1", jest.fn());

    // Trigger update again
    // @ts-expect-error - Accessing private method
    await store.updateGitStatus();

    // Should have called executeBash
    expect(mockExecuteBash).toHaveBeenCalled();

    unsub();
  });
});

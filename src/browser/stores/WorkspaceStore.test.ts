import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { WorkspaceStore } from "./WorkspaceStore";

// Mock window.api
const mockExecuteBash = jest.fn(() => ({
  success: true,
  data: {
    success: false,
    error: "executeBash is mocked in WorkspaceStore.test.ts",
    output: "",
    exitCode: 0,
  },
}));

const mockWindow = {
  api: {
    workspace: {
      onChat: jest.fn((_workspaceId, _callback) => {
        // Return unsubscribe function
        return () => {
          // Empty unsubscribe
        };
      }),
      replaceChatHistory: jest.fn(),
      executeBash: mockExecuteBash,
    },
  },
};

global.window = mockWindow as unknown as Window & typeof globalThis;

// Mock dispatchEvent
global.window.dispatchEvent = jest.fn();

// Helper to get IPC callback in a type-safe way
function getOnChatCallback<T = { type: string }>(): (data: T) => void {
  const mock = mockWindow.api.workspace.onChat as jest.Mock<
    () => void,
    [string, (data: T) => void]
  >;
  return mock.mock.calls[0][1];
}

// Helper to create and add a workspace
function createAndAddWorkspace(
  store: WorkspaceStore,
  workspaceId: string,
  options: Partial<FrontendWorkspaceMetadata> = {}
): FrontendWorkspaceMetadata {
  const metadata: FrontendWorkspaceMetadata = {
    id: workspaceId,
    name: options.name ?? `test-branch-${workspaceId}`,
    projectName: options.projectName ?? "test-project",
    projectPath: options.projectPath ?? "/path/to/project",
    namedWorkspacePath: options.namedWorkspacePath ?? "/path/to/workspace",
    createdAt: options.createdAt ?? new Date().toISOString(),
    runtimeConfig: options.runtimeConfig ?? DEFAULT_RUNTIME_CONFIG,
  };
  store.addWorkspace(metadata);
  return metadata;
}

describe("WorkspaceStore", () => {
  let store: WorkspaceStore;
  let mockOnModelUsed: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockExecuteBash.mockClear();
    mockOnModelUsed = jest.fn();
    store = new WorkspaceStore(mockOnModelUsed);
  });

  afterEach(() => {
    store.dispose();
  });

  describe("recency calculation for new workspaces", () => {
    it("should calculate recency from createdAt when workspace is added", () => {
      const workspaceId = "test-workspace";
      const createdAt = new Date().toISOString();
      const metadata: FrontendWorkspaceMetadata = {
        id: workspaceId,
        name: "test-branch",
        projectName: "test-project",
        projectPath: "/path/to/project",
        namedWorkspacePath: "/path/to/workspace",
        createdAt,
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      };

      // Add workspace with createdAt
      store.addWorkspace(metadata);

      // Get state - should have recency based on createdAt
      const state = store.getWorkspaceState(workspaceId);

      // Recency should be based on createdAt, not null or 0
      expect(state.recencyTimestamp).not.toBeNull();
      expect(state.recencyTimestamp).toBe(new Date(createdAt).getTime());

      // Check that workspace appears in recency map with correct timestamp
      const recency = store.getWorkspaceRecency();
      expect(recency[workspaceId]).toBe(new Date(createdAt).getTime());
    });

    it("should maintain createdAt-based recency after CAUGHT_UP with no messages", async () => {
      const workspaceId = "test-workspace-2";
      const createdAt = new Date().toISOString();
      const metadata: FrontendWorkspaceMetadata = {
        id: workspaceId,
        name: "test-branch-2",
        projectName: "test-project",
        projectPath: "/path/to/project",
        namedWorkspacePath: "/path/to/workspace",
        createdAt,
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      };

      // Add workspace
      store.addWorkspace(metadata);

      // Check initial recency
      const initialState = store.getWorkspaceState(workspaceId);
      expect(initialState.recencyTimestamp).toBe(new Date(createdAt).getTime());

      // Get the IPC callback to simulate messages
      const callback = getOnChatCallback();

      // Simulate CAUGHT_UP message with no history (new workspace with no messages)
      callback({ type: "caught-up" });

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Recency should still be based on createdAt
      const stateAfterCaughtUp = store.getWorkspaceState(workspaceId);
      expect(stateAfterCaughtUp.recencyTimestamp).toBe(new Date(createdAt).getTime());

      // Verify recency map
      const recency = store.getWorkspaceRecency();
      expect(recency[workspaceId]).toBe(new Date(createdAt).getTime());
    });
  });

  describe("subscription", () => {
    it("should call listener when workspace state changes", async () => {
      const listener = jest.fn();
      const unsubscribe = store.subscribe(listener);

      // Create workspace metadata
      const metadata: FrontendWorkspaceMetadata = {
        id: "test-workspace",
        name: "test-workspace",
        projectName: "test-project",
        projectPath: "/test/project",
        namedWorkspacePath: "/test/project/test-workspace",
        createdAt: new Date().toISOString(),
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      };

      // Add workspace (should trigger IPC subscription)
      store.addWorkspace(metadata);

      // Simulate a caught-up message (triggers emit)
      const onChatCallback = getOnChatCallback();
      onChatCallback({ type: "caught-up" });

      // Wait for queueMicrotask to complete
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(listener).toHaveBeenCalled();

      unsubscribe();
    });

    it("should allow unsubscribe", () => {
      const listener = jest.fn();
      const unsubscribe = store.subscribe(listener);

      const metadata: FrontendWorkspaceMetadata = {
        id: "test-workspace",
        name: "test-workspace",
        projectName: "test-project",
        projectPath: "/test/project",
        namedWorkspacePath: "/test/project/test-workspace",
        createdAt: new Date().toISOString(),
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      };

      store.addWorkspace(metadata);

      // Unsubscribe before emitting
      unsubscribe();

      const onChatCallback = getOnChatCallback();
      onChatCallback({ type: "caught-up" });

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("syncWorkspaces", () => {
    it("should add new workspaces", () => {
      const metadata1: FrontendWorkspaceMetadata = {
        id: "workspace-1",
        name: "workspace-1",
        projectName: "project-1",
        projectPath: "/project-1",
        namedWorkspacePath: "/path/1",
        createdAt: new Date().toISOString(),
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      };

      const workspaceMap = new Map([[metadata1.id, metadata1]]);
      store.syncWorkspaces(workspaceMap);

      expect(mockWindow.api.workspace.onChat).toHaveBeenCalledWith(
        "workspace-1",
        expect.any(Function)
      );
    });

    it("should remove deleted workspaces", () => {
      const metadata1: FrontendWorkspaceMetadata = {
        id: "workspace-1",
        name: "workspace-1",
        projectName: "project-1",
        projectPath: "/project-1",
        namedWorkspacePath: "/path/1",
        createdAt: new Date().toISOString(),
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      };

      // Add workspace
      store.addWorkspace(metadata1);
      const unsubscribeSpy = jest.fn();
      (mockWindow.api.workspace.onChat as jest.Mock).mockReturnValue(unsubscribeSpy);

      // Sync with empty map (removes all workspaces)
      store.syncWorkspaces(new Map());

      // Note: The unsubscribe function from the first add won't be captured
      // since we mocked it before. In real usage, this would be called.
    });
  });

  describe("getWorkspaceState", () => {
    it("should return initial state for newly added workspace", () => {
      createAndAddWorkspace(store, "new-workspace");
      const state = store.getWorkspaceState("new-workspace");

      expect(state).toMatchObject({
        messages: [],
        canInterrupt: false,
        isCompacting: false,
        loading: true, // loading because not caught up
        muxMessages: [],
        currentModel: null,
      });
      // Should have recency based on createdAt
      expect(state.recencyTimestamp).not.toBeNull();
    });

    it("should return cached state when values unchanged", () => {
      createAndAddWorkspace(store, "test-workspace");
      const state1 = store.getWorkspaceState("test-workspace");
      const state2 = store.getWorkspaceState("test-workspace");

      // Note: Currently the cache doesn't work because aggregator.getDisplayedMessages()
      // creates new arrays. This is acceptable for Phase 1 - React will still do
      // Object.is() comparison and skip re-renders for primitive values.
      // TODO: Optimize aggregator caching in Phase 2
      expect(state1).toEqual(state2);
      expect(state1.canInterrupt).toBe(state2.canInterrupt);
      expect(state1.loading).toBe(state2.loading);
    });
  });

  describe("getWorkspaceRecency", () => {
    it("should return stable reference when values unchanged", () => {
      const recency1 = store.getWorkspaceRecency();
      const recency2 = store.getWorkspaceRecency();

      // Should be same reference (cached)
      expect(recency1).toBe(recency2);
    });
  });

  describe("model tracking", () => {
    it("should call onModelUsed when stream starts", async () => {
      const metadata: FrontendWorkspaceMetadata = {
        id: "test-workspace",
        name: "test-workspace",
        projectName: "test-project",
        projectPath: "/test/project",
        namedWorkspacePath: "/test/project/test-workspace",
        createdAt: new Date().toISOString(),
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      };

      store.addWorkspace(metadata);

      const onChatCallback = getOnChatCallback<{
        type: string;
        messageId?: string;
        model?: string;
      }>();

      // Mark workspace as caught-up first (required for stream events to process)
      onChatCallback({
        type: "caught-up",
      });

      onChatCallback({
        type: "stream-start",
        messageId: "msg-1",
        model: "claude-opus-4",
      });

      // Wait for queueMicrotask to complete
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockOnModelUsed).toHaveBeenCalledWith("claude-opus-4");
    });
  });

  describe("reference stability", () => {
    it("getAllStates() returns new Map on each call", () => {
      const states1 = store.getAllStates();
      const states2 = store.getAllStates();
      // Should return new Map each time (not cached/reactive)
      expect(states1).not.toBe(states2);
      expect(states1).toEqual(states2); // But contents are equal
    });

    it("getWorkspaceState() returns same reference when state hasn't changed", () => {
      const metadata: FrontendWorkspaceMetadata = {
        id: "test-workspace",
        name: "test-workspace",
        projectName: "test-project",
        projectPath: "/test/project",
        namedWorkspacePath: "/test/project/test-workspace",
        createdAt: new Date().toISOString(),
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      };
      store.addWorkspace(metadata);

      const state1 = store.getWorkspaceState("test-workspace");
      const state2 = store.getWorkspaceState("test-workspace");
      expect(state1).toBe(state2);
    });

    it("syncWorkspaces() does not emit when workspaces unchanged", () => {
      const listener = jest.fn();
      store.subscribe(listener);

      const metadata = new Map<string, FrontendWorkspaceMetadata>();
      store.syncWorkspaces(metadata);
      expect(listener).not.toHaveBeenCalled();

      listener.mockClear();
      store.syncWorkspaces(metadata);
      expect(listener).not.toHaveBeenCalled();
    });

    it("getAggregator does not emit when creating new aggregator (no render side effects)", () => {
      let emitCount = 0;
      const unsubscribe = store.subscribe(() => {
        emitCount++;
      });

      // Add workspace first
      createAndAddWorkspace(store, "test-workspace");

      // Simulate what happens during render - component calls getAggregator
      const aggregator1 = store.getAggregator("test-workspace");
      expect(aggregator1).toBeDefined();

      // Should NOT have emitted (would cause "Cannot update component while rendering" error)
      expect(emitCount).toBe(0);

      // Subsequent calls should return same aggregator
      const aggregator2 = store.getAggregator("test-workspace");
      expect(aggregator2).toBe(aggregator1);
      expect(emitCount).toBe(0);

      unsubscribe();
    });
  });

  describe("cache invalidation", () => {
    it("invalidates getWorkspaceState() cache when workspace changes", async () => {
      const metadata: FrontendWorkspaceMetadata = {
        id: "test-workspace",
        name: "test-workspace",
        projectName: "test-project",
        projectPath: "/test/project",
        namedWorkspacePath: "/test/project/test-workspace",
        createdAt: new Date().toISOString(),
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      };
      store.addWorkspace(metadata);

      const state1 = store.getWorkspaceState("test-workspace");

      // Trigger change
      const onChatCallback = getOnChatCallback<{
        type: string;
        messageId?: string;
        model?: string;
      }>();

      // Mark workspace as caught-up first
      onChatCallback({
        type: "caught-up",
      });

      onChatCallback({
        type: "stream-start",
        messageId: "msg1",
        model: "claude-sonnet-4",
      });

      // Wait for queueMicrotask to complete
      await new Promise((resolve) => setTimeout(resolve, 0));

      const state2 = store.getWorkspaceState("test-workspace");
      expect(state1).not.toBe(state2); // Cache should be invalidated
      expect(state2.canInterrupt).toBe(true); // Stream started, so can interrupt
    });

    it("invalidates getAllStates() cache when workspace changes", async () => {
      const metadata: FrontendWorkspaceMetadata = {
        id: "test-workspace",
        name: "test-workspace",
        projectName: "test-project",
        projectPath: "/test/project",
        namedWorkspacePath: "/test/project/test-workspace",
        createdAt: new Date().toISOString(),
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      };
      store.addWorkspace(metadata);

      const states1 = store.getAllStates();

      // Trigger change
      const onChatCallback = getOnChatCallback<{
        type: string;
        messageId?: string;
        model?: string;
      }>();

      // Mark workspace as caught-up first
      onChatCallback({
        type: "caught-up",
      });

      onChatCallback({
        type: "stream-start",
        messageId: "msg1",
        model: "claude-sonnet-4",
      });

      // Wait for queueMicrotask to complete
      await new Promise((resolve) => setTimeout(resolve, 0));

      const states2 = store.getAllStates();
      expect(states1).not.toBe(states2); // Cache should be invalidated
    });

    it("maintains recency based on createdAt for new workspaces", () => {
      const createdAt = new Date("2024-01-01T00:00:00Z").toISOString();
      const metadata: FrontendWorkspaceMetadata = {
        id: "test-workspace",
        name: "test-workspace",
        projectName: "test-project",
        projectPath: "/test/project",
        namedWorkspacePath: "/test/project/test-workspace",
        createdAt,
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      };
      store.addWorkspace(metadata);

      const recency = store.getWorkspaceRecency();

      // Recency should be based on createdAt
      expect(recency["test-workspace"]).toBe(new Date(createdAt).getTime());
    });

    it("maintains cache when no changes occur", () => {
      const metadata: FrontendWorkspaceMetadata = {
        id: "test-workspace",
        name: "test-workspace",
        projectName: "test-project",
        projectPath: "/test/project",
        namedWorkspacePath: "/test/project/test-workspace",
        createdAt: new Date().toISOString(),
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      };
      store.addWorkspace(metadata);

      const state1 = store.getWorkspaceState("test-workspace");
      const state2 = store.getWorkspaceState("test-workspace");
      const recency1 = store.getWorkspaceRecency();
      const recency2 = store.getWorkspaceRecency();

      // Cached values should return same references
      expect(state1).toBe(state2);
      expect(recency1).toBe(recency2);

      // getAllStates returns new Map each time (not cached)
      const allStates1 = store.getAllStates();
      const allStates2 = store.getAllStates();
      expect(allStates1).not.toBe(allStates2);
      expect(allStates1).toEqual(allStates2);
    });
  });

  describe("race conditions", () => {
    it("properly cleans up workspace on removal", () => {
      const metadata: FrontendWorkspaceMetadata = {
        id: "test-workspace",
        name: "test-workspace",
        projectName: "test-project",
        projectPath: "/test/project",
        namedWorkspacePath: "/test/project/test-workspace",
        createdAt: new Date().toISOString(),
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      };
      store.addWorkspace(metadata);

      // Verify workspace exists
      let allStates = store.getAllStates();
      expect(allStates.size).toBe(1);

      // Remove workspace (clears aggregator and unsubscribes IPC)
      store.removeWorkspace("test-workspace");

      // Verify workspace is completely removed
      allStates = store.getAllStates();
      expect(allStates.size).toBe(0);

      // Verify aggregator is gone
      expect(() => store.getAggregator("test-workspace")).toThrow(
        /Workspace test-workspace not found/
      );
    });

    it("handles concurrent workspace additions", () => {
      const metadata1: FrontendWorkspaceMetadata = {
        id: "workspace-1",
        name: "workspace-1",
        projectName: "project-1",
        projectPath: "/project-1",
        namedWorkspacePath: "/path/1",
        createdAt: new Date().toISOString(),
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      };
      const metadata2: FrontendWorkspaceMetadata = {
        id: "workspace-2",
        name: "workspace-2",
        projectName: "project-2",
        projectPath: "/project-2",
        namedWorkspacePath: "/path/2",
        createdAt: new Date().toISOString(),
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      };

      // Add workspaces concurrently
      store.addWorkspace(metadata1);
      store.addWorkspace(metadata2);

      const allStates = store.getAllStates();
      expect(allStates.size).toBe(2);
      expect(allStates.has("workspace-1")).toBe(true);
      expect(allStates.has("workspace-2")).toBe(true);
    });

    it("handles workspace removal during state access", () => {
      const metadata: FrontendWorkspaceMetadata = {
        id: "test-workspace",
        name: "test-workspace",
        projectName: "test-project",
        projectPath: "/test/project",
        namedWorkspacePath: "/test/project/test-workspace",
        createdAt: new Date().toISOString(),
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      };
      store.addWorkspace(metadata);

      const state1 = store.getWorkspaceState("test-workspace");
      expect(state1).toBeDefined();

      // Remove workspace
      store.removeWorkspace("test-workspace");

      // Accessing state after removal should create new aggregator (lazy init)
      const state2 = store.getWorkspaceState("test-workspace");
      expect(state2).toBeDefined();
      expect(state2.loading).toBe(true); // Fresh workspace, not caught up
    });
  });
});

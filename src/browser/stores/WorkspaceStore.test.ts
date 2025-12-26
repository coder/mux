import { describe, expect, it, beforeEach, afterEach, mock, type Mock } from "bun:test";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { StreamStartEvent, ToolCallStartEvent } from "@/common/types/stream";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { WorkspaceStore } from "./WorkspaceStore";

// Mock client
// eslint-disable-next-line require-yield
const mockOnChat = mock(async function* (): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
  // yield nothing by default
  await Promise.resolve();
});

const mockGetSessionUsage = mock(() => Promise.resolve(undefined));

const mockClient = {
  workspace: {
    onChat: mockOnChat,
    getSessionUsage: mockGetSessionUsage,
  },
};

const mockWindow = {
  api: {
    workspace: {
      onChat: mock((_workspaceId, _callback) => {
        return () => {
          // cleanup
        };
      }),
    },
  },
};

global.window = mockWindow as unknown as Window & typeof globalThis;
global.window.dispatchEvent = mock();

// Mock queueMicrotask
global.queueMicrotask = (fn) => fn();

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
  let mockOnModelUsed: Mock<(model: string) => void>;

  beforeEach(() => {
    mockOnChat.mockClear();
    mockOnModelUsed = mock(() => undefined);
    store = new WorkspaceStore(mockOnModelUsed);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
    store.setClient(mockClient as any);
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

      // Setup mock stream
      mockOnChat.mockImplementation(async function* (): AsyncGenerator<
        WorkspaceChatMessage,
        void,
        unknown
      > {
        yield { type: "caught-up" };
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        });
      });

      // Add workspace
      store.addWorkspace(metadata);

      // Check initial recency
      const initialState = store.getWorkspaceState(workspaceId);
      expect(initialState.recencyTimestamp).toBe(new Date(createdAt).getTime());

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
      const listener = mock(() => undefined);
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

      // Setup mock stream
      mockOnChat.mockImplementation(async function* (): AsyncGenerator<
        WorkspaceChatMessage,
        void,
        unknown
      > {
        await Promise.resolve();
        yield { type: "caught-up" };
      });

      // Add workspace (should trigger IPC subscription)
      store.addWorkspace(metadata);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(listener).toHaveBeenCalled();

      unsubscribe();
    });

    it("should allow unsubscribe", async () => {
      const listener = mock(() => undefined);
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

      // Setup mock stream
      mockOnChat.mockImplementation(async function* (): AsyncGenerator<
        WorkspaceChatMessage,
        void,
        unknown
      > {
        await Promise.resolve();
        yield { type: "caught-up" };
      });

      // Unsubscribe before adding workspace (which triggers updates)
      unsubscribe();
      store.addWorkspace(metadata);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 10));

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

      expect(mockOnChat).toHaveBeenCalledWith({ workspaceId: "workspace-1" }, expect.anything());
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

      // Sync with empty map (removes all workspaces)
      store.syncWorkspaces(new Map());

      // Should verify that the controller was aborted, but since we mock the implementation
      // we just check that the workspace was removed from internal state
      expect(store.getAggregator("workspace-1")).toBeUndefined();
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

      // Setup mock stream
      mockOnChat.mockImplementation(async function* (): AsyncGenerator<
        WorkspaceChatMessage,
        void,
        unknown
      > {
        yield { type: "caught-up" };
        await new Promise((resolve) => setTimeout(resolve, 0));
        yield {
          type: "stream-start",
          historySequence: 1,
          messageId: "msg1",
          model: "claude-opus-4",
          workspaceId: "test-workspace",
          startTime: Date.now(),
        };
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        });
      });

      store.addWorkspace(metadata);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 20));

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

    it("getWorkspaceSidebarState() returns same reference when WorkspaceState hasn't changed", () => {
      const originalNow = Date.now;
      let now = 1000;
      Date.now = () => now;

      try {
        const workspaceId = "test-workspace";
        createAndAddWorkspace(store, workspaceId);

        const aggregator = store.getAggregator(workspaceId);
        expect(aggregator).toBeDefined();
        if (!aggregator) {
          throw new Error("Expected aggregator to exist");
        }

        const streamStart: StreamStartEvent = {
          type: "stream-start",
          workspaceId,
          messageId: "msg1",
          model: "claude-opus-4",
          historySequence: 1,
          startTime: 500,
          mode: "exec",
        };
        aggregator.handleStreamStart(streamStart);

        const toolStart: ToolCallStartEvent = {
          type: "tool-call-start",
          workspaceId,
          messageId: "msg1",
          toolCallId: "tool1",
          toolName: "test_tool",
          args: {},
          tokens: 0,
          timestamp: 600,
        };
        aggregator.handleToolCallStart(toolStart);

        // Simulate store update (MapStore version bump) after handling events.
        store.bumpState(workspaceId);

        now = 1300;
        const sidebar1 = store.getWorkspaceSidebarState(workspaceId);

        // Advance time without a store bump. Without snapshot caching, this would
        // produce a new object due to Date.now()-derived timing stats.
        now = 1350;
        const sidebar2 = store.getWorkspaceSidebarState(workspaceId);

        expect(sidebar2).toBe(sidebar1);
      } finally {
        Date.now = originalNow;
      }
    });

    it("syncWorkspaces() does not emit when workspaces unchanged", () => {
      const listener = mock(() => undefined);
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

      // Setup mock stream
      mockOnChat.mockImplementation(async function* (): AsyncGenerator<
        WorkspaceChatMessage,
        void,
        unknown
      > {
        yield { type: "caught-up" };
        await new Promise((resolve) => setTimeout(resolve, 0));
        yield {
          type: "stream-start",
          historySequence: 1,
          messageId: "msg1",
          model: "claude-sonnet-4",
          workspaceId: "test-workspace",
          startTime: Date.now(),
        };
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        });
      });

      store.addWorkspace(metadata);

      const state1 = store.getWorkspaceState("test-workspace");

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 20));

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

      // Setup mock stream
      mockOnChat.mockImplementation(async function* (): AsyncGenerator<
        WorkspaceChatMessage,
        void,
        unknown
      > {
        yield { type: "caught-up" };
        await new Promise((resolve) => setTimeout(resolve, 0));
        yield {
          type: "stream-start",
          historySequence: 1,
          messageId: "msg1",
          model: "claude-sonnet-4",
          workspaceId: "test-workspace",
          startTime: Date.now(),
        };
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        });
      });

      store.addWorkspace(metadata);

      const states1 = store.getAllStates();

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 20));

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
      expect(store.getAggregator("test-workspace")).toBeUndefined();
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

  describe("bash-output events", () => {
    it("retains live output when bash tool result has no output", async () => {
      const workspaceId = "bash-output-workspace-1";

      mockOnChat.mockImplementation(async function* (): AsyncGenerator<
        WorkspaceChatMessage,
        void,
        unknown
      > {
        yield { type: "caught-up" };
        await Promise.resolve();
        yield {
          type: "bash-output",
          workspaceId,
          toolCallId: "call-1",
          text: "out\n",
          isError: false,
          timestamp: 1,
        };
        yield {
          type: "bash-output",
          workspaceId,
          toolCallId: "call-1",
          text: "err\n",
          isError: true,
          timestamp: 2,
        };
        // Simulate tmpfile overflow: tool result has no output field.
        yield {
          type: "tool-call-end",
          workspaceId,
          messageId: "m1",
          toolCallId: "call-1",
          toolName: "bash",
          result: { success: false, error: "overflow", exitCode: -1, wall_duration_ms: 1 },
          timestamp: 3,
        };
      });

      createAndAddWorkspace(store, workspaceId);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const live = store.getBashToolLiveOutput(workspaceId, "call-1");
      expect(live).not.toBeNull();
      if (!live) throw new Error("Expected live output");

      // getSnapshot in useSyncExternalStore requires referential stability when unchanged.
      const liveAgain = store.getBashToolLiveOutput(workspaceId, "call-1");
      expect(liveAgain).toBe(live);

      expect(live.stdout).toContain("out");
      expect(live.stderr).toContain("err");
    });

    it("clears live output when bash tool result includes output", async () => {
      const workspaceId = "bash-output-workspace-2";

      mockOnChat.mockImplementation(async function* (): AsyncGenerator<
        WorkspaceChatMessage,
        void,
        unknown
      > {
        yield { type: "caught-up" };
        await Promise.resolve();
        yield {
          type: "bash-output",
          workspaceId,
          toolCallId: "call-2",
          text: "out\n",
          isError: false,
          timestamp: 1,
        };
        yield {
          type: "tool-call-end",
          workspaceId,
          messageId: "m2",
          toolCallId: "call-2",
          toolName: "bash",
          result: { success: true, output: "done", exitCode: 0, wall_duration_ms: 1 },
          timestamp: 2,
        };
      });

      createAndAddWorkspace(store, workspaceId);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const live = store.getBashToolLiveOutput(workspaceId, "call-2");
      expect(live).toBeNull();
    });
  });

  describe("file-modifying tool subscription", () => {
    it("notifies subscribers when bash tool completes", async () => {
      const workspaceId = "file-modify-test-1";
      const notifications: string[] = [];

      // Subscribe BEFORE creating workspace
      const unsubscribe = store.subscribeFileModifyingTool((wsId) => {
        notifications.push(wsId);
      }, workspaceId);

      mockOnChat.mockImplementation(async function* (): AsyncGenerator<
        WorkspaceChatMessage,
        void,
        unknown
      > {
        yield { type: "caught-up" };
        await Promise.resolve();
        yield {
          type: "tool-call-end",
          workspaceId,
          messageId: "m1",
          toolCallId: "call-1",
          toolName: "bash",
          result: { success: true, output: "done", exitCode: 0, wall_duration_ms: 1 },
          timestamp: 1,
        };
      });

      createAndAddWorkspace(store, workspaceId);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(notifications).toContain(workspaceId);
      expect(notifications.length).toBe(1);

      unsubscribe();
    });

    it("notifies subscribers when file_edit tool completes", async () => {
      const workspaceId = "file-modify-test-2";
      const notifications: string[] = [];

      const unsubscribe = store.subscribeFileModifyingTool((wsId) => {
        notifications.push(wsId);
      }, workspaceId);

      mockOnChat.mockImplementation(async function* (): AsyncGenerator<
        WorkspaceChatMessage,
        void,
        unknown
      > {
        yield { type: "caught-up" };
        await Promise.resolve();
        yield {
          type: "tool-call-end",
          workspaceId,
          messageId: "m1",
          toolCallId: "call-1",
          toolName: "file_edit_replace_string",
          result: { success: true },
          timestamp: 1,
        };
      });

      createAndAddWorkspace(store, workspaceId);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(notifications).toContain(workspaceId);
      unsubscribe();
    });

    it("does NOT notify for non-file-modifying tools", async () => {
      const workspaceId = "file-modify-test-3";
      const notifications: string[] = [];

      const unsubscribe = store.subscribeFileModifyingTool((wsId) => {
        notifications.push(wsId);
      }, workspaceId);

      mockOnChat.mockImplementation(async function* (): AsyncGenerator<
        WorkspaceChatMessage,
        void,
        unknown
      > {
        yield { type: "caught-up" };
        await Promise.resolve();
        yield {
          type: "tool-call-end",
          workspaceId,
          messageId: "m1",
          toolCallId: "call-1",
          toolName: "web_search", // Not file-modifying
          result: { success: true },
          timestamp: 1,
        };
      });

      createAndAddWorkspace(store, workspaceId);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(notifications.length).toBe(0);
      unsubscribe();
    });

    it("only notifies subscribers for the specific workspace", async () => {
      const workspaceId1 = "file-modify-test-4a";
      const workspaceId2 = "file-modify-test-4b";
      const notifications1: string[] = [];
      const notifications2: string[] = [];

      const unsubscribe1 = store.subscribeFileModifyingTool((wsId) => {
        notifications1.push(wsId);
      }, workspaceId1);

      const unsubscribe2 = store.subscribeFileModifyingTool((wsId) => {
        notifications2.push(wsId);
      }, workspaceId2);

      // Only emit tool completion for workspace1
      mockOnChat.mockImplementation(async function* (): AsyncGenerator<
        WorkspaceChatMessage,
        void,
        unknown
      > {
        yield { type: "caught-up" };
        await Promise.resolve();
        yield {
          type: "tool-call-end",
          workspaceId: workspaceId1,
          messageId: "m1",
          toolCallId: "call-1",
          toolName: "bash",
          result: { success: true, output: "done", exitCode: 0, wall_duration_ms: 1 },
          timestamp: 1,
        };
      });

      createAndAddWorkspace(store, workspaceId1);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(notifications1.length).toBe(1);
      expect(notifications2.length).toBe(0); // Not notified - different workspace

      unsubscribe1();
      unsubscribe2();
    });
  });
});

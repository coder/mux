import { describe, expect, it, beforeEach, afterEach, mock, type Mock } from "bun:test";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { StreamStartEvent, ToolCallStartEvent } from "@/common/types/stream";
import type { WorkspaceActivitySnapshot, WorkspaceChatMessage } from "@/common/orpc/types";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT } from "@/common/constants/ui";
import { getAutoCompactionThresholdKey, getAutoRetryKey } from "@/common/constants/storage";
import { WorkspaceStore } from "./WorkspaceStore";

interface LoadMoreResponse {
  messages: WorkspaceChatMessage[];
  nextCursor: { beforeHistorySequence: number; beforeMessageId?: string | null } | null;
  hasOlder: boolean;
}

// Mock client
// eslint-disable-next-line require-yield
const mockOnChat = mock(async function* (
  _input?: { workspaceId: string; mode?: unknown },
  options?: { signal?: AbortSignal }
): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
  // Keep the iterator open until the store aborts it (prevents retry-loop noise in tests).
  await new Promise<void>((resolve) => {
    if (!options?.signal) {
      resolve();
      return;
    }
    options.signal.addEventListener("abort", () => resolve(), { once: true });
  });
});

const mockGetSessionUsage = mock(() => Promise.resolve(undefined));
const mockHistoryLoadMore = mock(
  (): Promise<LoadMoreResponse> =>
    Promise.resolve({
      messages: [],
      nextCursor: null,
      hasOlder: false,
    })
);
const mockActivityList = mock(() => Promise.resolve<Record<string, WorkspaceActivitySnapshot>>({}));
// eslint-disable-next-line require-yield
const mockActivitySubscribe = mock(async function* (
  _input?: void,
  options?: { signal?: AbortSignal }
): AsyncGenerator<
  { workspaceId: string; activity: WorkspaceActivitySnapshot | null },
  void,
  unknown
> {
  await new Promise<void>((resolve) => {
    if (!options?.signal) {
      resolve();
      return;
    }
    options.signal.addEventListener("abort", () => resolve(), { once: true });
  });
});

const mockSetAutoCompactionThreshold = mock(() =>
  Promise.resolve({ success: true, data: undefined })
);
const mockGetStartupAutoRetryModel = mock(() => Promise.resolve({ success: true, data: null }));

const mockClient = {
  workspace: {
    onChat: mockOnChat,
    getSessionUsage: mockGetSessionUsage,
    history: {
      loadMore: mockHistoryLoadMore,
    },
    activity: {
      list: mockActivityList,
      subscribe: mockActivitySubscribe,
    },
    setAutoCompactionThreshold: mockSetAutoCompactionThreshold,
    getStartupAutoRetryModel: mockGetStartupAutoRetryModel,
  },
};

const localStorageBacking = new Map<string, string>();
const mockLocalStorage: Storage = {
  get length() {
    return localStorageBacking.size;
  },
  clear() {
    localStorageBacking.clear();
  },
  getItem(key: string) {
    return localStorageBacking.get(key) ?? null;
  },
  key(index: number) {
    return Array.from(localStorageBacking.keys())[index] ?? null;
  },
  removeItem(key: string) {
    localStorageBacking.delete(key);
  },
  setItem(key: string, value: string) {
    localStorageBacking.set(key, value);
  },
};

const mockWindow = {
  localStorage: mockLocalStorage,
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
  options: Partial<FrontendWorkspaceMetadata> = {},
  activate = true
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
  if (activate) {
    store.setActiveWorkspaceId(workspaceId);
  }
  store.addWorkspace(metadata);
  return metadata;
}

function createHistoryMessageEvent(id: string, historySequence: number): WorkspaceChatMessage {
  return {
    type: "message",
    id,
    role: "user",
    parts: [{ type: "text", text: `message-${historySequence}` }],
    metadata: { historySequence, timestamp: historySequence },
  };
}

async function waitForAbortSignal(signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    if (!signal) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

describe("WorkspaceStore", () => {
  let store: WorkspaceStore;
  let mockOnModelUsed: Mock<(model: string) => void>;

  beforeEach(() => {
    mockOnChat.mockClear();
    mockGetSessionUsage.mockClear();
    mockHistoryLoadMore.mockClear();
    mockActivityList.mockClear();
    mockActivitySubscribe.mockClear();
    mockSetAutoCompactionThreshold.mockClear();
    mockGetStartupAutoRetryModel.mockClear();
    global.window.localStorage?.clear?.();
    mockHistoryLoadMore.mockResolvedValue({
      messages: [],
      nextCursor: null,
      hasOlder: false,
    });
    mockActivityList.mockResolvedValue({});
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
      store.setActiveWorkspaceId(workspaceId);
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
      store.setActiveWorkspaceId(metadata.id);
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
      store.setActiveWorkspaceId(metadata.id);
      store.addWorkspace(metadata);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("active workspace subscriptions", () => {
    it("does not start onChat until workspace becomes active", async () => {
      const workspaceId = "inactive-workspace";
      createAndAddWorkspace(store, workspaceId, {}, false);

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockOnChat).not.toHaveBeenCalled();

      store.setActiveWorkspaceId(workspaceId);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockOnChat).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId }),
        expect.anything()
      );
    });

    it("switches onChat subscriptions when active workspace changes", async () => {
      // eslint-disable-next-line require-yield
      mockOnChat.mockImplementation(async function* (
        _input?: { workspaceId: string; mode?: unknown },
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
        await new Promise<void>((resolve) => {
          if (!options?.signal) {
            resolve();
            return;
          }
          options.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      });

      createAndAddWorkspace(store, "workspace-1", {}, false);
      createAndAddWorkspace(store, "workspace-2", {}, false);

      store.setActiveWorkspaceId("workspace-1");
      await new Promise((resolve) => setTimeout(resolve, 0));

      store.setActiveWorkspaceId("workspace-2");
      await new Promise((resolve) => setTimeout(resolve, 0));

      const subscribedWorkspaceIds = mockOnChat.mock.calls.map((call) => {
        const input = call[0] as { workspaceId?: string };
        return input.workspaceId;
      });

      expect(subscribedWorkspaceIds).toEqual(["workspace-1", "workspace-2"]);
    });

    it("clears replay buffers before aborting the previous active workspace subscription", async () => {
      // eslint-disable-next-line require-yield
      mockOnChat.mockImplementation(async function* (
        _input?: { workspaceId: string; mode?: unknown },
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
        await waitForAbortSignal(options?.signal);
      });

      createAndAddWorkspace(store, "workspace-1", {}, false);
      createAndAddWorkspace(store, "workspace-2", {}, false);

      store.setActiveWorkspaceId("workspace-1");
      await new Promise((resolve) => setTimeout(resolve, 0));

      const transientState = (
        store as unknown as {
          chatTransientState: Map<
            string,
            {
              caughtUp: boolean;
              replayingHistory: boolean;
              historicalMessages: WorkspaceChatMessage[];
              pendingStreamEvents: WorkspaceChatMessage[];
            }
          >;
        }
      ).chatTransientState.get("workspace-1");
      expect(transientState).toBeDefined();

      transientState!.caughtUp = false;
      transientState!.replayingHistory = true;
      transientState!.historicalMessages.push(
        createHistoryMessageEvent("stale-buffered-message", 9)
      );
      transientState!.pendingStreamEvents.push({
        type: "stream-start",
        workspaceId: "workspace-1",
        messageId: "stale-buffered-stream",
        model: "claude-sonnet-4",
        historySequence: 10,
        startTime: Date.now(),
      });

      // Switching active workspaces should clear replay buffers synchronously
      // before aborting the previous subscription.
      store.setActiveWorkspaceId("workspace-2");

      expect(transientState!.caughtUp).toBe(false);
      expect(transientState!.replayingHistory).toBe(false);
      expect(transientState!.historicalMessages).toHaveLength(0);
      expect(transientState!.pendingStreamEvents).toHaveLength(0);
    });
    it("drops queued chat events from an aborted subscription attempt", async () => {
      const queuedMicrotasks: Array<() => void> = [];
      const originalQueueMicrotask = global.queueMicrotask;
      let resolveQueuedEvent!: () => void;
      const queuedEvent = new Promise<void>((resolve) => {
        resolveQueuedEvent = resolve;
      });

      global.queueMicrotask = (callback) => {
        queuedMicrotasks.push(callback);
        resolveQueuedEvent();
      };

      try {
        mockOnChat.mockImplementation(async function* (
          input?: { workspaceId: string; mode?: unknown },
          options?: { signal?: AbortSignal }
        ): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
          if (input?.workspaceId === "workspace-1") {
            yield createHistoryMessageEvent("queued-after-switch", 11);
          }
          await waitForAbortSignal(options?.signal);
        });

        createAndAddWorkspace(store, "workspace-1", {}, false);
        createAndAddWorkspace(store, "workspace-2", {}, false);

        store.setActiveWorkspaceId("workspace-1");
        await queuedEvent;

        const transientState = (
          store as unknown as {
            chatTransientState: Map<
              string,
              {
                historicalMessages: WorkspaceChatMessage[];
                pendingStreamEvents: WorkspaceChatMessage[];
              }
            >;
          }
        ).chatTransientState.get("workspace-1");
        expect(transientState).toBeDefined();

        // Abort workspace-1 attempt by moving focus; the queued callback should now no-op.
        store.setActiveWorkspaceId("workspace-2");

        for (const callback of queuedMicrotasks) {
          callback();
        }

        expect(transientState!.historicalMessages).toHaveLength(0);
        expect(transientState!.pendingStreamEvents).toHaveLength(0);
      } finally {
        global.queueMicrotask = originalQueueMicrotask;
      }
    });
  });

  it("tracks which workspace currently has the active onChat subscription", async () => {
    createAndAddWorkspace(store, "workspace-1", {}, false);
    createAndAddWorkspace(store, "workspace-2", {}, false);

    expect(store.isOnChatSubscriptionActive("workspace-1")).toBe(false);
    expect(store.isOnChatSubscriptionActive("workspace-2")).toBe(false);

    store.setActiveWorkspaceId("workspace-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.isOnChatSubscriptionActive("workspace-1")).toBe(true);
    expect(store.isOnChatSubscriptionActive("workspace-2")).toBe(false);

    store.setActiveWorkspaceId("workspace-2");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.isOnChatSubscriptionActive("workspace-1")).toBe(false);
    expect(store.isOnChatSubscriptionActive("workspace-2")).toBe(true);

    store.setActiveWorkspaceId(null);
    expect(store.isOnChatSubscriptionActive("workspace-1")).toBe(false);
    expect(store.isOnChatSubscriptionActive("workspace-2")).toBe(false);
  });

  describe("syncWorkspaces", () => {
    it("should add new workspaces", async () => {
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
      store.setActiveWorkspaceId(metadata1.id);
      store.syncWorkspaces(workspaceMap);

      // addWorkspace triggers async onChat subscription setup; wait until the
      // subscription attempt runs so startup threshold sync RPCs do not race this assertion.
      const deadline = Date.now() + 1_000;
      while (mockOnChat.mock.calls.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(mockOnChat).toHaveBeenCalledWith({ workspaceId: "workspace-1" }, expect.anything());
    });

    it("sanitizes malformed startup threshold values before backend sync", async () => {
      const workspaceId = "workspace-threshold-sanitize";
      const thresholdKey = getAutoCompactionThresholdKey("default");
      global.window.localStorage.setItem(thresholdKey, JSON.stringify("not-a-number"));

      createAndAddWorkspace(store, workspaceId);

      const deadline = Date.now() + 1_000;
      while (mockSetAutoCompactionThreshold.mock.calls.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(mockSetAutoCompactionThreshold).toHaveBeenCalledWith({
        workspaceId,
        threshold: DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT / 100,
      });

      expect(global.window.localStorage.getItem(thresholdKey)).toBe(
        JSON.stringify(DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT)
      );
    });

    it("sanitizes malformed legacy auto-retry values before subscribing", async () => {
      const workspaceId = "workspace-auto-retry-sanitize";
      const autoRetryKey = getAutoRetryKey(workspaceId);
      global.window.localStorage.setItem(autoRetryKey, JSON.stringify("invalid-legacy-value"));

      createAndAddWorkspace(store, workspaceId);

      const deadline = Date.now() + 1_000;
      while (mockOnChat.mock.calls.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(mockOnChat.mock.calls.length).toBeGreaterThan(0);
      const onChatInput = mockOnChat.mock.calls[0]?.[0] as {
        workspaceId?: string;
        legacyAutoRetryEnabled?: unknown;
      };

      expect(onChatInput.workspaceId).toBe(workspaceId);
      expect("legacyAutoRetryEnabled" in onChatInput).toBe(false);
      expect(global.window.localStorage.getItem(autoRetryKey)).toBeNull();
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

  describe("history pagination", () => {
    it("initializes pagination from the oldest loaded history sequence on caught-up", async () => {
      const workspaceId = "history-pagination-workspace-1";

      mockOnChat.mockImplementation(async function* (
        _input?: { workspaceId: string; mode?: unknown },
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
        yield createHistoryMessageEvent("msg-newer", 5);
        await Promise.resolve();
        yield { type: "caught-up", hasOlderHistory: true };
        await waitForAbortSignal(options?.signal);
      });

      createAndAddWorkspace(store, workspaceId);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const state = store.getWorkspaceState(workspaceId);
      expect(state.hasOlderHistory).toBe(true);
      expect(state.loadingOlderHistory).toBe(false);
    });

    it("does not infer older history from non-boundary sequences without server metadata", async () => {
      const workspaceId = "history-pagination-no-boundary";

      mockOnChat.mockImplementation(async function* (
        _input?: { workspaceId: string; mode?: unknown },
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
        yield createHistoryMessageEvent("msg-non-boundary", 5);
        await Promise.resolve();
        yield { type: "caught-up" };
        await waitForAbortSignal(options?.signal);
      });

      createAndAddWorkspace(store, workspaceId);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const state = store.getWorkspaceState(workspaceId);
      expect(state.hasOlderHistory).toBe(false);
      expect(state.loadingOlderHistory).toBe(false);
    });

    it("loads older history and prepends it to the transcript", async () => {
      const workspaceId = "history-pagination-workspace-2";

      mockOnChat.mockImplementation(async function* (
        _input?: { workspaceId: string; mode?: unknown },
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
        yield createHistoryMessageEvent("msg-newer", 5);
        await Promise.resolve();
        yield { type: "caught-up", hasOlderHistory: true };
        await waitForAbortSignal(options?.signal);
      });

      mockHistoryLoadMore.mockResolvedValueOnce({
        messages: [createHistoryMessageEvent("msg-older", 3)],
        nextCursor: null,
        hasOlder: false,
      });

      createAndAddWorkspace(store, workspaceId);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(store.getWorkspaceState(workspaceId).hasOlderHistory).toBe(true);

      await store.loadOlderHistory(workspaceId);

      expect(mockHistoryLoadMore).toHaveBeenCalledWith({
        workspaceId,
        cursor: {
          beforeHistorySequence: 5,
          beforeMessageId: "msg-newer",
        },
      });

      const state = store.getWorkspaceState(workspaceId);
      expect(state.hasOlderHistory).toBe(false);
      expect(state.loadingOlderHistory).toBe(false);
      expect(state.muxMessages.map((message) => message.id)).toEqual(["msg-older", "msg-newer"]);
    });

    it("exposes loadingOlderHistory while requests are in flight and ignores concurrent loads", async () => {
      const workspaceId = "history-pagination-workspace-3";

      mockOnChat.mockImplementation(async function* (
        _input?: { workspaceId: string; mode?: unknown },
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
        yield createHistoryMessageEvent("msg-newer", 5);
        await Promise.resolve();
        yield { type: "caught-up", hasOlderHistory: true };
        await waitForAbortSignal(options?.signal);
      });

      let resolveLoadMore: ((value: LoadMoreResponse) => void) | undefined;

      const loadMorePromise = new Promise<LoadMoreResponse>((resolve) => {
        resolveLoadMore = resolve;
      });
      mockHistoryLoadMore.mockReturnValueOnce(loadMorePromise);

      createAndAddWorkspace(store, workspaceId);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const firstLoad = store.loadOlderHistory(workspaceId);
      expect(store.getWorkspaceState(workspaceId).loadingOlderHistory).toBe(true);

      const secondLoad = store.loadOlderHistory(workspaceId);
      expect(mockHistoryLoadMore).toHaveBeenCalledTimes(1);

      resolveLoadMore?.({
        messages: [],
        nextCursor: null,
        hasOlder: false,
      });

      await firstLoad;
      await secondLoad;

      const state = store.getWorkspaceState(workspaceId);
      expect(state.loadingOlderHistory).toBe(false);
      expect(state.hasOlderHistory).toBe(false);
    });

    it("ignores stale load-more responses after pagination state changes", async () => {
      const workspaceId = "history-pagination-stale-response";

      mockOnChat.mockImplementation(async function* (
        _input?: { workspaceId: string; mode?: unknown },
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
        yield createHistoryMessageEvent("msg-newer", 5);
        await Promise.resolve();
        yield { type: "caught-up", hasOlderHistory: true };
        await waitForAbortSignal(options?.signal);
      });

      let resolveLoadMore: ((value: LoadMoreResponse) => void) | undefined;
      const loadMorePromise = new Promise<LoadMoreResponse>((resolve) => {
        resolveLoadMore = resolve;
      });
      mockHistoryLoadMore.mockReturnValueOnce(loadMorePromise);

      createAndAddWorkspace(store, workspaceId);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const loadOlderPromise = store.loadOlderHistory(workspaceId);
      expect(store.getWorkspaceState(workspaceId).loadingOlderHistory).toBe(true);

      const internalHistoryPagination = (
        store as unknown as {
          historyPagination: Map<
            string,
            {
              nextCursor: { beforeHistorySequence: number; beforeMessageId?: string | null } | null;
              hasOlder: boolean;
              loading: boolean;
            }
          >;
        }
      ).historyPagination;
      // Simulate a concurrent pagination reset (e.g., live compaction boundary arriving).
      internalHistoryPagination.set(workspaceId, {
        nextCursor: null,
        hasOlder: false,
        loading: false,
      });

      resolveLoadMore?.({
        messages: [createHistoryMessageEvent("msg-stale-older", 3)],
        nextCursor: {
          beforeHistorySequence: 3,
          beforeMessageId: "msg-stale-older",
        },
        hasOlder: true,
      });

      await loadOlderPromise;

      const state = store.getWorkspaceState(workspaceId);
      expect(state.muxMessages.map((message) => message.id)).toEqual(["msg-newer"]);
      expect(state.hasOlderHistory).toBe(false);
      expect(state.loadingOlderHistory).toBe(false);
    });
  });

  describe("activity fallbacks", () => {
    it("uses activity snapshots for non-active workspace sidebar fields", async () => {
      const workspaceId = "activity-fallback-workspace";
      const activityRecency = new Date("2024-01-03T12:00:00.000Z").getTime();
      const activitySnapshot: WorkspaceActivitySnapshot = {
        recency: activityRecency,
        streaming: true,
        lastModel: "claude-sonnet-4",
        lastThinkingLevel: "high",
      };

      // Recreate the store so the first activity.list call uses this test snapshot.
      store.dispose();
      store = new WorkspaceStore(mockOnModelUsed);
      mockActivityList.mockResolvedValue({ [workspaceId]: activitySnapshot });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      store.setClient(mockClient as any);

      // Let the initial activity.list call resolve and queue its state updates.
      await new Promise((resolve) => setTimeout(resolve, 0));

      createAndAddWorkspace(
        store,
        workspaceId,
        {
          createdAt: "2020-01-01T00:00:00.000Z",
        },
        false
      );

      const state = store.getWorkspaceState(workspaceId);
      expect(state.canInterrupt).toBe(true);
      expect(state.currentModel).toBe(activitySnapshot.lastModel);
      expect(state.currentThinkingLevel).toBe(activitySnapshot.lastThinkingLevel);
      expect(state.recencyTimestamp).toBe(activitySnapshot.recency);
    });

    it("fires response-complete callback when a background workspace stops streaming", async () => {
      const activeWorkspaceId = "active-workspace";
      const backgroundWorkspaceId = "background-workspace";
      const initialRecency = new Date("2024-01-05T00:00:00.000Z").getTime();

      const backgroundStreamingSnapshot: WorkspaceActivitySnapshot = {
        recency: initialRecency,
        streaming: true,
        lastModel: "claude-sonnet-4",
        lastThinkingLevel: null,
      };

      let releaseBackgroundCompletion!: () => void;
      const backgroundCompletionReady = new Promise<void>((resolve) => {
        releaseBackgroundCompletion = resolve;
      });

      mockActivityList.mockResolvedValue({
        [backgroundWorkspaceId]: backgroundStreamingSnapshot,
      });

      mockActivitySubscribe.mockImplementation(async function* (
        _input?: void,
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<
        { workspaceId: string; activity: WorkspaceActivitySnapshot | null },
        void,
        unknown
      > {
        await backgroundCompletionReady;
        if (options?.signal?.aborted) {
          return;
        }

        yield {
          workspaceId: backgroundWorkspaceId,
          activity: {
            ...backgroundStreamingSnapshot,
            recency: initialRecency + 1,
            streaming: false,
          },
        };

        await waitForAbortSignal(options?.signal);
      });

      const onResponseComplete = mock(
        (
          _workspaceId: string,
          _messageId: string,
          _isFinal: boolean,
          _finalText: string,
          _compaction?: { hasContinueMessage: boolean },
          _completedAt?: number | null
        ) => undefined
      );

      // Recreate the store so the first activity.list call uses this test snapshot.
      store.dispose();
      store = new WorkspaceStore(mockOnModelUsed);
      store.setOnResponseComplete(onResponseComplete);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      store.setClient(mockClient as any);

      createAndAddWorkspace(store, activeWorkspaceId);
      createAndAddWorkspace(store, backgroundWorkspaceId, {}, false);

      releaseBackgroundCompletion();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onResponseComplete).toHaveBeenCalledTimes(1);
      expect(onResponseComplete).toHaveBeenCalledWith(
        backgroundWorkspaceId,
        "",
        true,
        "",
        undefined,
        initialRecency + 1
      );
    });

    it("preserves compaction continue metadata for background completion callbacks", async () => {
      const activeWorkspaceId = "active-workspace-continue";
      const backgroundWorkspaceId = "background-workspace-continue";
      const initialRecency = new Date("2024-01-08T00:00:00.000Z").getTime();

      const backgroundStreamingSnapshot: WorkspaceActivitySnapshot = {
        recency: initialRecency,
        streaming: true,
        lastModel: "claude-sonnet-4",
        lastThinkingLevel: null,
      };

      let releaseBackgroundCompletion!: () => void;
      const backgroundCompletionReady = new Promise<void>((resolve) => {
        releaseBackgroundCompletion = resolve;
      });

      mockActivityList.mockResolvedValue({
        [backgroundWorkspaceId]: backgroundStreamingSnapshot,
      });

      mockActivitySubscribe.mockImplementation(async function* (
        _input?: void,
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<
        { workspaceId: string; activity: WorkspaceActivitySnapshot | null },
        void,
        unknown
      > {
        await backgroundCompletionReady;
        if (options?.signal?.aborted) {
          return;
        }

        yield {
          workspaceId: backgroundWorkspaceId,
          activity: {
            ...backgroundStreamingSnapshot,
            recency: initialRecency + 1,
            streaming: false,
          },
        };

        await waitForAbortSignal(options?.signal);
      });

      mockOnChat.mockImplementation(async function* (
        input?: { workspaceId: string; mode?: unknown },
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
        if (input?.workspaceId !== backgroundWorkspaceId) {
          await waitForAbortSignal(options?.signal);
          return;
        }

        yield {
          type: "message",
          id: "compaction-request-msg",
          role: "user",
          parts: [{ type: "text", text: "/compact" }],
          metadata: {
            historySequence: 1,
            timestamp: Date.now(),
            muxMetadata: {
              type: "compaction-request",
              rawCommand: "/compact",
              parsed: {
                model: "claude-sonnet-4",
                followUpContent: {
                  text: "continue after compaction",
                  model: "claude-sonnet-4",
                  agentId: "exec",
                },
              },
            },
          },
        };

        yield {
          type: "stream-start",
          workspaceId: backgroundWorkspaceId,
          messageId: "compaction-stream",
          historySequence: 2,
          model: "claude-sonnet-4",
          startTime: Date.now(),
          mode: "exec",
        };

        yield { type: "caught-up", hasOlderHistory: false };

        await waitForAbortSignal(options?.signal);
      });

      const onResponseComplete = mock(
        (
          _workspaceId: string,
          _messageId: string,
          _isFinal: boolean,
          _finalText: string,
          _compaction?: { hasContinueMessage: boolean },
          _completedAt?: number | null
        ) => undefined
      );

      // Recreate the store so the first activity.list call uses this test snapshot.
      store.dispose();
      store = new WorkspaceStore(mockOnModelUsed);
      store.setOnResponseComplete(onResponseComplete);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      store.setClient(mockClient as any);

      createAndAddWorkspace(store, backgroundWorkspaceId);

      const waitUntil = async (condition: () => boolean, timeoutMs = 2000): Promise<boolean> => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (condition()) {
            return true;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return false;
      };

      const sawCompactingStream = await waitUntil(
        () => store.getWorkspaceState(backgroundWorkspaceId).isCompacting
      );
      expect(sawCompactingStream).toBe(true);

      // Move focus to a different workspace so the compaction workspace is backgrounded.
      createAndAddWorkspace(store, activeWorkspaceId);

      releaseBackgroundCompletion();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onResponseComplete).toHaveBeenCalledTimes(1);
      expect(onResponseComplete).toHaveBeenCalledWith(
        backgroundWorkspaceId,
        "",
        true,
        "",
        { hasContinueMessage: true },
        initialRecency + 1
      );
    });

    it("does not fire response-complete callback when background streaming stops without recency advance", async () => {
      const activeWorkspaceId = "active-workspace-no-replay";
      const backgroundWorkspaceId = "background-workspace-no-replay";
      const initialRecency = new Date("2024-01-06T00:00:00.000Z").getTime();

      const backgroundStreamingSnapshot: WorkspaceActivitySnapshot = {
        recency: initialRecency,
        streaming: true,
        lastModel: "claude-sonnet-4",
        lastThinkingLevel: null,
      };

      let releaseBackgroundTransition!: () => void;
      const backgroundTransitionReady = new Promise<void>((resolve) => {
        releaseBackgroundTransition = resolve;
      });

      mockActivityList.mockResolvedValue({
        [backgroundWorkspaceId]: backgroundStreamingSnapshot,
      });

      mockActivitySubscribe.mockImplementation(async function* (
        _input?: void,
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<
        { workspaceId: string; activity: WorkspaceActivitySnapshot | null },
        void,
        unknown
      > {
        await backgroundTransitionReady;
        if (options?.signal?.aborted) {
          return;
        }

        yield {
          workspaceId: backgroundWorkspaceId,
          activity: {
            ...backgroundStreamingSnapshot,
            // Abort/error transitions can stop streaming without advancing recency.
            recency: initialRecency,
            streaming: false,
          },
        };

        await waitForAbortSignal(options?.signal);
      });

      const onResponseComplete = mock(
        (
          _workspaceId: string,
          _messageId: string,
          _isFinal: boolean,
          _finalText: string,
          _compaction?: { hasContinueMessage: boolean },
          _completedAt?: number | null
        ) => undefined
      );

      // Recreate the store so the first activity.list call uses this test snapshot.
      store.dispose();
      store = new WorkspaceStore(mockOnModelUsed);
      store.setOnResponseComplete(onResponseComplete);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      store.setClient(mockClient as any);

      createAndAddWorkspace(store, activeWorkspaceId);
      createAndAddWorkspace(store, backgroundWorkspaceId, {}, false);

      releaseBackgroundTransition();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onResponseComplete).not.toHaveBeenCalled();
    });
    it("clears activity stream-start recency cache on dispose", () => {
      const workspaceId = "dispose-clears-activity-recency";
      const internalStore = store as unknown as {
        activityStreamingStartRecency: Map<string, number>;
      };

      internalStore.activityStreamingStartRecency.set(workspaceId, Date.now());
      expect(internalStore.activityStreamingStartRecency.has(workspaceId)).toBe(true);

      store.dispose();

      expect(internalStore.activityStreamingStartRecency.size).toBe(0);
    });

    it("opens activity subscription before listing snapshots", async () => {
      store.dispose();
      store = new WorkspaceStore(mockOnModelUsed);

      const callOrder: string[] = [];

      mockActivitySubscribe.mockImplementation(
        (
          _input?: void,
          options?: { signal?: AbortSignal }
        ): AsyncGenerator<
          { workspaceId: string; activity: WorkspaceActivitySnapshot | null },
          void,
          unknown
        > => {
          callOrder.push("subscribe");

          // eslint-disable-next-line require-yield
          return (async function* (): AsyncGenerator<
            { workspaceId: string; activity: WorkspaceActivitySnapshot | null },
            void,
            unknown
          > {
            await waitForAbortSignal(options?.signal);
          })();
        }
      );

      mockActivityList.mockImplementation(() => {
        callOrder.push("list");
        return Promise.resolve({});
      });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      store.setClient({ workspace: mockClient.workspace } as any);

      const waitUntil = async (condition: () => boolean, timeoutMs = 2000): Promise<boolean> => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (condition()) {
            return true;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return false;
      };

      const sawBothCalls = await waitUntil(() => callOrder.length >= 2);
      expect(sawBothCalls).toBe(true);
      expect(callOrder.slice(0, 2)).toEqual(["subscribe", "list"]);
    });

    it("preserves cached activity snapshots when list returns an empty payload", async () => {
      const workspaceId = "activity-list-empty-payload";
      const initialRecency = new Date("2024-01-07T00:00:00.000Z").getTime();
      const snapshot: WorkspaceActivitySnapshot = {
        recency: initialRecency,
        streaming: true,
        lastModel: "claude-sonnet-4",
        lastThinkingLevel: "high",
      };

      store.dispose();
      store = new WorkspaceStore(mockOnModelUsed);

      let listCallCount = 0;
      mockActivityList.mockImplementation(
        (): Promise<Record<string, WorkspaceActivitySnapshot>> => {
          listCallCount += 1;
          if (listCallCount === 1) {
            return Promise.resolve({ [workspaceId]: snapshot });
          }
          return Promise.resolve({});
        }
      );

      // eslint-disable-next-line require-yield
      mockActivitySubscribe.mockImplementation(async function* (
        _input?: void,
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<
        { workspaceId: string; activity: WorkspaceActivitySnapshot | null },
        void,
        unknown
      > {
        await waitForAbortSignal(options?.signal);
      });

      const waitUntil = async (condition: () => boolean, timeoutMs = 2000): Promise<boolean> => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (condition()) {
            return true;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return false;
      };

      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      store.setClient({ workspace: mockClient.workspace } as any);
      createAndAddWorkspace(
        store,
        workspaceId,
        {
          createdAt: "2020-01-01T00:00:00.000Z",
        },
        false
      );

      const seededSnapshot = await waitUntil(() => {
        const state = store.getWorkspaceState(workspaceId);
        return state.recencyTimestamp === initialRecency && state.canInterrupt === true;
      });
      expect(seededSnapshot).toBe(true);

      // Swap to a new client object to force activity subscription restart and a fresh list() call.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      store.setClient({ workspace: mockClient.workspace } as any);

      const sawRetryListCall = await waitUntil(() => listCallCount >= 2);
      expect(sawRetryListCall).toBe(true);

      const stateAfterEmptyList = store.getWorkspaceState(workspaceId);
      expect(stateAfterEmptyList.recencyTimestamp).toBe(initialRecency);
      expect(stateAfterEmptyList.canInterrupt).toBe(true);
      expect(stateAfterEmptyList.currentModel).toBe(snapshot.lastModel);
      expect(stateAfterEmptyList.currentThinkingLevel).toBe(snapshot.lastThinkingLevel);
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

      store.setActiveWorkspaceId(metadata.id);
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

        // Advance time without a store bump. Sidebar state should remain stable
        // because it doesn't include timing stats (those use a separate subscription).
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

      // Ignore setup emissions so this test only validates getAggregator() side effects.
      emitCount = 0;

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
        await new Promise((resolve) => setTimeout(resolve, 30));
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

      store.setActiveWorkspaceId(metadata.id);
      store.addWorkspace(metadata);

      const state1 = store.getWorkspaceState("test-workspace");

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 70));

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

      store.setActiveWorkspaceId(metadata.id);
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

    it("replays pre-caught-up bash output after full replay catches up", async () => {
      const workspaceId = "bash-output-workspace-3";

      mockOnChat.mockImplementation(async function* (): AsyncGenerator<
        WorkspaceChatMessage,
        void,
        unknown
      > {
        yield {
          type: "bash-output",
          workspaceId,
          toolCallId: "call-3",
          text: "buffered\n",
          isError: false,
          timestamp: 1,
        };
        await Promise.resolve();
        yield { type: "caught-up", replay: "full" };
      });

      createAndAddWorkspace(store, workspaceId);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const live = store.getBashToolLiveOutput(workspaceId, "call-3");
      expect(live).not.toBeNull();
      if (!live) throw new Error("Expected buffered live output after caught-up");
      expect(live.stdout).toContain("buffered");
    });
  });
  describe("task-created events", () => {
    it("exposes live taskId while the task tool is running", async () => {
      const workspaceId = "task-created-workspace-1";

      mockOnChat.mockImplementation(async function* (): AsyncGenerator<
        WorkspaceChatMessage,
        void,
        unknown
      > {
        yield { type: "caught-up" };
        await Promise.resolve();
        yield {
          type: "task-created",
          workspaceId,
          toolCallId: "call-task-1",
          taskId: "child-workspace-1",
          timestamp: 1,
        };
      });

      createAndAddWorkspace(store, workspaceId);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(store.getTaskToolLiveTaskId(workspaceId, "call-task-1")).toBe("child-workspace-1");
    });

    it("clears live taskId on task tool-call-end", async () => {
      const workspaceId = "task-created-workspace-2";

      mockOnChat.mockImplementation(async function* (): AsyncGenerator<
        WorkspaceChatMessage,
        void,
        unknown
      > {
        yield { type: "caught-up" };
        await Promise.resolve();
        yield {
          type: "task-created",
          workspaceId,
          toolCallId: "call-task-2",
          taskId: "child-workspace-2",
          timestamp: 1,
        };
        yield {
          type: "tool-call-end",
          workspaceId,
          messageId: "m-task-2",
          toolCallId: "call-task-2",
          toolName: "task",
          result: { status: "queued", taskId: "child-workspace-2" },
          timestamp: 2,
        };
      });

      createAndAddWorkspace(store, workspaceId);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(store.getTaskToolLiveTaskId(workspaceId, "call-task-2")).toBeNull();
    });

    it("preserves pagination state across since reconnect retries", async () => {
      const workspaceId = "pagination-since-retry";
      let subscriptionCount = 0;
      let releaseFirstSubscription: (() => void) | undefined;
      const holdFirstSubscription = new Promise<void>((resolve) => {
        releaseFirstSubscription = resolve;
      });

      const waitUntil = async (condition: () => boolean, timeoutMs = 2000): Promise<boolean> => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (condition()) {
            return true;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return false;
      };

      mockOnChat.mockImplementation(async function* (): AsyncGenerator<
        WorkspaceChatMessage,
        void,
        unknown
      > {
        subscriptionCount += 1;

        if (subscriptionCount === 1) {
          yield createHistoryMessageEvent("history-5", 5);
          yield {
            type: "caught-up",
            replay: "full",
            hasOlderHistory: true,
            cursor: {
              history: {
                messageId: "history-5",
                historySequence: 5,
              },
            },
          };

          await holdFirstSubscription;
          return;
        }

        yield {
          type: "caught-up",
          replay: "since",
          cursor: {
            history: {
              messageId: "history-5",
              historySequence: 5,
            },
          },
        };
      });

      createAndAddWorkspace(store, workspaceId);

      const seededPagination = await waitUntil(
        () => store.getWorkspaceState(workspaceId).hasOlderHistory === true
      );
      expect(seededPagination).toBe(true);

      releaseFirstSubscription?.();

      const preservedPagination = await waitUntil(() => {
        return (
          subscriptionCount >= 2 && store.getWorkspaceState(workspaceId).hasOlderHistory === true
        );
      });
      expect(preservedPagination).toBe(true);
    });

    it("clears stale live tool state when since replay reports no active stream", async () => {
      const workspaceId = "task-created-workspace-4";
      let subscriptionCount = 0;
      let releaseFirstSubscription: (() => void) | undefined;
      const holdFirstSubscription = new Promise<void>((resolve) => {
        releaseFirstSubscription = resolve;
      });

      const waitUntil = async (condition: () => boolean, timeoutMs = 2000): Promise<boolean> => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (condition()) {
            return true;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return false;
      };

      mockOnChat.mockImplementation(async function* (): AsyncGenerator<
        WorkspaceChatMessage,
        void,
        unknown
      > {
        subscriptionCount += 1;

        if (subscriptionCount === 1) {
          yield { type: "caught-up" };
          await Promise.resolve();
          yield {
            type: "bash-output",
            workspaceId,
            toolCallId: "call-bash-4",
            text: "stale-output\n",
            isError: false,
            timestamp: 1,
          };
          yield {
            type: "task-created",
            workspaceId,
            toolCallId: "call-task-4",
            taskId: "child-workspace-4",
            timestamp: 2,
          };

          await holdFirstSubscription;
          return;
        }

        yield {
          type: "caught-up",
          replay: "since",
          cursor: {
            history: {
              messageId: "history-1",
              historySequence: 1,
            },
          },
        };
      });

      createAndAddWorkspace(store, workspaceId);

      const seededLiveState = await waitUntil(() => {
        return (
          store.getBashToolLiveOutput(workspaceId, "call-bash-4") !== null &&
          store.getTaskToolLiveTaskId(workspaceId, "call-task-4") === "child-workspace-4"
        );
      });
      expect(seededLiveState).toBe(true);

      releaseFirstSubscription?.();

      const clearedLiveState = await waitUntil(() => {
        return (
          subscriptionCount >= 2 &&
          store.getBashToolLiveOutput(workspaceId, "call-bash-4") === null &&
          store.getTaskToolLiveTaskId(workspaceId, "call-task-4") === null
        );
      });
      expect(clearedLiveState).toBe(true);
    });

    it("clears stale live tool state when server stream exists but local stream context is missing", async () => {
      const workspaceId = "task-created-workspace-7";
      let subscriptionCount = 0;
      let releaseFirstSubscription: (() => void) | undefined;
      const holdFirstSubscription = new Promise<void>((resolve) => {
        releaseFirstSubscription = resolve;
      });

      const waitUntil = async (condition: () => boolean, timeoutMs = 2000): Promise<boolean> => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (condition()) {
            return true;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return false;
      };

      mockOnChat.mockImplementation(async function* (): AsyncGenerator<
        WorkspaceChatMessage,
        void,
        unknown
      > {
        subscriptionCount += 1;

        if (subscriptionCount === 1) {
          yield { type: "caught-up" };
          await Promise.resolve();
          yield {
            type: "stream-start",
            workspaceId,
            messageId: "msg-old-stream-missing-local",
            historySequence: 1,
            model: "claude-3-5-sonnet-20241022",
            startTime: 1_000,
          };
          yield {
            type: "bash-output",
            workspaceId,
            toolCallId: "call-bash-7",
            text: "stale-after-end\n",
            isError: false,
            timestamp: 1_001,
          };
          yield {
            type: "task-created",
            workspaceId,
            toolCallId: "call-task-7",
            taskId: "child-workspace-7",
            timestamp: 1_002,
          };
          yield {
            type: "stream-end",
            workspaceId,
            messageId: "msg-old-stream-missing-local",
            metadata: {
              model: "claude-3-5-sonnet-20241022",
              historySequence: 1,
              timestamp: 1_003,
            },
            parts: [],
          };

          await holdFirstSubscription;
          return;
        }

        yield {
          type: "caught-up",
          replay: "since",
          cursor: {
            history: {
              messageId: "history-1",
              historySequence: 1,
            },
            stream: {
              messageId: "msg-new-stream-missing-local",
              lastTimestamp: 2_000,
            },
          },
        };
      });

      createAndAddWorkspace(store, workspaceId);

      const seededStaleLiveState = await waitUntil(() => {
        return (
          store.getAggregator(workspaceId)?.getOnChatCursor()?.stream === undefined &&
          store.getBashToolLiveOutput(workspaceId, "call-bash-7") !== null &&
          store.getTaskToolLiveTaskId(workspaceId, "call-task-7") === "child-workspace-7"
        );
      });
      expect(seededStaleLiveState).toBe(true);

      releaseFirstSubscription?.();

      const clearedStaleLiveState = await waitUntil(() => {
        return (
          subscriptionCount >= 2 &&
          store.getBashToolLiveOutput(workspaceId, "call-bash-7") === null &&
          store.getTaskToolLiveTaskId(workspaceId, "call-task-7") === null
        );
      });
      expect(clearedStaleLiveState).toBe(true);
    });

    it("clears stale active stream context when since replay reports a different stream", async () => {
      const workspaceId = "task-created-workspace-5";
      let subscriptionCount = 0;
      let releaseFirstSubscription: (() => void) | undefined;
      const holdFirstSubscription = new Promise<void>((resolve) => {
        releaseFirstSubscription = resolve;
      });

      const waitUntil = async (condition: () => boolean, timeoutMs = 2000): Promise<boolean> => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (condition()) {
            return true;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return false;
      };

      mockOnChat.mockImplementation(async function* (): AsyncGenerator<
        WorkspaceChatMessage,
        void,
        unknown
      > {
        subscriptionCount += 1;

        if (subscriptionCount === 1) {
          yield { type: "caught-up" };
          await Promise.resolve();
          yield {
            type: "stream-start",
            workspaceId,
            messageId: "msg-old-stream",
            historySequence: 1,
            model: "claude-3-5-sonnet-20241022",
            startTime: 1_000,
          };
          yield {
            type: "bash-output",
            workspaceId,
            toolCallId: "call-bash-5",
            text: "old-stream-output\n",
            isError: false,
            timestamp: 1_001,
          };
          yield {
            type: "task-created",
            workspaceId,
            toolCallId: "call-task-5",
            taskId: "child-workspace-5",
            timestamp: 1_002,
          };

          await holdFirstSubscription;
          return;
        }

        yield {
          type: "caught-up",
          replay: "since",
          cursor: {
            history: {
              messageId: "history-1",
              historySequence: 1,
            },
            stream: {
              messageId: "msg-new-stream",
              lastTimestamp: 2_000,
            },
          },
        };
        await Promise.resolve();
        yield {
          type: "stream-start",
          workspaceId,
          messageId: "msg-new-stream",
          historySequence: 2,
          model: "claude-3-5-sonnet-20241022",
          startTime: 2_000,
        };
      });

      createAndAddWorkspace(store, workspaceId);

      const seededOldStream = await waitUntil(() => {
        return (
          store.getAggregator(workspaceId)?.getOnChatCursor()?.stream?.messageId ===
          "msg-old-stream"
        );
      });
      expect(seededOldStream).toBe(true);
      expect(store.getBashToolLiveOutput(workspaceId, "call-bash-5")?.stdout).toContain(
        "old-stream-output"
      );
      expect(store.getTaskToolLiveTaskId(workspaceId, "call-task-5")).toBe("child-workspace-5");

      releaseFirstSubscription?.();

      const switchedToNewStream = await waitUntil(() => {
        return (
          subscriptionCount >= 2 &&
          store.getAggregator(workspaceId)?.getOnChatCursor()?.stream?.messageId ===
            "msg-new-stream" &&
          store.getBashToolLiveOutput(workspaceId, "call-bash-5") === null &&
          store.getTaskToolLiveTaskId(workspaceId, "call-task-5") === null
        );
      });
      expect(switchedToNewStream).toBe(true);
    });

    it("clears stale abort reason when since reconnect is downgraded to full replay", async () => {
      const workspaceId = "task-created-workspace-6";
      let subscriptionCount = 0;
      let releaseFirstSubscription: (() => void) | undefined;
      const holdFirstSubscription = new Promise<void>((resolve) => {
        releaseFirstSubscription = resolve;
      });

      const waitUntil = async (condition: () => boolean, timeoutMs = 2000): Promise<boolean> => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (condition()) {
            return true;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return false;
      };

      mockOnChat.mockImplementation(async function* (): AsyncGenerator<
        WorkspaceChatMessage,
        void,
        unknown
      > {
        subscriptionCount += 1;

        if (subscriptionCount === 1) {
          yield { type: "caught-up" };
          await Promise.resolve();
          yield {
            type: "stream-start",
            workspaceId,
            messageId: "msg-abort-old-stream",
            historySequence: 1,
            model: "claude-3-5-sonnet-20241022",
            startTime: 1_000,
          };
          yield {
            type: "stream-abort",
            workspaceId,
            messageId: "msg-abort-old-stream",
            abortReason: "user",
            metadata: {},
          };

          await holdFirstSubscription;
          return;
        }

        yield {
          type: "caught-up",
          replay: "full",
        };
      });

      createAndAddWorkspace(store, workspaceId);

      const seededAbortReason = await waitUntil(() => {
        return store.getWorkspaceState(workspaceId).lastAbortReason?.reason === "user";
      });
      expect(seededAbortReason).toBe(true);

      releaseFirstSubscription?.();

      const clearedAbortReason = await waitUntil(() => {
        return (
          subscriptionCount >= 2 && store.getWorkspaceState(workspaceId).lastAbortReason === null
        );
      });
      expect(clearedAbortReason).toBe(true);
    });

    it("clears stale auto-retry status when full replay reconnect replaces history", async () => {
      const workspaceId = "task-created-workspace-auto-retry-reset";
      let subscriptionCount = 0;
      let releaseFirstSubscription: (() => void) | undefined;
      const holdFirstSubscription = new Promise<void>((resolve) => {
        releaseFirstSubscription = resolve;
      });

      const waitUntil = async (condition: () => boolean, timeoutMs = 2000): Promise<boolean> => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (condition()) {
            return true;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return false;
      };

      mockOnChat.mockImplementation(async function* (): AsyncGenerator<
        WorkspaceChatMessage,
        void,
        unknown
      > {
        subscriptionCount += 1;

        if (subscriptionCount === 1) {
          yield { type: "caught-up" };
          await Promise.resolve();
          yield {
            type: "auto-retry-starting",
            attempt: 2,
          };

          await holdFirstSubscription;
          return;
        }

        yield {
          type: "caught-up",
          replay: "full",
        };
      });

      createAndAddWorkspace(store, workspaceId);

      const seededRetryStatus = await waitUntil(() => {
        return store.getWorkspaceState(workspaceId).autoRetryStatus?.type === "auto-retry-starting";
      });
      expect(seededRetryStatus).toBe(true);

      releaseFirstSubscription?.();

      const clearedRetryStatus = await waitUntil(() => {
        return (
          subscriptionCount >= 2 && store.getWorkspaceState(workspaceId).autoRetryStatus === null
        );
      });
      expect(clearedRetryStatus).toBe(true);
    });

    it("replays pre-caught-up task-created after full replay catches up", async () => {
      const workspaceId = "task-created-workspace-3";

      mockOnChat.mockImplementation(async function* (): AsyncGenerator<
        WorkspaceChatMessage,
        void,
        unknown
      > {
        yield {
          type: "task-created",
          workspaceId,
          toolCallId: "call-task-3",
          taskId: "child-workspace-3",
          timestamp: 1,
        };
        await Promise.resolve();
        yield { type: "caught-up", replay: "full" };
      });

      createAndAddWorkspace(store, workspaceId);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(store.getTaskToolLiveTaskId(workspaceId, "call-task-3")).toBe("child-workspace-3");
    });
  });
});

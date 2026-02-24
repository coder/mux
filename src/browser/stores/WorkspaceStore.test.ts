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

const mockGetSessionUsage = mock((_input: { workspaceId: string }) =>
  Promise.resolve<unknown>(undefined)
);
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

type TerminalActivityEvent =
  | {
      type: "snapshot";
      workspaces: Record<string, { activeCount: number; totalSessions: number }>;
    }
  | {
      type: "update";
      workspaceId: string;
      activity: { activeCount: number; totalSessions: number };
    };

// eslint-disable-next-line require-yield
const mockTerminalActivitySubscribe = mock(async function* (
  _input?: void,
  options?: { signal?: AbortSignal }
): AsyncGenerator<TerminalActivityEvent, void, unknown> {
  await waitForAbortSignal(options?.signal);
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
  terminal: {
    activity: {
      subscribe: mockTerminalActivitySubscribe,
    },
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
    mockTerminalActivitySubscribe.mockClear();
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
      expect(stateAfterCaughtUp.isHydratingTranscript).toBe(false);

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

    it("does not pin hydration while waiting for the chat client", async () => {
      const workspaceId = "workspace-awaiting-client";

      store.setClient(null);
      createAndAddWorkspace(store, workspaceId, {}, false);

      store.setActiveWorkspaceId(workspaceId);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(store.getWorkspaceState(workspaceId).isHydratingTranscript).toBe(false);
      expect(mockOnChat).not.toHaveBeenCalled();
    });

    it("clears hydration after first pre-caught-up failure when client disconnects", async () => {
      const workspaceId = "workspace-hydration-first-failure-offline";
      let attempts = 0;
      let resolveFirstFailure!: () => void;
      const firstFailure = new Promise<void>((resolve) => {
        resolveFirstFailure = resolve;
      });

      // eslint-disable-next-line require-yield
      mockOnChat.mockImplementation(async function* (
        _input?: { workspaceId: string; mode?: unknown },
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
        attempts += 1;
        if (attempts === 1) {
          resolveFirstFailure();
          throw new Error("first-retry-failure");
        }

        await waitForAbortSignal(options?.signal);
      });

      createAndAddWorkspace(store, workspaceId, {}, false);
      store.setActiveWorkspaceId(workspaceId);
      await firstFailure;

      // Simulate transport/client loss before a second retry can catch up.
      store.setClient(null);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(store.getWorkspaceState(workspaceId).isHydratingTranscript).toBe(false);
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
              isHydratingTranscript: boolean;
              replayingHistory: boolean;
              historicalMessages: WorkspaceChatMessage[];
              pendingStreamEvents: WorkspaceChatMessage[];
            }
          >;
        }
      ).chatTransientState.get("workspace-1");
      expect(transientState).toBeDefined();

      transientState!.caughtUp = false;
      transientState!.isHydratingTranscript = true;
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
      expect(transientState!.isHydratingTranscript).toBe(false);
      expect(transientState!.replayingHistory).toBe(false);
      expect(transientState!.historicalMessages).toHaveLength(0);
      expect(transientState!.pendingStreamEvents).toHaveLength(0);
      expect(store.getWorkspaceState("workspace-2").isHydratingTranscript).toBe(true);
    });
    it("keeps transcript hydration active across full replay resets", async () => {
      const workspaceId = "workspace-full-replay-hydration";

      mockOnChat.mockImplementation(async function* (
        _input?: { workspaceId: string; mode?: unknown },
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
        // Full replay path emits history rows before the caught-up marker.
        yield createHistoryMessageEvent("history-before-caught-up", 11);
        await waitForAbortSignal(options?.signal);
      });

      createAndAddWorkspace(store, workspaceId, {}, false);
      store.setActiveWorkspaceId(workspaceId);

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Hydration should stay active until an authoritative caught-up marker arrives,
      // even if replay reset rebuilt transient state.
      expect(store.getWorkspaceState(workspaceId).isHydratingTranscript).toBe(true);
    });

    it("clears transcript hydration after repeated catch-up retry failures", async () => {
      const workspaceId = "workspace-hydration-retry-fallback";
      let attempts = 0;

      // eslint-disable-next-line require-yield
      mockOnChat.mockImplementation(async function* (
        _input?: { workspaceId: string; mode?: unknown },
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
        attempts += 1;
        if (attempts <= 2) {
          throw new Error(`retry-failure-${attempts}`);
        }

        await waitForAbortSignal(options?.signal);
      });

      createAndAddWorkspace(store, workspaceId, {}, false);
      store.setActiveWorkspaceId(workspaceId);

      const startedAt = Date.now();
      while (mockOnChat.mock.calls.length < 3 && Date.now() - startedAt < 3_000) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(mockOnChat.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(store.getWorkspaceState(workspaceId).isHydratingTranscript).toBe(false);
    });

    it("clears transcript hydration when retries keep replaying partial history without caught-up", async () => {
      const workspaceId = "workspace-hydration-partial-replay-fallback";
      let attempts = 0;

      mockOnChat.mockImplementation(async function* (
        _input?: { workspaceId: string; mode?: unknown },
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
        attempts += 1;

        // Simulate flaky reconnects that emit some replay rows, then terminate
        // before caught-up can arrive.
        yield createHistoryMessageEvent(`partial-history-${attempts}`, attempts);
        if (attempts <= 2) {
          return;
        }

        await waitForAbortSignal(options?.signal);
      });

      createAndAddWorkspace(store, workspaceId, {}, false);
      store.setActiveWorkspaceId(workspaceId);

      const startedAt = Date.now();
      while (mockOnChat.mock.calls.length < 3 && Date.now() - startedAt < 3_000) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(mockOnChat.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(store.getWorkspaceState(workspaceId).isHydratingTranscript).toBe(false);
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

  describe("session usage refresh on activation", () => {
    it("re-fetches persisted session usage when switching to an inactive workspace", async () => {
      const sessionUsageData = {
        byModel: {
          "claude-sonnet-4": {
            input: { tokens: 1000, cost_usd: 0.003 },
            cached: { tokens: 0, cost_usd: 0 },
            cacheCreate: { tokens: 0, cost_usd: 0 },
            output: { tokens: 100, cost_usd: 0.0015 },
            reasoning: { tokens: 0, cost_usd: 0 },
          },
        },
        version: 1 as const,
      };

      mockGetSessionUsage.mockImplementation(({ workspaceId }: { workspaceId: string }) => {
        if (workspaceId === "workspace-2") {
          return Promise.resolve(sessionUsageData);
        }
        return Promise.resolve(undefined);
      });

      createAndAddWorkspace(store, "workspace-1", {}, false);
      createAndAddWorkspace(store, "workspace-2", {}, false);

      store.setActiveWorkspaceId("workspace-1");
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Clear call history to isolate the activation fetch.
      mockGetSessionUsage.mockClear();

      store.setActiveWorkspaceId("workspace-2");
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Activation should trigger a fresh fetch for workspace-2.
      expect(mockGetSessionUsage).toHaveBeenCalledWith({ workspaceId: "workspace-2" });

      const usage = store.getWorkspaceUsage("workspace-2");
      expect(usage.sessionTotal).toBeDefined();
      expect(usage.sessionTotal!.input.tokens).toBe(1000);
    });

    it("ignores stale session-usage fetch when a newer refresh supersedes it", async () => {
      let resolveFirst!: (value: unknown) => void;
      const firstFetch = new Promise((resolve) => {
        resolveFirst = resolve;
      });

      const freshData = {
        byModel: {
          "claude-sonnet-4": {
            input: { tokens: 9999, cost_usd: 0.03 },
            cached: { tokens: 0, cost_usd: 0 },
            cacheCreate: { tokens: 0, cost_usd: 0 },
            output: { tokens: 500, cost_usd: 0.0075 },
            reasoning: { tokens: 0, cost_usd: 0 },
          },
        },
        version: 1 as const,
      };

      const staleData = {
        byModel: {
          "claude-sonnet-4": {
            input: { tokens: 1, cost_usd: 0.000003 },
            cached: { tokens: 0, cost_usd: 0 },
            cacheCreate: { tokens: 0, cost_usd: 0 },
            output: { tokens: 1, cost_usd: 0.0000015 },
            reasoning: { tokens: 0, cost_usd: 0 },
          },
        },
        version: 1 as const,
      };

      let callCount = 0;
      mockGetSessionUsage.mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          // First two calls (addWorkspace + first activation) are slow responses.
          return firstFetch;
        }
        // Third call (second activation) resolves immediately with fresh data.
        return Promise.resolve(freshData);
      });

      createAndAddWorkspace(store, "workspace-1", {}, false);
      store.setActiveWorkspaceId("workspace-1");
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Trigger a second activation (rapid switch away and back).
      store.setActiveWorkspaceId(null);
      store.setActiveWorkspaceId("workspace-1");
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Now resolve the stale first fetch.
      resolveFirst(staleData);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // The stale response should be ignored; fresh data should win.
      const usage = store.getWorkspaceUsage("workspace-1");
      expect(usage.sessionTotal).toBeDefined();
      expect(usage.sessionTotal!.input.tokens).toBe(9999);
    });
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
        isHydratingTranscript: true,
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
        agentStatus: { emoji: "🔧", message: "Running checks", url: "https://example.com" },
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
      expect(state.agentStatus).toEqual(activitySnapshot.agentStatus ?? undefined);
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
          _compaction?: { hasContinueMessage: boolean; isIdle?: boolean },
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
          _compaction?: { hasContinueMessage: boolean; isIdle?: boolean },
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

    it("marks compaction completions with queued follow-up as continue for active callbacks", async () => {
      const workspaceId = "active-workspace-queued-follow-up";

      mockOnChat.mockImplementation(async function* (
        input?: { workspaceId: string; mode?: unknown },
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<WorkspaceChatMessage, void, unknown> {
        if (input?.workspaceId !== workspaceId) {
          await waitForAbortSignal(options?.signal);
          return;
        }

        const timestamp = Date.now();

        yield { type: "caught-up", hasOlderHistory: false };

        yield {
          type: "message",
          id: "compaction-request-msg",
          role: "user",
          parts: [{ type: "text", text: "/compact" }],
          metadata: {
            historySequence: 1,
            timestamp,
            muxMetadata: {
              type: "compaction-request",
              rawCommand: "/compact",
              parsed: {
                model: "claude-sonnet-4",
              },
            },
          },
        };

        yield {
          type: "stream-start",
          workspaceId,
          messageId: "compaction-stream",
          historySequence: 2,
          model: "claude-sonnet-4",
          startTime: timestamp + 1,
          mode: "compact",
        };

        // A queued message will be auto-sent by the backend when compaction stream ends.
        yield {
          type: "queued-message-changed",
          workspaceId,
          queuedMessages: ["follow-up after compaction"],
          displayText: "follow-up after compaction",
        };

        yield {
          type: "stream-end",
          workspaceId,
          messageId: "compaction-stream",
          metadata: {
            model: "claude-sonnet-4",
          },
          parts: [],
        };

        await waitForAbortSignal(options?.signal);
      });

      const onResponseComplete = mock(
        (
          _workspaceId: string,
          _messageId: string,
          _isFinal: boolean,
          _finalText: string,
          _compaction?: { hasContinueMessage: boolean; isIdle?: boolean },
          _completedAt?: number | null
        ) => undefined
      );

      store.dispose();
      store = new WorkspaceStore(mockOnModelUsed);
      store.setOnResponseComplete(onResponseComplete);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      store.setClient(mockClient as any);

      createAndAddWorkspace(store, workspaceId);

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

      const sawResponseComplete = await waitUntil(() => onResponseComplete.mock.calls.length > 0);
      expect(sawResponseComplete).toBe(true);

      expect(onResponseComplete).toHaveBeenCalledTimes(1);
      expect(onResponseComplete).toHaveBeenCalledWith(
        workspaceId,
        "compaction-stream",
        true,
        "",
        { hasContinueMessage: true },
        expect.any(Number)
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
          _compaction?: { hasContinueMessage: boolean; isIdle?: boolean },
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
      store.setClient({ workspace: mockClient.workspace, terminal: mockClient.terminal } as any);

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
      store.setClient({ workspace: mockClient.workspace, terminal: mockClient.terminal } as any);
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
      store.setClient({ workspace: mockClient.workspace, terminal: mockClient.terminal } as any);

      const sawRetryListCall = await waitUntil(() => listCallCount >= 2);
      expect(sawRetryListCall).toBe(true);

      const stateAfterEmptyList = store.getWorkspaceState(workspaceId);
      expect(stateAfterEmptyList.recencyTimestamp).toBe(initialRecency);
      expect(stateAfterEmptyList.canInterrupt).toBe(true);
      expect(stateAfterEmptyList.currentModel).toBe(snapshot.lastModel);
      expect(stateAfterEmptyList.currentThinkingLevel).toBe(snapshot.lastThinkingLevel);
    });
  });

  describe("terminal activity", () => {
    it("propagates terminal activity to sidebar state", async () => {
      const workspaceId = "terminal-activity-workspace";
      const events: TerminalActivityEvent[] = [
        {
          type: "snapshot",
          workspaces: {
            [workspaceId]: { activeCount: 2, totalSessions: 3 },
          },
        },
      ];

      const terminalSubscribeMock = mock(async function* (
        _input?: void,
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<TerminalActivityEvent, void, unknown> {
        for (const event of events) {
          yield event;
        }
        await waitForAbortSignal(options?.signal);
      });

      const testClient = {
        ...mockClient,
        terminal: {
          activity: {
            subscribe: terminalSubscribeMock,
          },
        },
      };

      store.dispose();
      store = new WorkspaceStore(mockOnModelUsed);
      store.syncWorkspaces(
        new Map([
          [
            workspaceId,
            {
              id: workspaceId,
              name: "test-branch",
              projectName: "test-project",
              projectPath: "/test",
              namedWorkspacePath: "/test/test-branch",
              createdAt: "2024-01-01T00:00:00.000Z",
              runtimeConfig: DEFAULT_RUNTIME_CONFIG,
            } satisfies FrontendWorkspaceMetadata,
          ],
        ])
      );

      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      store.setClient(testClient as any);

      await new Promise((resolve) => setTimeout(resolve, 50));

      const sidebarState = store.getWorkspaceSidebarState(workspaceId);
      expect(sidebarState.terminalActiveCount).toBe(2);
      expect(sidebarState.terminalSessionCount).toBe(3);
    });

    it("treats missing terminal.activity.subscribe as unsupported capability (no crash/retry)", async () => {
      const workspaceId = "partial-client-workspace";

      store.dispose();
      store = new WorkspaceStore(mockOnModelUsed);

      store.syncWorkspaces(
        new Map([
          [
            workspaceId,
            {
              id: workspaceId,
              name: "partial-branch",
              projectName: "test-project",
              projectPath: "/test",
              namedWorkspacePath: "/test/partial-branch",
              createdAt: "2024-01-01T00:00:00.000Z",
              runtimeConfig: DEFAULT_RUNTIME_CONFIG,
            } satisfies FrontendWorkspaceMetadata,
          ],
        ])
      );

      // Client with terminal namespace but no activity.subscribe — should not throw.
      const partialClient = {
        workspace: mockClient.workspace,
        terminal: {},
      };

      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      store.setClient(partialClient as any);

      await new Promise((resolve) => setTimeout(resolve, 50));

      const sidebarState = store.getWorkspaceSidebarState(workspaceId);
      expect(sidebarState.terminalActiveCount).toBe(0);
      expect(sidebarState.terminalSessionCount).toBe(0);
    });

    it("re-arms terminal activity after unsupported client is replaced with supported client", async () => {
      const workspaceId = "rearm-terminal-workspace";

      store.dispose();
      store = new WorkspaceStore(mockOnModelUsed);
      store.syncWorkspaces(
        new Map([
          [
            workspaceId,
            {
              id: workspaceId,
              name: "rearm-branch",
              projectName: "test-project",
              projectPath: "/test",
              namedWorkspacePath: "/test/rearm-branch",
              createdAt: "2024-01-01T00:00:00.000Z",
              runtimeConfig: DEFAULT_RUNTIME_CONFIG,
            } satisfies FrontendWorkspaceMetadata,
          ],
        ])
      );

      // First: set an unsupported client (no terminal.activity.subscribe)
      const partialClient = {
        workspace: mockClient.workspace,
        terminal: {},
      };
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      store.setClient(partialClient as any);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Confirm terminal counts are zero after unsupported client.
      expect(store.getWorkspaceSidebarState(workspaceId).terminalActiveCount).toBe(0);
      expect(store.getWorkspaceSidebarState(workspaceId).terminalSessionCount).toBe(0);

      // Second: replace with a supported client that has terminal.activity.subscribe.
      const terminalSubscribeMock = mock(async function* (
        _input?: void,
        options?: { signal?: AbortSignal }
      ): AsyncGenerator<TerminalActivityEvent, void, unknown> {
        yield {
          type: "snapshot",
          workspaces: {
            [workspaceId]: { activeCount: 1, totalSessions: 2 },
          },
        };
        await waitForAbortSignal(options?.signal);
      });

      const fullClient = {
        ...mockClient,
        terminal: {
          activity: {
            subscribe: terminalSubscribeMock,
          },
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      store.setClient(fullClient as any);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The subscription should start after the supported client is set.
      expect(terminalSubscribeMock).toHaveBeenCalled();
      const sidebarState = store.getWorkspaceSidebarState(workspaceId);
      expect(sidebarState.terminalActiveCount).toBe(1);
      expect(sidebarState.terminalSessionCount).toBe(2);
    });

    it("defaults terminal counts to zero when no activity", () => {
      const workspaceId = "no-terminal-workspace";

      store.dispose();
      store = new WorkspaceStore(mockOnModelUsed);

      store.syncWorkspaces(
        new Map([
          [
            workspaceId,
            {
              id: workspaceId,
              name: "empty-branch",
              projectName: "test-project",
              projectPath: "/test",
              namedWorkspacePath: "/test/empty-branch",
              createdAt: "2024-01-01T00:00:00.000Z",
              runtimeConfig: DEFAULT_RUNTIME_CONFIG,
            } satisfies FrontendWorkspaceMetadata,
          ],
        ])
      );

      const sidebarState = store.getWorkspaceSidebarState(workspaceId);
      expect(sidebarState.terminalActiveCount).toBe(0);
      expect(sidebarState.terminalSessionCount).toBe(0);
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

    it("preserves usage state while full replay resets the aggregator", async () => {
      const workspaceId = "usage-reset-replay-workspace";
      let subscriptionCount = 0;
      let releaseFirstSubscription: (() => void) | undefined;
      const holdFirstSubscription = new Promise<void>((resolve) => {
        releaseFirstSubscription = resolve;
      });

      let releaseSecondCaughtUp: (() => void) | undefined;
      const holdSecondCaughtUp = new Promise<void>((resolve) => {
        releaseSecondCaughtUp = resolve;
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
            messageId: "msg-live-usage",
            historySequence: 1,
            model: "claude-3-5-sonnet-20241022",
            startTime: 1,
          };
          yield {
            type: "usage-delta",
            workspaceId,
            messageId: "msg-live-usage",
            usage: { inputTokens: 321, outputTokens: 9, totalTokens: 330 },
            cumulativeUsage: { inputTokens: 500, outputTokens: 15, totalTokens: 515 },
          };

          await holdFirstSubscription;
          return;
        }

        if (subscriptionCount === 2) {
          // Hold caught-up so the test can inspect usage after resetChatStateForReplay()
          // cleared the aggregator but before replay completion.
          await holdSecondCaughtUp;
          yield { type: "caught-up", replay: "full" };
          return;
        }

        await waitForAbortSignal();
      });

      createAndAddWorkspace(store, workspaceId);

      const seededUsage = await waitUntil(() => {
        const aggregator = store.getAggregator(workspaceId);
        return aggregator?.getActiveStreamUsage("msg-live-usage")?.inputTokens === 321;
      });
      expect(seededUsage).toBe(true);

      releaseFirstSubscription?.();

      const startedSecondSubscription = await waitUntil(() => subscriptionCount >= 2);
      expect(startedSecondSubscription).toBe(true);

      const usageDuringReplay = store.getWorkspaceUsage(workspaceId);
      expect(usageDuringReplay.liveUsage?.input.tokens).toBe(321);
      expect(usageDuringReplay.liveCostUsage?.input.tokens).toBe(500);

      releaseSecondCaughtUp?.();
      await new Promise((resolve) => setTimeout(resolve, 10));

      const usageAfterCaughtUp = store.getWorkspaceUsage(workspaceId);
      expect(usageAfterCaughtUp.liveUsage).toBeUndefined();
    });

    it("clears replay usage snapshot when reconnect fails before caught-up", async () => {
      const workspaceId = "usage-reset-replay-failure-workspace";
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
            messageId: "msg-live-usage-failure",
            historySequence: 1,
            model: "claude-3-5-sonnet-20241022",
            startTime: 1,
          };
          yield {
            type: "usage-delta",
            workspaceId,
            messageId: "msg-live-usage-failure",
            usage: { inputTokens: 111, outputTokens: 9, totalTokens: 120 },
            cumulativeUsage: { inputTokens: 300, outputTokens: 15, totalTokens: 315 },
          };
          // Keep two active streams so reconnect cannot build a safe incremental cursor.
          // This forces a full replay attempt, which executes resetChatStateForReplay().
          yield {
            type: "stream-start",
            workspaceId,
            messageId: "msg-live-usage-failure-2",
            historySequence: 2,
            model: "claude-3-5-sonnet-20241022",
            startTime: 2,
          };

          await holdFirstSubscription;
          return;
        }

        if (subscriptionCount === 2) {
          // Simulate reconnect failure before authoritative caught-up.
          await Promise.resolve();
          return;
        }

        await waitForAbortSignal();
      });

      createAndAddWorkspace(store, workspaceId);

      const seededUsage = await waitUntil(() => {
        const aggregator = store.getAggregator(workspaceId);
        return aggregator?.getActiveStreamUsage("msg-live-usage-failure")?.inputTokens === 111;
      });
      expect(seededUsage).toBe(true);

      releaseFirstSubscription?.();

      const startedSecondSubscription = await waitUntil(() => subscriptionCount >= 2);
      expect(startedSecondSubscription).toBe(true);

      const usageSnapshotCleared = await waitUntil(() => {
        const usage = store.getWorkspaceUsage(workspaceId);
        return usage.liveUsage === undefined && usage.liveCostUsage === undefined;
      });
      expect(usageSnapshotCleared).toBe(true);
    });

    it("uses compaction boundary context usage when it is the newest usage in the active epoch", async () => {
      const workspaceId = "boundary-context-usage-workspace";

      mockOnChat.mockImplementation(async function* (): AsyncGenerator<
        WorkspaceChatMessage,
        void,
        unknown
      > {
        await Promise.resolve();
        yield {
          type: "message",
          id: "pre-boundary-assistant",
          role: "assistant",
          parts: [{ type: "text", text: "Older context usage" }],
          metadata: {
            historySequence: 1,
            timestamp: 1,
            model: "claude-3-5-sonnet-20241022",
            contextUsage: { inputTokens: 999, outputTokens: 10, totalTokens: undefined },
          },
        };

        yield {
          type: "message",
          id: "compaction-boundary-summary",
          role: "assistant",
          parts: [{ type: "text", text: "Compacted summary" }],
          metadata: {
            historySequence: 2,
            timestamp: 2,
            model: "claude-3-5-sonnet-20241022",
            compacted: "idle",
            compactionBoundary: true,
            compactionEpoch: 1,
            contextUsage: { inputTokens: 42, outputTokens: 0, totalTokens: undefined },
          },
        };

        yield { type: "caught-up" };
      });

      createAndAddWorkspace(store, workspaceId);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const usage = store.getWorkspaceUsage(workspaceId);
      expect(usage.lastContextUsage?.input.tokens).toBe(42);
      expect(usage.lastContextUsage?.output.tokens).toBe(0);
      expect(usage.lastContextUsage?.model).toBe("claude-3-5-sonnet-20241022");
    });
  });
});

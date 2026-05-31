import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, type RenderResult } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

import { readPersistedState } from "@/browser/hooks/usePersistedState";
import {
  useWorkspaceStoreRaw as getWorkspaceStoreRaw,
  type WorkspaceSidebarState,
  type WorkspaceState,
} from "@/browser/stores/WorkspaceStore";
import { getImmersiveReviewAgentBarExpandedKey } from "@/common/constants/storage";
import type { TodoItem } from "@/common/types/tools";
import { ImmersiveReviewAgentStatusBar } from "./ImmersiveReviewAgentStatusBar";

interface SeedInput {
  todos: TodoItem[];
  canInterrupt?: boolean;
  isStarting?: boolean;
  awaitingUserQuestion?: boolean;
}

interface SeedCache {
  state: WorkspaceState;
  sidebar: WorkspaceSidebarState;
}

// Cache the built snapshots per workspace so getWorkspaceState/getWorkspaceSidebarState
// return referentially-stable objects (useSyncExternalStore would otherwise loop).
const seeds = new Map<string, SeedCache>();
const subscribers = new Map<string, Set<() => void>>();

function getSubscribers(workspaceId: string): Set<() => void> {
  let set = subscribers.get(workspaceId);
  if (!set) {
    set = new Set();
    subscribers.set(workspaceId, set);
  }
  return set;
}

function buildState(workspaceId: string, input: SeedInput): WorkspaceState {
  return {
    name: workspaceId,
    messages: [],
    queuedMessage: null,
    canInterrupt: input.canInterrupt ?? false,
    isCompacting: false,
    isStreamStarting: input.isStarting ?? false,
    awaitingUserQuestion: input.awaitingUserQuestion ?? false,
    loading: false,
    isHydratingTranscript: false,
    hasOlderHistory: false,
    loadingOlderHistory: false,
    muxMessages: [],
    currentModel: null,
    currentThinkingLevel: null,
    recencyTimestamp: null,
    todos: input.todos,
    loadedSkills: [],
    skillLoadErrors: [],
    agentStatus: undefined,
    lastAbortReason: null,
    pendingStreamStartTime: null,
    pendingStreamModel: null,
    runtimeStatus: null,
    autoRetryStatus: null,
  };
}

function buildSidebar(input: SeedInput): WorkspaceSidebarState {
  return {
    canInterrupt: input.canInterrupt ?? false,
    isStarting: input.isStarting ?? false,
    awaitingUserQuestion: input.awaitingUserQuestion ?? false,
    lastAbortReason: null,
    currentModel: null,
    pendingStreamModel: null,
    recencyTimestamp: null,
    loadedSkills: [],
    skillLoadErrors: [],
    agentStatus: undefined,
    terminalActiveCount: 0,
    terminalSessionCount: 0,
    goal: null,
  };
}

function seed(workspaceId: string, input: SeedInput): void {
  seeds.set(workspaceId, {
    state: buildState(workspaceId, input),
    sidebar: buildSidebar(input),
  });
}

const store = getWorkspaceStoreRaw();
const original = {
  hasRegisteredWorkspace: store.hasRegisteredWorkspace.bind(store),
  subscribeKey: store.subscribeKey.bind(store),
  getWorkspaceState: store.getWorkspaceState.bind(store),
  getWorkspaceSidebarState: store.getWorkspaceSidebarState.bind(store),
};

function renderBar(workspaceId: string): RenderResult {
  return render(<ImmersiveReviewAgentStatusBar workspaceId={workspaceId} />);
}

describe("ImmersiveReviewAgentStatusBar", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalLocalStorage: typeof globalThis.localStorage;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalLocalStorage = globalThis.localStorage;

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.localStorage = globalThis.window.localStorage;
    globalThis.localStorage.clear();
    seeds.clear();
    subscribers.clear();

    store.hasRegisteredWorkspace = (id: string) => seeds.has(id);
    store.subscribeKey = (id: string, cb: () => void) => {
      const set = getSubscribers(id);
      set.add(cb);
      return () => {
        set.delete(cb);
      };
    };
    store.getWorkspaceState = (id: string) => {
      const cache = seeds.get(id);
      if (!cache) throw new Error(`Missing seed for ${id}`);
      return cache.state;
    };
    store.getWorkspaceSidebarState = (id: string) => {
      const cache = seeds.get(id);
      if (!cache) throw new Error(`Missing seed for ${id}`);
      return cache.sidebar;
    };
  });

  afterEach(() => {
    cleanup();
    store.hasRegisteredWorkspace = original.hasRegisteredWorkspace;
    store.subscribeKey = original.subscribeKey;
    store.getWorkspaceState = original.getWorkspaceState;
    store.getWorkspaceSidebarState = original.getWorkspaceSidebarState;
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
    seeds.clear();
    subscribers.clear();
  });

  const todos: TodoItem[] = [
    { content: "Wire up status bar", status: "in_progress" },
    { content: "Add tests", status: "pending" },
  ];

  test("renders the TODO plan (expanded) when todos exist", () => {
    seed("ws-todos", { todos });
    const result = renderBar("ws-todos");
    // Vertical TodoList content is visible by default.
    expect(result.getByText("Wire up status bar")).toBeTruthy();
    expect(result.getByText("Add tests")).toBeTruthy();
    // Summary reflects the counts.
    expect(result.getByText(/1 in progress/)).toBeTruthy();
  });

  test("renders nothing when there is no plan and no active stream", () => {
    seed("ws-idle", { todos: [] });
    const result = renderBar("ws-idle");
    expect(result.container.firstChild).toBeNull();
  });

  test("shows a streaming chip even when there is no plan yet", () => {
    seed("ws-streaming", { todos: [], canInterrupt: true });
    const result = renderBar("ws-streaming");
    expect(result.getByText("Streaming…")).toBeTruthy();
    // No plan means no TODO summary / expand toggle.
    expect(result.queryByText("TODO")).toBeNull();
  });

  test("shows a starting chip during pre-stream startup", () => {
    seed("ws-starting", { todos: [], isStarting: true });
    const result = renderBar("ws-starting");
    expect(result.getByText("Starting…")).toBeTruthy();
  });

  test("surfaces a prominent prompt when the agent awaits a question", () => {
    seed("ws-question", { todos, awaitingUserQuestion: true });
    const result = renderBar("ws-question");
    expect(result.getByText("Mux has a question")).toBeTruthy();
    // The question chip wins over the streaming label.
    expect(result.queryByText("Streaming…")).toBeNull();
  });

  test("collapsing hides the plan and persists the choice", () => {
    const workspaceId = "ws-collapse";
    seed(workspaceId, { todos });
    const result = renderBar(workspaceId);

    fireEvent.click(result.getByRole("button", { name: /todo/i }));
    expect(result.queryByText("Wire up status bar")).toBeNull();
    expect(readPersistedState(getImmersiveReviewAgentBarExpandedKey(workspaceId), true)).toBe(
      false
    );
  });
});

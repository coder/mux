import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import {
  useWorkspaceStoreRaw as getWorkspaceStoreRaw,
  type WorkspaceState,
} from "@/browser/stores/WorkspaceStore";
import type { TodoItem } from "@/common/types/tools";
import { PinnedTodoList } from "./PinnedTodoList";

interface MockWorkspaceState {
  todos: TodoItem[];
  canInterrupt: boolean;
}

const workspaceStates = new Map<string, MockWorkspaceState>();
const workspaceSubscribers = new Map<string, Set<() => void>>();

function getWorkspaceSubscribers(workspaceId: string): Set<() => void> {
  let subscribers = workspaceSubscribers.get(workspaceId);
  if (!subscribers) {
    subscribers = new Set();
    workspaceSubscribers.set(workspaceId, subscribers);
  }
  return subscribers;
}

function buildWorkspaceState(workspaceId: string, state: MockWorkspaceState): WorkspaceState {
  return {
    name: workspaceId,
    messages: [],
    queuedMessage: null,
    canInterrupt: state.canInterrupt,
    isCompacting: false,
    isStreamStarting: false,
    awaitingUserQuestion: false,
    loading: false,
    isHydratingTranscript: false,
    hasOlderHistory: false,
    loadingOlderHistory: false,
    muxMessages: [],
    currentModel: null,
    currentThinkingLevel: null,
    recencyTimestamp: null,
    todos: state.todos,
    loadedSkills: [],
    skillLoadErrors: [],
    agentStatus: undefined,
    lastAbortReason: null,
    pendingStreamStartTime: null,
    pendingStreamModel: null,
    runtimeStatus: null,
    autoRetryStatus: null,
    streamingTokenCount: undefined,
    streamingTPS: undefined,
  };
}

function seedWorkspaceState(workspaceId: string, state: MockWorkspaceState): void {
  workspaceStates.set(workspaceId, state);
}

function updateWorkspaceState(workspaceId: string, nextState: Partial<MockWorkspaceState>): void {
  const currentState = workspaceStates.get(workspaceId);
  if (!currentState) {
    throw new Error(`Missing mock workspace state for ${workspaceId}`);
  }

  workspaceStates.set(workspaceId, { ...currentState, ...nextState });
  for (const subscriber of getWorkspaceSubscribers(workspaceId)) {
    subscriber();
  }
}

function subscribeKey(workspaceId: string, callback: () => void): () => void {
  const subscribers = getWorkspaceSubscribers(workspaceId);
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

function getMockWorkspaceState(workspaceId: string): WorkspaceState {
  const state = workspaceStates.get(workspaceId);
  if (!state) {
    throw new Error(`Missing mock workspace state for ${workspaceId}`);
  }

  return buildWorkspaceState(workspaceId, state);
}

const workspaceStore = getWorkspaceStoreRaw();
const originalSubscribeKey = workspaceStore.subscribeKey.bind(workspaceStore);
const originalGetWorkspaceState = workspaceStore.getWorkspaceState.bind(workspaceStore);

const defaultTodos: TodoItem[] = [
  { content: "Add tests", status: "in_progress" },
  { content: "Run typecheck", status: "pending" },
];

function renderPinnedTodoList(workspaceId: string): RenderResult {
  return render(<PinnedTodoList workspaceId={workspaceId} />);
}

function getHeader(renderResult: RenderResult): HTMLElement {
  const header = renderResult.container.querySelector(".cursor-pointer");
  expect(header).toBeTruthy();
  return header as HTMLElement;
}

describe("PinnedTodoList", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.localStorage = globalThis.window.localStorage;
    globalThis.localStorage.clear();
    workspaceStates.clear();
    workspaceSubscribers.clear();
    workspaceStore.subscribeKey = subscribeKey;
    workspaceStore.getWorkspaceState = getMockWorkspaceState;
  });

  afterEach(() => {
    cleanup();
    workspaceStore.subscribeKey = originalSubscribeKey;
    workspaceStore.getWorkspaceState = originalGetWorkspaceState;
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
    globalThis.localStorage = undefined as unknown as Storage;
    workspaceStates.clear();
    workspaceSubscribers.clear();
  });

  test("renders expanded by default when todos exist", () => {
    seedWorkspaceState("ws-expanded", { todos: defaultTodos, canInterrupt: true });

    const renderResult = renderPinnedTodoList("ws-expanded");

    expect(renderResult.getByText("Add tests")).toBeTruthy();
  });

  test("manual header click collapses and re-expands", () => {
    seedWorkspaceState("ws-toggle", { todos: defaultTodos, canInterrupt: true });

    const renderResult = renderPinnedTodoList("ws-toggle");

    fireEvent.click(getHeader(renderResult));
    expect(renderResult.queryByText("Add tests")).toBeNull();

    fireEvent.click(getHeader(renderResult));
    expect(renderResult.getByText("Add tests")).toBeTruthy();
  });

  test("auto-collapses when canInterrupt transitions from true to false", async () => {
    seedWorkspaceState("ws-streaming", { todos: defaultTodos, canInterrupt: true });

    const renderResult = renderPinnedTodoList("ws-streaming");
    expect(renderResult.getByText("Add tests")).toBeTruthy();

    act(() => {
      updateWorkspaceState("ws-streaming", { canInterrupt: false });
    });

    await waitFor(() => {
      expect(renderResult.queryByText("Add tests")).toBeNull();
    });

    fireEvent.click(getHeader(renderResult));
    expect(renderResult.getByText("Add tests")).toBeTruthy();
  });

  test("does not persist a collapsed state when streaming ends without todos", () => {
    seedWorkspaceState("ws-empty", { todos: [], canInterrupt: true });

    const renderResult = renderPinnedTodoList("ws-empty");
    expect(renderResult.container.firstChild).toBeNull();

    act(() => {
      updateWorkspaceState("ws-empty", { canInterrupt: false });
    });

    expect(readPersistedState("pinnedTodoExpanded:ws-empty", true)).toBe(true);
  });

  test("does not auto-collapse on initial mount when the workspace is already idle", () => {
    seedWorkspaceState("ws-idle", { todos: defaultTodos, canInterrupt: false });

    const renderResult = renderPinnedTodoList("ws-idle");

    expect(renderResult.getByText("Add tests")).toBeTruthy();
  });

  test("persists expansion state per workspace instead of globally", async () => {
    seedWorkspaceState("ws-a", { todos: defaultTodos, canInterrupt: false });
    seedWorkspaceState("ws-b", { todos: defaultTodos, canInterrupt: false });

    const firstRender = renderPinnedTodoList("ws-a");
    fireEvent.click(getHeader(firstRender));

    await waitFor(() => {
      expect(firstRender.queryByText("Add tests")).toBeNull();
    });

    expect(readPersistedState("pinnedTodoExpanded:ws-a", true)).toBe(false);
    expect(readPersistedState("pinnedTodoExpanded:ws-b", true)).toBe(true);

    firstRender.unmount();
    const secondRender = renderPinnedTodoList("ws-b");

    expect(secondRender.getByText("Add tests")).toBeTruthy();
  });
});

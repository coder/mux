import { cleanup, fireEvent, render, type RenderResult } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import {
  useWorkspaceStoreRaw as getWorkspaceStoreRaw,
  type WorkspaceState,
} from "@/browser/stores/WorkspaceStore";
import { getPinnedTodoExpandedKey } from "@/common/constants/storage";
import type { TodoItem } from "@/common/types/tools";
import { PinnedTodoList } from "./PinnedTodoList";

interface MockWorkspaceState {
  todos: TodoItem[];
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
    canInterrupt: false,
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
    seedWorkspaceState("ws-expanded", { todos: defaultTodos });

    const renderResult = renderPinnedTodoList("ws-expanded");

    expect(renderResult.getByText("Add tests")).toBeTruthy();
  });

  test("renders nothing when there are no todos", () => {
    seedWorkspaceState("ws-empty", { todos: [] });

    const renderResult = renderPinnedTodoList("ws-empty");

    expect(renderResult.container.firstChild).toBeNull();
  });

  test("reads a persisted collapsed state on mount", () => {
    const workspaceId = "ws-collapsed";
    seedWorkspaceState(workspaceId, { todos: defaultTodos });
    globalThis.localStorage.setItem(getPinnedTodoExpandedKey(workspaceId), JSON.stringify(false));

    const renderResult = renderPinnedTodoList(workspaceId);

    expect(renderResult.queryByText("Add tests")).toBeNull();
  });

  test("manual header click collapses and re-expands while persisting state", () => {
    const workspaceId = "ws-toggle";
    seedWorkspaceState(workspaceId, { todos: defaultTodos });

    const renderResult = renderPinnedTodoList(workspaceId);

    fireEvent.click(getHeader(renderResult));
    expect(renderResult.queryByText("Add tests")).toBeNull();
    expect(readPersistedState(getPinnedTodoExpandedKey(workspaceId), true)).toBe(false);

    fireEvent.click(getHeader(renderResult));
    expect(renderResult.getByText("Add tests")).toBeTruthy();
    expect(readPersistedState(getPinnedTodoExpandedKey(workspaceId), false)).toBe(true);
  });

  test("persists expansion state per workspace instead of globally", () => {
    seedWorkspaceState("ws-a", { todos: defaultTodos });
    seedWorkspaceState("ws-b", { todos: defaultTodos });

    const firstRender = renderPinnedTodoList("ws-a");
    fireEvent.click(getHeader(firstRender));

    expect(firstRender.queryByText("Add tests")).toBeNull();
    expect(readPersistedState(getPinnedTodoExpandedKey("ws-a"), true)).toBe(false);
    expect(readPersistedState(getPinnedTodoExpandedKey("ws-b"), true)).toBe(true);

    firstRender.unmount();
    const secondRender = renderPinnedTodoList("ws-b");

    expect(secondRender.getByText("Add tests")).toBeTruthy();
  });
});

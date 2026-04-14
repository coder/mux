import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

interface MockWorkspaceState {
  canInterrupt: boolean;
  isCompacting: boolean;
  isStreamStarting: boolean;
  awaitingUserQuestion: boolean;
  currentModel: string | null;
  pendingStreamStartTime: number | null;
  pendingStreamModel: string | null;
  runtimeStatus: { phase: string; detail?: string } | null;
  streamingTokenCount: number | undefined;
  streamingTPS: number | undefined;
}

function createWorkspaceState(overrides: Partial<MockWorkspaceState> = {}): MockWorkspaceState {
  const state: MockWorkspaceState = {
    canInterrupt: true,
    isCompacting: false,
    isStreamStarting: false,
    awaitingUserQuestion: false,
    currentModel: "openai:gpt-4o-mini",
    pendingStreamStartTime: null,
    pendingStreamModel: null,
    runtimeStatus: null,
    streamingTokenCount: undefined,
    streamingTPS: undefined,
    ...overrides,
  };

  if (overrides.isStreamStarting === undefined) {
    state.isStreamStarting = !state.canInterrupt && state.pendingStreamStartTime !== null;
  }

  return state;
}

const STATUS_DISPLAY_DELAY_MS = 1000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let currentWorkspaceState = createWorkspaceState();
let hasInterruptingStream = false;
const setInterrupting = mock((_workspaceId: string) => undefined);
const interruptStream = mock((_input: unknown) =>
  Promise.resolve({ success: true as const, data: undefined })
);
const setAutoRetryEnabled = mock((_input: unknown) =>
  Promise.resolve({
    success: true as const,
    data: { previousEnabled: true, enabled: true },
  })
);
const openSettings = mock((_section?: string) => undefined);

void mock.module("@/browser/stores/WorkspaceStore", () => ({
  useWorkspaceState: () => currentWorkspaceState,
  useWorkspaceAggregator: () => ({
    hasInterruptingStream: () => hasInterruptingStream,
  }),
  useWorkspaceStoreRaw: () => ({
    setInterrupting,
  }),
}));

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: {
      workspace: {
        interruptStream,
        setAutoRetryEnabled,
      },
    },
    status: "connected" as const,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

void mock.module("@/browser/contexts/SettingsContext", () => ({
  useSettings: () => ({
    isOpen: false,
    activeSection: "general",
    open: openSettings,
    close: () => undefined,
    setActiveSection: () => undefined,
    providersExpandedProvider: null,
    setProvidersExpandedProvider: () => undefined,
  }),
}));

void mock.module("@/browser/hooks/usePersistedState", () => ({
  readPersistedState: function <T>(_key: string, defaultValue: T): T {
    return defaultValue;
  },
  readPersistedString: () => null,
}));

void mock.module("@/browser/hooks/useModelsFromSettings", () => ({
  getDefaultModel: () => "openai:gpt-4o-mini",
}));

import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { StreamingBarrier } from "./StreamingBarrier";

describe("StreamingBarrier", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    currentWorkspaceState = createWorkspaceState();
    hasInterruptingStream = false;
    setInterrupting.mockClear();
    interruptStream.mockClear();
    setAutoRetryEnabled.mockClear();
    openSettings.mockClear();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("clicking stop during normal streaming interrupts with default options", async () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: true,
      isCompacting: false,
      awaitingUserQuestion: false,
    });

    const view = render(<StreamingBarrier workspaceId="ws-1" />);
    await sleep(STATUS_DISPLAY_DELAY_MS + 50);

    fireEvent.click(view.getByRole("button", { name: "Stop streaming" }));

    expect(setAutoRetryEnabled).toHaveBeenCalledWith({ workspaceId: "ws-1", enabled: false });
    expect(setInterrupting).toHaveBeenCalledWith("ws-1");
    expect(interruptStream).toHaveBeenCalledWith({ workspaceId: "ws-1" });
  });

  test("clicking stop during stream-start interrupts without setting interrupting state", async () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: false,
      pendingStreamStartTime: Date.now(),
      pendingStreamModel: "openai:gpt-4o-mini",
    });

    const view = render(<StreamingBarrier workspaceId="ws-1" />);
    await sleep(STATUS_DISPLAY_DELAY_MS + 50);

    const stopButton = view.getByRole("button", { name: "Stop streaming" });
    expect(stopButton.textContent).toContain("Esc");
    expect(stopButton.getAttribute("title")).toBeNull();

    fireEvent.click(stopButton);

    expect(setAutoRetryEnabled).toHaveBeenCalledWith({ workspaceId: "ws-1", enabled: false });
    expect(setInterrupting).not.toHaveBeenCalled();
    expect(interruptStream).toHaveBeenCalledWith({ workspaceId: "ws-1" });
  });

  test("suppresses barrier until status has been stable for the display delay", async () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: false,
      pendingStreamStartTime: null,
      pendingStreamModel: null,
    });

    const view = render(<StreamingBarrier workspaceId="ws-1" />);
    expect(view.queryByRole("button", { name: "Stop streaming" })).toBeNull();

    // Activate streaming phase — barrier should NOT appear immediately.
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: false,
      pendingStreamStartTime: Date.now(),
      pendingStreamModel: "anthropic:claude-opus-4-6",
    });
    view.rerender(<StreamingBarrier workspaceId="ws-1" />);
    expect(view.queryByRole("button", { name: "Stop streaming" })).toBeNull();

    // After the stability delay the barrier appears.
    await sleep(STATUS_DISPLAY_DELAY_MS + 50);
    expect(view.getByRole("button", { name: "Stop streaming" })).toBeTruthy();
    expect(view.getByText("claude-opus-4-6 starting...")).toBeTruthy();
  });

  test("keeps the barrier mounted when startup detail is an empty string", async () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: false,
      pendingStreamStartTime: Date.now(),
      pendingStreamModel: "anthropic:claude-opus-4-6",
      runtimeStatus: { phase: "starting", detail: "" },
    });

    const view = render(<StreamingBarrier workspaceId="ws-1" />);
    await sleep(STATUS_DISPLAY_DELAY_MS + 50);

    expect(view.getByRole("button", { name: "Stop streaming" })).toBeTruthy();
  });

  test("shows backend startup breadcrumb text once stable", async () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: false,
      pendingStreamStartTime: Date.now(),
      pendingStreamModel: "openai:gpt-4o-mini",
      runtimeStatus: { phase: "starting", detail: "Loading tools..." },
    });

    const view = render(<StreamingBarrier workspaceId="ws-1" />);

    // Not shown immediately — must wait for stability.
    expect(view.queryByText("Loading tools...")).toBeNull();
    await sleep(STATUS_DISPLAY_DELAY_MS + 50);
    expect(view.getByText("Loading tools...")).toBeTruthy();
  });

  test("suppresses transient breadcrumbs that change before the display delay", async () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: false,
      pendingStreamStartTime: Date.now(),
      pendingStreamModel: "anthropic:claude-opus-4-6",
      runtimeStatus: { phase: "starting", detail: "Starting workspace..." },
    });

    const view = render(<StreamingBarrier workspaceId="ws-1" />);

    // Rapid breadcrumb change before the delay expires — restarts the timer
    // so "Starting workspace..." is never shown.
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: false,
      pendingStreamStartTime: Date.now(),
      pendingStreamModel: "anthropic:claude-opus-4-6",
      runtimeStatus: { phase: "starting", detail: "Loading tools..." },
    });
    view.rerender(<StreamingBarrier workspaceId="ws-1" />);

    // Neither text is visible yet.
    expect(view.queryByText("Starting workspace...")).toBeNull();
    expect(view.queryByText("Loading tools...")).toBeNull();

    // After the delay, only the settled text appears.
    await sleep(STATUS_DISPLAY_DELAY_MS + 50);
    expect(view.getByText("Loading tools...")).toBeTruthy();
    expect(view.queryByText("Starting workspace...")).toBeNull();
  });

  test("suppresses transient phases during fast startup-to-streaming transition", async () => {
    // Start in "starting" phase — the timer begins but hasn't fired yet.
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: false,
      pendingStreamStartTime: Date.now(),
      pendingStreamModel: "anthropic:claude-opus-4-6",
      runtimeStatus: { phase: "starting", detail: "Loading tools..." },
    });

    const view = render(<StreamingBarrier workspaceId="ws-1" />);

    // Quickly transition to streaming — restarts the timer.
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: true,
      currentModel: "anthropic:claude-opus-4-6",
    });
    view.rerender(<StreamingBarrier workspaceId="ws-1" />);

    // Neither the old nor new text is visible yet.
    expect(view.queryByText("Loading tools...")).toBeNull();
    expect(view.queryByText("claude-opus-4-6 streaming...")).toBeNull();

    await sleep(STATUS_DISPLAY_DELAY_MS + 50);

    // Only the settled streaming text appears — startup was never shown.
    expect(view.getByText("claude-opus-4-6 streaming...")).toBeTruthy();
    expect(view.queryByText("Loading tools...")).toBeNull();
  });

  test("token/tps rerenders do not restart the stability timer", async () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: true,
      currentModel: "anthropic:claude-opus-4-6",
    });

    const view = render(<StreamingBarrier workspaceId="ws-1" />);
    await sleep(STATUS_DISPLAY_DELAY_MS + 50);

    expect(view.getByText("claude-opus-4-6 streaming...")).toBeTruthy();

    // Token count updates don't change statusText, so the displayed text stays.
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: true,
      currentModel: "anthropic:claude-opus-4-6",
      streamingTokenCount: 42,
      streamingTPS: 18,
    });
    view.rerender(<StreamingBarrier workspaceId="ws-1" />);

    expect(view.getByText("claude-opus-4-6 streaming...")).toBeTruthy();
  });

  test("shows vim interrupt shortcut when vim mode is enabled", async () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: false,
      pendingStreamStartTime: Date.now(),
      pendingStreamModel: "openai:gpt-4o-mini",
    });

    const view = render(<StreamingBarrier workspaceId="ws-1" vimEnabled />);
    await sleep(STATUS_DISPLAY_DELAY_MS + 50);

    const stopButton = view.getByRole("button", { name: "Stop streaming" });
    const expectedVimShortcut = formatKeybind(KEYBINDS.INTERRUPT_STREAM_VIM).replace(
      "Escape",
      "Esc"
    );

    expect(stopButton.textContent).toContain(expectedVimShortcut);
    expect(stopButton.getAttribute("title")).toBeNull();
  });

  test("clicking stop during compaction uses onCancelCompaction when provided", async () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: true,
      isCompacting: true,
    });

    const onCancelCompaction = mock(() => undefined);
    const view = render(
      <StreamingBarrier workspaceId="ws-1" onCancelCompaction={onCancelCompaction} />
    );
    await sleep(STATUS_DISPLAY_DELAY_MS + 50);

    fireEvent.click(view.getByRole("button", { name: "Stop streaming" }));

    expect(setAutoRetryEnabled).toHaveBeenCalledWith({ workspaceId: "ws-1", enabled: false });
    expect(onCancelCompaction).toHaveBeenCalledTimes(1);
    expect(setInterrupting).not.toHaveBeenCalled();
    expect(interruptStream).not.toHaveBeenCalled();
  });

  test("clicking stop during compaction falls back to abandonPartial interrupt", async () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: true,
      isCompacting: true,
    });

    const view = render(<StreamingBarrier workspaceId="ws-1" />);
    await sleep(STATUS_DISPLAY_DELAY_MS + 50);

    fireEvent.click(view.getByRole("button", { name: "Stop streaming" }));

    expect(setAutoRetryEnabled).toHaveBeenCalledWith({ workspaceId: "ws-1", enabled: false });
    expect(setInterrupting).not.toHaveBeenCalled();
    expect(interruptStream).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      options: { abandonPartial: true },
    });
  });

  test("awaiting-input phase keeps cancel hint non-interactive", async () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: true,
      awaitingUserQuestion: true,
    });

    const view = render(<StreamingBarrier workspaceId="ws-1" />);
    await sleep(STATUS_DISPLAY_DELAY_MS + 50);

    expect(view.queryByRole("button", { name: "Stop streaming" })).toBeNull();
    expect(view.getByText("type a message to respond")).toBeTruthy();
  });
});

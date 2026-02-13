import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

interface MockWorkspaceState {
  canInterrupt: boolean;
  isCompacting: boolean;
  awaitingUserQuestion: boolean;
  currentModel: string | null;
  pendingStreamStartTime: number | null;
  pendingStreamModel: string | null;
  runtimeStatus: { phase: string; detail?: string } | null;
  streamingTokenCount: number | undefined;
  streamingTPS: number | undefined;
}

function createWorkspaceState(overrides: Partial<MockWorkspaceState> = {}): MockWorkspaceState {
  return {
    canInterrupt: true,
    isCompacting: false,
    awaitingUserQuestion: false,
    currentModel: "openai:gpt-4o-mini",
    pendingStreamStartTime: null,
    pendingStreamModel: null,
    runtimeStatus: null,
    streamingTokenCount: undefined,
    streamingTPS: undefined,
    ...overrides,
  };
}

let currentWorkspaceState = createWorkspaceState();
let hasInterruptingStream = false;
const setInterrupting = mock((_workspaceId: string) => undefined);
const interruptStream = mock((_input: unknown) =>
  Promise.resolve({ success: true as const, data: undefined })
);
const disableAutoRetryPreferenceMock = mock((_workspaceId: string) => undefined);
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

void mock.module("@/browser/utils/messages/autoRetryPreference", () => ({
  disableAutoRetryPreference: disableAutoRetryPreferenceMock,
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

import { StreamingBarrier } from "./StreamingBarrier";

describe("StreamingBarrier", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    currentWorkspaceState = createWorkspaceState();
    hasInterruptingStream = false;
    setInterrupting.mockClear();
    interruptStream.mockClear();
    disableAutoRetryPreferenceMock.mockClear();
    openSettings.mockClear();
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("clicking cancel during normal streaming interrupts with default options", () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: true,
      isCompacting: false,
      awaitingUserQuestion: false,
    });

    const view = render(<StreamingBarrier workspaceId="ws-1" />);

    fireEvent.click(view.getByRole("button", { name: "Interrupt streaming" }));

    expect(disableAutoRetryPreferenceMock).toHaveBeenCalledWith("ws-1");
    expect(setInterrupting).toHaveBeenCalledWith("ws-1");
    expect(interruptStream).toHaveBeenCalledWith({ workspaceId: "ws-1" });
  });

  test("clicking cancel during compaction uses onCancelCompaction when provided", () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: true,
      isCompacting: true,
    });

    const onCancelCompaction = mock(() => undefined);
    const view = render(
      <StreamingBarrier workspaceId="ws-1" onCancelCompaction={onCancelCompaction} />
    );

    fireEvent.click(view.getByRole("button", { name: "Interrupt streaming" }));

    expect(disableAutoRetryPreferenceMock).toHaveBeenCalledWith("ws-1");
    expect(onCancelCompaction).toHaveBeenCalledTimes(1);
    expect(setInterrupting).not.toHaveBeenCalled();
    expect(interruptStream).not.toHaveBeenCalled();
  });

  test("clicking cancel during compaction falls back to abandonPartial interrupt", () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: true,
      isCompacting: true,
    });

    const view = render(<StreamingBarrier workspaceId="ws-1" />);

    fireEvent.click(view.getByRole("button", { name: "Interrupt streaming" }));

    expect(disableAutoRetryPreferenceMock).toHaveBeenCalledWith("ws-1");
    expect(setInterrupting).not.toHaveBeenCalled();
    expect(interruptStream).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      options: { abandonPartial: true },
    });
  });

  test("awaiting-input phase keeps cancel hint non-interactive", () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: true,
      awaitingUserQuestion: true,
    });

    const view = render(<StreamingBarrier workspaceId="ws-1" />);

    expect(view.queryByRole("button", { name: "Interrupt streaming" })).toBeNull();
    expect(view.getByText("type a message to respond")).toBeTruthy();
  });
});

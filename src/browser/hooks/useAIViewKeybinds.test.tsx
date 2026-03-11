import type { ReactNode, RefObject } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalWindow } from "happy-dom";
import type { ChatInputAPI } from "@/browser/features/ChatInput";
import type * as APIModule from "@/browser/contexts/API";
import type { APIClient } from "@/browser/contexts/API";
import { requireTestModule, type RecursivePartial } from "@/browser/testUtils";
import type * as UseAIViewKeybindsModule from "./useAIViewKeybinds";

let currentClientMock: RecursivePartial<APIClient> = {};
let originalWindow: typeof globalThis.window;
let originalDocument: typeof globalThis.document;
let originalHTMLElement: unknown;
let APIProvider!: typeof APIModule.APIProvider;
let useAIViewKeybinds!: typeof UseAIViewKeybindsModule.useAIViewKeybinds;
let isolatedModulePaths: string[] = [];

const hooksDir = dirname(fileURLToPath(import.meta.url));
const contextsDir = join(hooksDir, "../contexts");

async function importIsolatedAIViewKeybindModules() {
  const suffix = randomUUID();
  const isolatedApiPath = join(contextsDir, `API.real.${suffix}.tsx`);
  const isolatedHookPath = join(hooksDir, `useAIViewKeybinds.real.${suffix}.ts`);

  await copyFile(join(contextsDir, "API.tsx"), isolatedApiPath);

  const hookSource = await readFile(join(hooksDir, "useAIViewKeybinds.ts"), "utf8");
  const isolatedHookSource = hookSource.replace(
    'from "@/browser/contexts/API";',
    `from "../contexts/API.real.${suffix}.tsx";`
  );

  if (isolatedHookSource === hookSource) {
    throw new Error("Failed to rewrite useAIViewKeybinds API import for the isolated test copy");
  }

  await writeFile(isolatedHookPath, isolatedHookSource);

  ({ APIProvider } = requireTestModule<{ APIProvider: typeof APIModule.APIProvider }>(
    isolatedApiPath
  ));
  ({ useAIViewKeybinds } = requireTestModule<{
    useAIViewKeybinds: typeof UseAIViewKeybindsModule.useAIViewKeybinds;
  }>(isolatedHookPath));

  return [isolatedApiPath, isolatedHookPath];
}

function renderUseAIViewKeybinds(props: Parameters<typeof useAIViewKeybinds>[0]) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <APIProvider client={currentClientMock as APIClient}>{children}</APIProvider>
  );

  return renderHook(() => useAIViewKeybinds(props), { wrapper });
}

describe("useAIViewKeybinds", () => {
  beforeEach(async () => {
    isolatedModulePaths = await importIsolatedAIViewKeybindModules();
    mock.restore();

    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalHTMLElement = (globalThis as unknown as { HTMLElement: unknown }).HTMLElement;

    const domWindow = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.window = domWindow;
    globalThis.document = domWindow.document;
    // happy-dom doesn't define HTMLElement on globalThis by default.
    // Our keybind helpers use `target instanceof HTMLElement`, so polyfill it for tests.
    (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = domWindow.HTMLElement;
  });

  afterEach(async () => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = originalHTMLElement;
    currentClientMock = {};

    for (const modulePath of isolatedModulePaths) {
      await rm(modulePath, { force: true });
    }
    isolatedModulePaths = [];
  });

  test("Escape interrupts an active stream in normal mode", () => {
    const interruptStream = mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );
    currentClientMock = {
      workspace: {
        interruptStream,
      },
    };

    const chatInputAPI: RefObject<ChatInputAPI | null> = { current: null };

    renderUseAIViewKeybinds({
      workspaceId: "ws",
      canInterrupt: true,
      showRetryBarrier: false,
      chatInputAPI,
      jumpToBottom: () => undefined,
      loadOlderHistory: null,
      handleOpenTerminal: () => undefined,
      handleOpenInEditor: () => undefined,
      aggregator: undefined,
      setEditingMessage: () => undefined,
      vimEnabled: false,
    });

    document.body.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      })
    );

    expect(interruptStream.mock.calls.length).toBe(1);
  });

  test("Escape does not interrupt when the event target is an <input>", () => {
    const interruptStream = mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );
    currentClientMock = {
      workspace: {
        interruptStream,
      },
    };

    const chatInputAPI: RefObject<ChatInputAPI | null> = { current: null };

    renderUseAIViewKeybinds({
      workspaceId: "ws",
      canInterrupt: true,
      showRetryBarrier: false,
      chatInputAPI,
      jumpToBottom: () => undefined,
      loadOlderHistory: null,
      handleOpenTerminal: () => undefined,
      handleOpenInEditor: () => undefined,
      aggregator: undefined,
      setEditingMessage: () => undefined,
      vimEnabled: false,
    });

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    input.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      })
    );

    expect(interruptStream.mock.calls.length).toBe(0);
  });

  test("Escape interrupts when an editable element opts in", () => {
    const interruptStream = mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );
    currentClientMock = {
      workspace: {
        interruptStream,
      },
    };

    const chatInputAPI: RefObject<ChatInputAPI | null> = { current: null };

    renderUseAIViewKeybinds({
      workspaceId: "ws",
      canInterrupt: true,
      showRetryBarrier: false,
      chatInputAPI,
      jumpToBottom: () => undefined,
      loadOlderHistory: null,
      handleOpenTerminal: () => undefined,
      handleOpenInEditor: () => undefined,
      aggregator: undefined,
      setEditingMessage: () => undefined,
      vimEnabled: false,
    });

    const input = document.createElement("input");
    input.setAttribute("data-escape-interrupts-stream", "true");
    document.body.appendChild(input);
    input.focus();

    input.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      })
    );

    expect(interruptStream.mock.calls.length).toBe(1);
  });

  test("Ctrl+C interrupts in vim mode even when an <input> is focused", () => {
    const interruptStream = mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );
    currentClientMock = {
      workspace: {
        interruptStream,
      },
    };

    const chatInputAPI: RefObject<ChatInputAPI | null> = { current: null };

    renderUseAIViewKeybinds({
      workspaceId: "ws",
      canInterrupt: true,
      showRetryBarrier: false,
      chatInputAPI,
      jumpToBottom: () => undefined,
      loadOlderHistory: null,
      handleOpenTerminal: () => undefined,
      handleOpenInEditor: () => undefined,
      aggregator: undefined,
      setEditingMessage: () => undefined,
      vimEnabled: true,
    });

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    input.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "c",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
    );

    expect(interruptStream.mock.calls.length).toBe(1);
  });

  test("Shift+H loads older history when callback is provided", () => {
    const loadOlderHistory = mock(() => undefined);
    const chatInputAPI: RefObject<ChatInputAPI | null> = { current: null };

    renderUseAIViewKeybinds({
      workspaceId: "ws",
      canInterrupt: false,
      showRetryBarrier: false,
      chatInputAPI,
      jumpToBottom: () => undefined,
      loadOlderHistory,
      handleOpenTerminal: () => undefined,
      handleOpenInEditor: () => undefined,
      aggregator: undefined,
      setEditingMessage: () => undefined,
      vimEnabled: false,
    });

    document.body.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "H",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      })
    );

    expect(loadOlderHistory.mock.calls.length).toBe(1);
  });

  test("Escape does not interrupt when immersive review captures Escape", () => {
    const interruptStream = mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );
    currentClientMock = {
      workspace: {
        interruptStream,
      },
    };

    const chatInputAPI: RefObject<ChatInputAPI | null> = { current: null };

    renderUseAIViewKeybinds({
      workspaceId: "ws",
      canInterrupt: true,
      showRetryBarrier: false,
      chatInputAPI,
      jumpToBottom: () => undefined,
      loadOlderHistory: null,
      handleOpenTerminal: () => undefined,
      handleOpenInEditor: () => undefined,
      aggregator: undefined,
      setEditingMessage: () => undefined,
      vimEnabled: false,
    });

    const stopImmersiveEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    // Immersive review listens in capture phase so Escape never reaches bubble-phase
    // stream interrupt listeners.
    window.addEventListener("keydown", stopImmersiveEscape, { capture: true });

    document.body.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      })
    );

    window.removeEventListener("keydown", stopImmersiveEscape, { capture: true });

    expect(interruptStream.mock.calls.length).toBe(0);
  });

  test("Escape does not interrupt when a modal stops propagation (e.g., Settings)", () => {
    const interruptStream = mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );
    currentClientMock = {
      workspace: {
        interruptStream,
      },
    };

    const chatInputAPI: RefObject<ChatInputAPI | null> = { current: null };

    renderUseAIViewKeybinds({
      workspaceId: "ws",
      canInterrupt: true,
      showRetryBarrier: false,
      chatInputAPI,
      jumpToBottom: () => undefined,
      loadOlderHistory: null,
      handleOpenTerminal: () => undefined,
      handleOpenInEditor: () => undefined,
      aggregator: undefined,
      setEditingMessage: () => undefined,
      vimEnabled: false,
    });

    const stopEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
      }
    };

    document.addEventListener("keydown", stopEscape, { capture: true });

    document.body.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      })
    );

    document.removeEventListener("keydown", stopEscape, { capture: true });

    expect(interruptStream.mock.calls.length).toBe(0);
  });
});

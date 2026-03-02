import type { ReactNode, RefObject } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { useAIViewKeybinds } from "./useAIViewKeybinds";
import type { ChatInputAPI } from "@/browser/features/ChatInput";
import type { APIClient } from "@/browser/contexts/API";
import type { RecursivePartial } from "@/browser/testUtils";

let currentClientMock: RecursivePartial<APIClient> = {};
void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: currentClientMock as APIClient,
    status: "connected" as const,
    error: null,
  }),
  APIProvider: ({ children }: { children: ReactNode }) => children,
}));

describe("useAIViewKeybinds", () => {
  beforeEach(() => {
    const domWindow = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.window = domWindow;
    globalThis.document = domWindow.document;
    // happy-dom doesn't define HTMLElement on globalThis by default.
    // Our keybind helpers use `target instanceof HTMLElement`, so polyfill it for tests.
    (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = domWindow.HTMLElement;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
    (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = undefined;
    currentClientMock = {};
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

    renderHook(() =>
      useAIViewKeybinds({
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
      })
    );

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

    renderHook(() =>
      useAIViewKeybinds({
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
      })
    );

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

    renderHook(() =>
      useAIViewKeybinds({
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
      })
    );

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

    renderHook(() =>
      useAIViewKeybinds({
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
      })
    );

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

    renderHook(() =>
      useAIViewKeybinds({
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
      })
    );

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

    renderHook(() =>
      useAIViewKeybinds({
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
      })
    );

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

    renderHook(() =>
      useAIViewKeybinds({
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
      })
    );

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

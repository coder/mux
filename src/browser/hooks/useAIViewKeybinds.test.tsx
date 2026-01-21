import type { ReactNode, RefObject } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { useAIViewKeybinds } from "./useAIViewKeybinds";
import type { ChatInputAPI } from "@/browser/components/ChatInput";
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
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
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

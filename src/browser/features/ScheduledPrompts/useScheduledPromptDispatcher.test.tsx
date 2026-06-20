import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

import type { APIClient } from "@/browser/contexts/API";
import type { QueueDispatchMode } from "@/browser/features/ChatInput/types";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getScheduledPromptsKey } from "@/common/constants/storage";
import type { SendMessageOptions } from "@/common/orpc/types";
import { createScheduledPrompt, type ScheduledPrompt } from "./scheduledPrompts";
import { useScheduledPromptDispatcher } from "./useScheduledPromptDispatcher";

const WORKSPACE_ID = "workspace-scheduled-dispatcher";
const NOW = 1_700_000_000_000;
const SEND_OPTIONS: SendMessageOptions = {
  agentId: "exec",
  model: "openai:test",
};

interface SendMessageInput {
  message: string;
  options: {
    additionalSystemContext?: string;
    queueDispatchMode?: QueueDispatchMode;
  };
}

interface SendMessageSuccess {
  success: true;
  data: Record<string, never>;
}

function Dispatcher(props: { api: APIClient; additionalSystemContext?: string }) {
  useScheduledPromptDispatcher({
    api: props.api,
    workspaceId: WORKSPACE_ID,
    sendMessageOptions: SEND_OPTIONS,
    additionalSystemContext: props.additionalSystemContext,
    enabled: true,
  });
  return null;
}

function writePrompts(prompts: ScheduledPrompt[]) {
  updatePersistedState(getScheduledPromptsKey(WORKSPACE_ID), prompts);
}

async function waitForDispatcherTick() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

describe("useScheduledPromptDispatcher", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalLocalStorage: typeof globalThis.localStorage;
  let originalCustomEvent: typeof globalThis.CustomEvent;
  let originalStorageEvent: typeof globalThis.StorageEvent;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalLocalStorage = globalThis.localStorage;
    originalCustomEvent = globalThis.CustomEvent;
    originalStorageEvent = globalThis.StorageEvent;

    const dom = new GlobalWindow();
    globalThis.window = dom as unknown as Window & typeof globalThis;
    globalThis.document = dom.document as unknown as Document;
    globalThis.localStorage = dom.localStorage as unknown as Storage;
    globalThis.CustomEvent = dom.CustomEvent as unknown as typeof globalThis.CustomEvent;
    globalThis.StorageEvent = dom.StorageEvent as unknown as typeof globalThis.StorageEvent;
    globalThis.window.setTimeout = globalThis.setTimeout.bind(
      globalThis
    ) as typeof window.setTimeout;
    globalThis.window.clearTimeout = globalThis.clearTimeout.bind(
      globalThis
    ) as typeof window.clearTimeout;
    let lockHeld = false;
    Object.defineProperty(globalThis.window.navigator, "locks", {
      configurable: true,
      value: {
        request: async (
          _name: string,
          _options: { ifAvailable: true; mode: "exclusive" },
          callback: (lock: object | null) => unknown
        ) => {
          if (lockHeld) {
            return callback(null);
          }
          lockHeld = true;
          try {
            return await callback({ name: _name });
          } finally {
            lockHeld = false;
          }
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
    globalThis.CustomEvent = originalCustomEvent;
    globalThis.StorageEvent = originalStorageEvent;
  });

  test("dispatches multiple due prompts sequentially", async () => {
    const first = createScheduledPrompt(
      { content: "first", runAt: NOW - 2, queueDispatchMode: "tool-end" },
      NOW,
      "first"
    );
    const second = createScheduledPrompt(
      { content: "second", runAt: NOW - 1, queueDispatchMode: "turn-end" },
      NOW,
      "second"
    );
    writePrompts([second, first]);

    const resolvers: Array<(value: SendMessageSuccess) => void> = [];
    const sendMessage = mock((_input: SendMessageInput) => {
      return new Promise<SendMessageSuccess>((resolve) => {
        resolvers.push(resolve);
      });
    });
    const api = {
      workspace: {
        sendMessage,
      },
    } as unknown as APIClient;

    render(<Dispatcher api={api} />);

    await waitForDispatcherTick();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const firstCall = sendMessage.mock.calls[0]?.[0];
    if (!firstCall) {
      throw new Error("Expected first scheduled prompt send");
    }
    expect(firstCall.message).toBe("first");
    expect(firstCall.options.queueDispatchMode).toBe("tool-end");

    await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvers[0]?.({ success: true, data: {} });
      await Promise.resolve();
    });

    await waitForDispatcherTick();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const secondCall = sendMessage.mock.calls[1]?.[0];
    if (!secondCall) {
      throw new Error("Expected second scheduled prompt send");
    }
    expect(secondCall.message).toBe("second");
    expect(secondCall.options.queueDispatchMode).toBe("turn-end");

    await act(async () => {
      resolvers[1]?.({ success: true, data: {} });
      await Promise.resolve();
    });
  });

  test("skips queued due prompts that were removed before dispatch", async () => {
    const first = createScheduledPrompt(
      { content: "first", runAt: NOW - 2, queueDispatchMode: "tool-end" },
      NOW,
      "first"
    );
    const second = createScheduledPrompt(
      { content: "second", runAt: NOW - 1, queueDispatchMode: "turn-end" },
      NOW,
      "second"
    );
    writePrompts([first, second]);

    let resolveFirst: ((value: SendMessageSuccess) => void) | undefined;
    const sendMessage = mock((_input: SendMessageInput) => {
      return new Promise<SendMessageSuccess>((resolve) => {
        resolveFirst = resolve;
      });
    });
    const api = {
      workspace: {
        sendMessage,
      },
    } as unknown as APIClient;

    render(<Dispatcher api={api} />);

    await waitForDispatcherTick();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const firstCall = sendMessage.mock.calls[0]?.[0];
    if (!firstCall) {
      throw new Error("Expected first scheduled prompt send");
    }
    expect(firstCall.message).toBe("first");

    act(() => {
      writePrompts([first]);
    });

    await act(async () => {
      resolveFirst?.({ success: true, data: {} });
      await Promise.resolve();
    });

    await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("includes additional system context in scheduled sends", async () => {
    const prompt = createScheduledPrompt(
      { content: "run with instructions", runAt: NOW - 1, queueDispatchMode: "tool-end" },
      NOW,
      "with-context"
    );
    writePrompts([prompt]);

    const sendMessage = mock((_input: SendMessageInput) =>
      Promise.resolve({ success: true as const, data: {} })
    );
    const api = {
      workspace: {
        sendMessage,
      },
    } as unknown as APIClient;

    render(<Dispatcher api={api} additionalSystemContext="Stay concise." />);

    await waitForDispatcherTick();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const firstCall = sendMessage.mock.calls[0]?.[0];
    if (!firstCall) {
      throw new Error("Expected scheduled prompt send");
    }
    expect(firstCall.options.additionalSystemContext).toBe("Stay concise.");
  });

  test("keeps only one renderer dispatching scheduled prompts at a time", async () => {
    const prompt = createScheduledPrompt(
      { content: "send once", runAt: NOW - 1, queueDispatchMode: "tool-end" },
      NOW,
      "shared-lock"
    );
    writePrompts([prompt]);

    let resolveSend: ((value: SendMessageSuccess) => void) | undefined;
    const sendMessage = mock(
      (_input: SendMessageInput) =>
        new Promise<SendMessageSuccess>((resolve) => {
          resolveSend = resolve;
        })
    );
    const firstApi = {
      workspace: {
        sendMessage,
      },
    } as unknown as APIClient;
    const secondApi = {
      workspace: {
        sendMessage,
      },
    } as unknown as APIClient;

    render(
      <>
        <Dispatcher api={firstApi} />
        <Dispatcher api={secondApi} />
      </>
    );

    await waitForDispatcherTick();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSend?.({ success: true, data: {} });
      await Promise.resolve();
    });
  });

  test("stores formatted structured send errors", async () => {
    const prompt = createScheduledPrompt(
      { content: "needs key", runAt: NOW - 1, queueDispatchMode: "tool-end" },
      NOW,
      "structured-error"
    );
    writePrompts([prompt]);

    const sendMessage = mock((_input: SendMessageInput) =>
      Promise.resolve({
        success: false as const,
        error: { type: "api_key_not_found" as const, provider: "openai" },
      })
    );
    const api = {
      workspace: {
        sendMessage,
      },
    } as unknown as APIClient;

    render(<Dispatcher api={api} />);

    await waitForDispatcherTick();
    await waitForDispatcherTick();

    const storedPrompts = readPersistedState<ScheduledPrompt[]>(
      getScheduledPromptsKey(WORKSPACE_ID),
      []
    );
    expect(storedPrompts[0]?.status).toBe("failed");
    expect(storedPrompts[0]?.error).toContain("API key not found for OpenAI.");
    expect(storedPrompts[0]?.error).toContain("Open Settings");
  });
});

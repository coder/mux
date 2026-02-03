import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import React from "react";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { PolicyProvider } from "@/browser/contexts/PolicyContext";
import type { WorkspaceUsageState } from "@/browser/stores/WorkspaceStore";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { DisplayedMessage } from "@/common/types/message";
import { useContextSwitchWarning } from "./useContextSwitchWarning";
import { getEffectiveContextLimit } from "@/browser/utils/compaction/contextLimit";

function createStubApiClient(): APIClient {
  // Avoid mock.module (global) by injecting a minimal client through providers.
  // Keep this stub local unless other tests need the same wiring.
  async function* empty() {
    // no-op
  }

  return {
    providers: {
      getConfig: () => Promise.resolve(null),
      onConfigChanged: () => Promise.resolve(empty()),
    },
    policy: {
      get: () => Promise.resolve({ status: { state: "disabled" }, policy: null }),
      onChanged: () => Promise.resolve(empty()),
    },
  } as unknown as APIClient;
}

const stubClient = createStubApiClient();

const wrapper: React.FC<{ children: React.ReactNode }> = (props) =>
  React.createElement(
    APIProvider,
    { client: stubClient } as React.ComponentProps<typeof APIProvider>,
    React.createElement(PolicyProvider, null, props.children)
  );

const buildUsage = (tokens: number, model?: string): WorkspaceUsageState => ({
  totalTokens: tokens,
  lastContextUsage: {
    input: { tokens },
    cached: { tokens: 0 },
    cacheCreate: { tokens: 0 },
    output: { tokens: 0 },
    reasoning: { tokens: 0 },
    model,
  },
});

const buildAssistantMessage = (model: string): DisplayedMessage => ({
  type: "assistant",
  id: "assistant-1",
  historyId: "history-1",
  content: "ok",
  historySequence: 1,
  isStreaming: false,
  isPartial: false,
  isCompacted: false,
  isIdleCompacted: false,
  model,
});

const buildSendOptions = (model: string): SendMessageOptions => ({
  model,
  agentId: "exec",
});

describe("useContextSwitchWarning", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.localStorage = globalThis.window.localStorage;
    globalThis.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
    globalThis.localStorage = undefined as unknown as Storage;
  });

  test("does not warn on initial load without a user switch", async () => {
    const model = "openai:gpt-5.2-codex";
    const props = {
      workspaceId: "workspace-1",
      messages: [buildAssistantMessage(model)],
      pendingModel: model,
      use1M: false,
      workspaceUsage: buildUsage(260_000, model),
      api: undefined,
      pendingSendOptions: buildSendOptions(model),
    };

    const { result } = renderHook((hookProps: typeof props) => useContextSwitchWarning(hookProps), {
      initialProps: props,
      wrapper,
    });

    await waitFor(() => expect(result.current.warning).toBeNull());
  });

  test("warns when the user switches to a smaller context model", async () => {
    const previousModel = "anthropic:claude-sonnet-4-5";
    const nextModel = "openai:gpt-5.2-codex";
    const props = {
      workspaceId: "workspace-2",
      messages: [buildAssistantMessage(previousModel)],
      pendingModel: previousModel,
      use1M: false,
      workspaceUsage: buildUsage(260_000, previousModel),
      api: undefined,
      pendingSendOptions: buildSendOptions(previousModel),
    };

    const { result, rerender } = renderHook(
      (hookProps: typeof props) => useContextSwitchWarning(hookProps),
      { initialProps: props, wrapper }
    );

    act(() => {
      result.current.handleModelChange(nextModel);
    });

    act(() => {
      rerender({
        ...props,
        pendingModel: nextModel,
        pendingSendOptions: buildSendOptions(nextModel),
      });
    });

    await waitFor(() => expect(result.current.warning?.targetModel).toBe(nextModel));
  });

  test("does not warn when the model changes via sync", async () => {
    const previousModel = "anthropic:claude-sonnet-4-5";
    const nextModel = "openai:gpt-5.2-codex";
    const props = {
      workspaceId: "workspace-3",
      messages: [buildAssistantMessage(previousModel)],
      pendingModel: previousModel,
      use1M: false,
      workspaceUsage: buildUsage(260_000, previousModel),
      api: undefined,
      pendingSendOptions: buildSendOptions(previousModel),
    };

    const { result, rerender } = renderHook(
      (hookProps: typeof props) => useContextSwitchWarning(hookProps),
      { initialProps: props, wrapper }
    );

    act(() => {
      rerender({
        ...props,
        pendingModel: nextModel,
        pendingSendOptions: buildSendOptions(nextModel),
      });
    });

    await waitFor(() => expect(result.current.warning).toBeNull());
  });

  test("warns when 1M is toggled off and context no longer fits", async () => {
    const model = "anthropic:claude-sonnet-4-5";
    const baseLimit = getEffectiveContextLimit(model, false);
    expect(baseLimit).not.toBeNull();
    if (!baseLimit) return;

    const tokens = Math.floor(baseLimit * 1.05);
    const props = {
      workspaceId: "workspace-4",
      messages: [buildAssistantMessage(model)],
      pendingModel: model,
      use1M: true,
      workspaceUsage: buildUsage(tokens, model),
      api: undefined,
      pendingSendOptions: buildSendOptions(model),
    };

    const { result, rerender } = renderHook(
      (hookProps: typeof props) => useContextSwitchWarning(hookProps),
      { initialProps: props, wrapper }
    );

    await waitFor(() => expect(result.current.warning).toBeNull());

    act(() => {
      rerender({
        ...props,
        use1M: false,
      });
    });

    await waitFor(() => expect(result.current.warning?.targetModel).toBe(model));
  });

  test("does not warn when 1M toggle does not change the limit", async () => {
    const model = "openai:gpt-5.2-codex";
    const limit = getEffectiveContextLimit(model, false);
    expect(limit).not.toBeNull();
    if (!limit) return;

    const tokens = Math.floor(limit * 0.95);
    const props = {
      workspaceId: "workspace-5",
      messages: [buildAssistantMessage(model)],
      pendingModel: model,
      use1M: false,
      workspaceUsage: buildUsage(tokens, model),
      api: undefined,
      pendingSendOptions: buildSendOptions(model),
    };

    const { result, rerender } = renderHook(
      (hookProps: typeof props) => useContextSwitchWarning(hookProps),
      { initialProps: props, wrapper }
    );

    await waitFor(() => expect(result.current.warning).toBeNull());

    act(() => {
      rerender({
        ...props,
        use1M: true,
      });
    });

    await waitFor(() => expect(result.current.warning).toBeNull());
  });
});

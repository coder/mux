import { GlobalWindow } from "happy-dom";

// Setup basic DOM environment for testing-library
const dom = new GlobalWindow();
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
(global as any).window = dom.window;
(global as any).document = dom.window.document;
(global as any).console = console;
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */

import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";

import { TooltipProvider } from "@/browser/components/ui/tooltip";
import { ChatInput } from "./index";

const useSendMessageOptionsMock = mock(() => ({
  // When mux-gateway is enabled, the actual send model is transformed.
  model: "mux-gateway:openai/gpt-4o",
  // UI should continue to use the canonical provider:model form.
  baseModel: "openai:gpt-4o",
  thinkingLevel: "off",
  mode: "exec",
  toolPolicy: "auto",
  providerOptions: {},
}));

void mock.module("@/browser/hooks/useSendMessageOptions", () => ({
  useSendMessageOptions: useSendMessageOptionsMock,
}));

void mock.module("@/browser/hooks/useModelLRU", () => ({
  useModelLRU: () => ({
    recentModels: ["openai:gpt-4o"],
    addModel: () => undefined,
    defaultModel: "openai:gpt-4o",
    setDefaultModel: () => undefined,
  }),
}));

void mock.module("@/browser/hooks/useVoiceInput", () => ({
  useVoiceInput: () => ({
    state: "idle",
    isApiKeySet: false,
    shouldShowUI: false,
    requiresSecureContext: false,
    toggle: () => undefined,
  }),
}));

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({ api: null, status: "connected", error: null }),
}));

void mock.module("@/browser/contexts/SettingsContext", () => ({
  useSettings: () => ({ open: () => undefined }),
}));

void mock.module("@/browser/contexts/WorkspaceContext", () => ({
  useWorkspaceContext: () => ({ selectedWorkspace: null }),
}));

void mock.module("@/browser/contexts/ModeContext", () => ({
  useMode: () => ["exec", () => undefined] as const,
}));

void mock.module("@/browser/contexts/TutorialContext", () => ({
  useTutorial: () => ({ startSequence: () => undefined }),
}));

// These are unrelated to the model selector rendering, but ChatInput imports them
// and they can trigger extra work. Keep the test focused.
void mock.module("@/browser/components/ModelSettings", () => ({
  ModelSettings: () => null,
}));

void mock.module("@/browser/components/ThinkingSlider", () => ({
  ThinkingSliderComponent: () => null,
}));

void mock.module("@/browser/utils/tokenizer/rendererClient", () => ({
  getTokenCountPromise: () => Promise.resolve(0),
}));

void mock.module("@/browser/hooks/useTelemetry", () => ({
  useTelemetry: () => ({ track: () => undefined }),
}));

void mock.module("./useCreationWorkspace", () => ({
  useCreationWorkspace: () => ({
    state: "idle",
    canCreate: false,
    create: () => Promise.resolve(null),
  }),
}));

describe("ChatInput model display", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  test("renders the canonical (pretty) model name even when mux-gateway is enabled", async () => {
    const { getByText } = render(
      <TooltipProvider>
        <ChatInput
          variant="workspace"
          workspaceId="ws-1"
          disabled
          onTruncateHistory={() => Promise.resolve()}
        />
      </TooltipProvider>
    );

    // If ChatInput passes the gateway-transformed model to ModelSelector,
    // the display becomes "Openai/gpt 4o" (ugly) instead of "GPT-4o".
    await waitFor(() => {
      expect(getByText("GPT-4o")).toBeTruthy();
    });
  });
});

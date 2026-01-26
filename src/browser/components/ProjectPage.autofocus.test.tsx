import React, { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { SettingsProvider } from "@/browser/contexts/SettingsContext";
import { cleanup, render, waitFor } from "@testing-library/react";

let focusMock: ReturnType<typeof mock> | null = null;
let readyCalls = 0;

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: null,
    status: "connecting" as const,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

// Mock useProvidersConfig to return a configured provider so ChatInput renders
void mock.module("@/browser/hooks/useProvidersConfig", () => ({
  useProvidersConfig: () => ({
    config: { anthropic: { apiKeySet: true, isConfigured: true } },
    loading: false,
    error: null,
  }),
}));

// Mock ConfiguredProvidersBar to avoid tooltip/context dependencies
void mock.module("./ConfiguredProvidersBar", () => ({
  ConfiguredProvidersBar: () => <div data-testid="ConfiguredProvidersBarMock" />,
}));

// Mock ChatInput to simulate the old (buggy) behavior where onReady can fire again
// on unrelated re-renders (e.g. workspace list updates).
void mock.module("./ChatInput/index", () => ({
  ChatInput: (props: {
    onReady?: (api: {
      focus: () => void;
      restoreText: (text: string) => void;
      appendText: (text: string) => void;
      prependText: (text: string) => void;
      restoreAttachments: (images: unknown[]) => void;
    }) => void;
  }) => {
    useEffect(() => {
      readyCalls += 1;

      props.onReady?.({
        focus: () => {
          if (!focusMock) {
            throw new Error("focusMock not initialized");
          }
          focusMock();
        },
        restoreText: () => undefined,
        appendText: () => undefined,
        prependText: () => undefined,
        restoreAttachments: () => undefined,
      });
    }, [props]);

    return <div data-testid="ChatInputMock" />;
  },
}));

import { ProjectPage } from "./ProjectPage";

describe("ProjectPage", () => {
  beforeEach(() => {
    const dom = new GlobalWindow();
    globalThis.window = dom as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    readyCalls = 0;
    focusMock = mock(() => undefined);
  });

  afterEach(() => {
    cleanup();
    focusMock = null;
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("auto-focuses the creation input only once even if ChatInput re-initializes", async () => {
    const baseProps = {
      projectPath: "/projects/demo",
      projectName: "demo",
      leftSidebarCollapsed: true,
      onToggleLeftSidebarCollapsed: () => undefined,
      onProviderConfig: () => Promise.resolve(undefined),
      onWorkspaceCreated: () => undefined,
    };

    const { rerender } = render(
      <SettingsProvider>
        <ProjectPage {...baseProps} />
      </SettingsProvider>
    );

    await waitFor(() => expect(readyCalls).toBe(1));
    await waitFor(() => expect(focusMock).toHaveBeenCalledTimes(1));

    // Simulate an unrelated App re-render that changes an inline callback identity.
    rerender(
      <SettingsProvider>
        <ProjectPage {...baseProps} onWorkspaceCreated={() => undefined} />
      </SettingsProvider>
    );

    await waitFor(() => expect(readyCalls).toBe(2));

    // Focus should not be re-triggered (would move caret to end).
    expect(focusMock).toHaveBeenCalledTimes(1);
  });
});

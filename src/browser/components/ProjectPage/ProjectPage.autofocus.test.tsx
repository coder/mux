import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { RouterProvider } from "@/browser/contexts/RouterContext";
import { SettingsProvider } from "@/browser/contexts/SettingsContext";
import { cleanup, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";

let cleanupDom: (() => void) | null = null;
let focusMock: ReturnType<typeof mock> | null = null;
let readyCalls = 0;

// Mock lottie-react so CreationCenterContent/WorkspaceShell imports don't execute
// lottie-web canvas initialization in happy-dom (which causes unhandled errors).
void mock.module("lottie-react", () => ({
  __esModule: true,
  default: () => <div data-testid="LottieMock" />,
}));

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
    config: { anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true } },
    loading: false,
    error: null,
  }),
}));

// Mock ConfiguredProvidersBar to avoid tooltip/context dependencies
void mock.module("@/browser/components/ConfiguredProvidersBar/ConfiguredProvidersBar", () => ({
  ConfiguredProvidersBar: () => <div data-testid="ConfiguredProvidersBarMock" />,
}));

// Mock ProjectContext to provide trust data without requiring a full provider.
// Must include all fields consumed by downstream hooks (e.g., useDraftWorkspaceSettings
// reads userProjects) since bun test may share mock scope across files.
void mock.module("@/browser/contexts/ProjectContext", () => ({
  useProjectContext: () => ({
    userProjects: new Map(),
    getProjectConfig: () => undefined,
    refreshProjects: () => Promise.resolve(),
  }),
}));

// Mock ChatInput to simulate the old (buggy) behavior where onReady can fire again
// on unrelated re-renders (e.g. workspace list updates).
void mock.module("@/browser/features/ChatInput/index", () => ({
  ChatInput: (props: {
    onReady?: (api: {
      focus: () => void;
      restoreText: (text: string) => void;
      restoreDraft: (pending: unknown) => void;
      appendText: (text: string) => void;
      prependText: (text: string) => void;
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
        restoreDraft: () => undefined,
        appendText: () => undefined,
        prependText: () => undefined,
      });
    }, [props]);

    return <div data-testid="ChatInputMock" />;
  },
}));

import { ProjectPage } from "../ProjectPage/ProjectPage";

describe("ProjectPage", () => {
  beforeEach(() => {
    cleanupDom = installDom();

    readyCalls = 0;
    focusMock = mock(() => undefined);
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
    focusMock = null;
  });

  test("auto-focuses the creation input only once even if ChatInput re-initializes", async () => {
    const baseProps = {
      projectPath: "/projects/demo",
      projectName: "demo",
      leftSidebarCollapsed: true,
      onToggleLeftSidebarCollapsed: () => undefined,
      onWorkspaceCreated: () => undefined,
    };

    const { rerender } = render(
      <RouterProvider>
        <SettingsProvider>
          <ProjectPage {...baseProps} />
        </SettingsProvider>
      </RouterProvider>
    );

    await waitFor(() => expect(readyCalls).toBe(1));
    await waitFor(() => expect(focusMock).toHaveBeenCalledTimes(1));

    // Simulate an unrelated App re-render that changes an inline callback identity.
    rerender(
      <RouterProvider>
        <SettingsProvider>
          <ProjectPage {...baseProps} onWorkspaceCreated={() => undefined} />
        </SettingsProvider>
      </RouterProvider>
    );

    await waitFor(() => expect(readyCalls).toBe(2));

    // Focus should not be re-triggered (would move caret to end).
    expect(focusMock).toHaveBeenCalledTimes(1);
  });
});

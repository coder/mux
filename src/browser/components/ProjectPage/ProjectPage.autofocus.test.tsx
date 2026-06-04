import { createContext, useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { requireTestModule } from "@/browser/testUtils";
import { RouterProvider } from "@/browser/contexts/RouterContext";
import { SettingsProvider } from "@/browser/contexts/SettingsContext";
import { cleanup, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import type * as ProjectPageModule from "@/browser/components/ProjectPage/ProjectPage";
import type * as WorkspaceContextModule from "@/browser/contexts/WorkspaceContext";

let cleanupDom: (() => void) | null = null;
let focusMock: ReturnType<typeof mock> | null = null;
let readyCalls = 0;

function registerProjectPageMocks() {
  // Re-register mocks before each test because afterEach restores them and this
  // file should not depend on top-level module mock state leaking across tests.

  // Mock lottie-react so CreationCenterContent/WorkspaceShell imports don't execute
  // lottie-web canvas initialization in happy-dom (which causes unhandled errors).
  void mock.module("lottie-react", () => ({
    __esModule: true,
    default: () => <div data-testid="LottieMock" />,
  }));

  const apiContextValue = {
    api: null,
    status: "connecting" as const,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  };
  void mock.module("@/browser/contexts/API", () => ({
    APIContext: createContext(apiContextValue),
    APIProvider: (props: { children: ReactNode }) => props.children,
    useAPI: () => apiContextValue,
    useOptionalAPI: () => apiContextValue,
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
  const providerBarFrameClass = "flex h-9 items-center justify-center gap-2 text-sm";
  void mock.module("@/browser/components/ConfiguredProvidersBar/ConfiguredProvidersBar", () => ({
    CONFIGURED_PROVIDERS_BAR_FRAME_CLASS: providerBarFrameClass,
    ConfiguredProvidersBar: () => (
      <div className={providerBarFrameClass} data-component="ConfiguredProvidersBar" />
    ),
    ConfiguredProvidersBarSkeleton: () => (
      <div className={providerBarFrameClass} data-component="ConfiguredProvidersBarSkeleton" />
    ),
  }));

  // Mock ProjectContext to provide the minimal routing/project surface used by the
  // real WorkspaceProvider/AgentProvider stack without wiring the full app shell.
  void mock.module("@/browser/contexts/ProjectContext", () => ({
    ProjectProvider: (props: { children: ReactNode }) => props.children,
    useProjectContext: () => ({
      userProjects: new Map(),
      systemProjectPath: null,
      resolveProjectPath: () => null,
      resolveNewChatProjectPath: () => null,
      getProjectConfig: () => undefined,
      loading: false,
      refreshProjects: () => Promise.resolve(),
      addProject: () => undefined,
      removeProject: () => Promise.resolve({ success: true }),
      isProjectCreateModalOpen: false,
      openProjectCreateModal: () => undefined,
      closeProjectCreateModal: () => undefined,
      workspaceModalState: {
        isOpen: false,
        projectPath: null,
        projectName: "",
        branches: [],
        defaultTrunkBranch: undefined,
        loadErrorMessage: null,
        isLoading: false,
      },
      openWorkspaceModal: () => Promise.resolve(),
      closeWorkspaceModal: () => undefined,
      getBranchesForProject: () => Promise.resolve({ branches: [], trunkBranch: null }),
      getSecrets: () => Promise.resolve([]),
      updateSecrets: () => Promise.resolve(),
      updateDisplayName: () => Promise.resolve({ success: true }),
      createSection: () => Promise.resolve({ ok: false, error: "not implemented in test" }),
      updateSection: () => Promise.resolve({ ok: false, error: "not implemented in test" }),
      removeSection: () => Promise.resolve({ ok: false, error: "not implemented in test" }),
      reorderSections: () => Promise.resolve({ ok: false, error: "not implemented in test" }),
      assignWorkspaceToSection: () =>
        Promise.resolve({ ok: false, error: "not implemented in test" }),
      hasAnyProject: false,
    }),
  }));

  // Mock ChatInput to simulate the old (buggy) behavior where onReady can fire again
  // on unrelated re-renders (e.g. workspace list updates).
  void mock.module("@/browser/features/ChatInput/index", () => ({
    CREATION_CHAT_INPUT_SECTION_FRAME_CLASS:
      "bg-surface-primary border-border-light min-h-56 w-full max-w-3xl rounded-lg border px-6 py-5 shadow-lg",
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
}

describe("ProjectPage", () => {
  beforeEach(() => {
    cleanupDom = installDom();

    readyCalls = 0;
    focusMock = mock(() => undefined);
    registerProjectPageMocks();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
    focusMock = null;
  });

  test("auto-focuses the creation input only once even if ChatInput re-initializes", async () => {
    const { ProjectPage } = requireTestModule<{
      ProjectPage: typeof ProjectPageModule.ProjectPage;
    }>("@/browser/components/ProjectPage/ProjectPage");
    const { WorkspaceProvider } = requireTestModule<{
      WorkspaceProvider: typeof WorkspaceContextModule.WorkspaceProvider;
    }>("@/browser/contexts/WorkspaceContext");

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
          <WorkspaceProvider>
            <ProjectPage {...baseProps} />
          </WorkspaceProvider>
        </SettingsProvider>
      </RouterProvider>
    );

    await waitFor(() => expect(focusMock).toHaveBeenCalledTimes(1));
    const readyCallsAfterInitialHydration = readyCalls;

    // Simulate an unrelated App re-render that changes an inline callback identity.
    rerender(
      <RouterProvider>
        <SettingsProvider>
          <WorkspaceProvider>
            <ProjectPage {...baseProps} onWorkspaceCreated={() => undefined} />
          </WorkspaceProvider>
        </SettingsProvider>
      </RouterProvider>
    );

    await waitFor(() => expect(readyCalls).toBeGreaterThan(readyCallsAfterInitialHydration));

    // Focus should not be re-triggered (would move caret to end).
    expect(focusMock).toHaveBeenCalledTimes(1);
  });
});

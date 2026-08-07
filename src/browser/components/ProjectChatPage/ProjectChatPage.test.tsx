import "../../../../tests/ui/dom";

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import { requireTestModule } from "@/browser/testUtils";
import type { ProjectConfig } from "@/common/types/project";
import type * as ProjectChatPageModule from "./ProjectChatPage";

const parentProjectPath = "/repo";
const firstSubProjectPath = "/repo/packages/first";
const secondSubProjectPath = "/repo/packages/second";

let cleanupDom: (() => void) | null = null;
let projectConfigs = new Map<string, ProjectConfig>();
let getOrCreateMock = mock((_input: { projectPath: string }) =>
  Promise.resolve({ success: false as const, error: "Stop after trust check" })
);
let setTrustMock = mock((_input: { projectPath: string; trusted: boolean }) => Promise.resolve());
let refreshProjectsMock = mock(() => Promise.resolve());

const api = {
  projects: {
    chat: {
      getOrCreate: (input: { projectPath: string }) => getOrCreateMock(input),
    },
    setTrust: (input: { projectPath: string; trusted: boolean }) => setTrustMock(input),
  },
};

const workspaceStore = {
  addAuxiliaryChat: mock(() => undefined),
  setActiveWorkspaceId: mock(() => undefined),
  removeAuxiliaryChat: mock(() => undefined),
};

function registerMocks() {
  void mock.module("@/browser/contexts/API", () => ({
    useAPI: () => ({ api }),
  }));
  void mock.module("@/browser/contexts/ProjectContext", () => ({
    useProjectContext: () => ({
      getProjectConfig: (projectPath: string) => projectConfigs.get(projectPath),
      refreshProjects: refreshProjectsMock,
      loading: false,
    }),
  }));
  void mock.module("@/browser/stores/WorkspaceStore", () => ({
    useWorkspaceStoreRaw: () => workspaceStore,
  }));
  void mock.module("@/browser/components/ProjectChatHeader/ProjectChatHeader", () => ({
    ProjectChatHeader: () => <div data-testid="project-chat-header" />,
  }));
  void mock.module("@/browser/components/AIView/AIView", () => ({
    AIView: () => <div data-testid="project-chat-ai-view" />,
  }));
  void mock.module("@/browser/components/ConfirmationModal/ConfirmationModal", () => ({
    ConfirmationModal: (props: {
      isOpen: boolean;
      confirmLabel: string;
      cancelLabel: string;
      onConfirm: () => Promise<void>;
      onCancel: () => void;
    }) =>
      props.isOpen ? (
        <div data-testid="trust-confirmation-modal">
          <button type="button" onClick={() => void props.onConfirm()}>
            {props.confirmLabel}
          </button>
          <button type="button" onClick={props.onCancel}>
            {props.cancelLabel}
          </button>
        </div>
      ) : null,
  }));
  void mock.module("@/browser/hooks/usePersistedState", () => ({
    updatePersistedState: () => undefined,
  }));
  void mock.module("@/browser/utils/modelChange", () => ({
    setWorkspaceModelWithOrigin: () => undefined,
  }));
}

function renderProjectChat(
  ProjectChatPage: typeof ProjectChatPageModule.ProjectChatPage,
  projectPath: string
) {
  return render(
    <ProjectChatPage
      projectPath={projectPath}
      projectName="Project"
      leftSidebarCollapsed={false}
      onToggleLeftSidebarCollapsed={() => undefined}
    />
  );
}

describe("ProjectChatPage sub-project trust ownership", () => {
  beforeEach(() => {
    cleanup();
    cleanupDom = installDom();
    projectConfigs = new Map();
    getOrCreateMock = mock((_input: { projectPath: string }) =>
      Promise.resolve({ success: false as const, error: "Stop after trust check" })
    );
    setTrustMock = mock((_input: { projectPath: string; trusted: boolean }) => Promise.resolve());
    refreshProjectsMock = mock(() => Promise.resolve());
    registerMocks();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  afterAll(() => {
    mock.restore();
  });

  it("uses the trusted parent state when opening a registered sub-project chat", async () => {
    projectConfigs.set(parentProjectPath, { workspaces: [], trusted: true });
    projectConfigs.set(firstSubProjectPath, { workspaces: [], parentProjectPath });
    const { ProjectChatPage } = requireTestModule<typeof ProjectChatPageModule>(
      "@/browser/components/ProjectChatPage/ProjectChatPage"
    );

    const view = renderProjectChat(ProjectChatPage, firstSubProjectPath);

    await waitFor(() =>
      expect(getOrCreateMock).toHaveBeenCalledWith({ projectPath: firstSubProjectPath })
    );
    expect(view.queryByTestId("project-chat-trust-gate")).toBeNull();
    expect(setTrustMock).not.toHaveBeenCalled();
  });

  it("owns dismissal, optimistic trust, and trust writes at the untrusted parent", async () => {
    projectConfigs.set(parentProjectPath, { workspaces: [], trusted: false });
    projectConfigs.set(firstSubProjectPath, { workspaces: [], parentProjectPath });
    projectConfigs.set(secondSubProjectPath, { workspaces: [], parentProjectPath });
    const { ProjectChatPage } = requireTestModule<typeof ProjectChatPageModule>(
      "@/browser/components/ProjectChatPage/ProjectChatPage"
    );

    const view = renderProjectChat(ProjectChatPage, firstSubProjectPath);
    expect(view.getByTestId("trust-confirmation-modal")).not.toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Not now" }));
    expect(view.queryByTestId("trust-confirmation-modal")).toBeNull();

    view.rerender(
      <ProjectChatPage
        projectPath={secondSubProjectPath}
        projectName="Second"
        leftSidebarCollapsed={false}
        onToggleLeftSidebarCollapsed={() => undefined}
      />
    );
    expect(view.queryByTestId("trust-confirmation-modal")).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Trust project" }));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Trust and continue" }));
      await Promise.resolve();
    });

    expect(setTrustMock).toHaveBeenCalledWith({ projectPath: parentProjectPath, trusted: true });
    await waitFor(() =>
      expect(getOrCreateMock).toHaveBeenCalledWith({ projectPath: secondSubProjectPath })
    );
    expect(view.queryByTestId("project-chat-trust-gate")).toBeNull();
  });
});

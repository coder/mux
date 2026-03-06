import "../../../../tests/ui/dom";

import type { APIClient } from "@/browser/contexts/API";
import { RouterProvider } from "@/browser/contexts/RouterContext";
import { SettingsProvider } from "@/browser/contexts/SettingsContext";
import type { RecursivePartial } from "@/browser/testUtils";
import type { ProjectConfig } from "@/common/types/project";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";

let cleanupDom: (() => void) | null = null;
let currentClientMock: RecursivePartial<APIClient> = {};
let currentProjectConfig: ProjectConfig | undefined;
const refreshProjectsMock = mock(() => Promise.resolve());

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: currentClientMock as APIClient,
    status: "connected" as const,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

void mock.module("@/browser/hooks/useProvidersConfig", () => ({
  useProvidersConfig: () => ({
    config: { anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true } },
    loading: false,
    error: null,
  }),
}));

void mock.module("@/browser/components/ConfiguredProvidersBar/ConfiguredProvidersBar", () => ({
  ConfiguredProvidersBar: () => <div data-testid="ConfiguredProvidersBarMock" />,
}));

void mock.module("@/browser/components/ProjectMCPOverview/ProjectMCPOverview", () => ({
  ProjectMCPOverview: () => <div data-testid="ProjectMCPOverviewMock" />,
}));

void mock.module("@/browser/components/ArchivedWorkspaces/ArchivedWorkspaces", () => ({
  ArchivedWorkspaces: () => <div data-testid="ArchivedWorkspacesMock" />,
}));

void mock.module("@/browser/components/GitInitBanner/GitInitBanner", () => ({
  GitInitBanner: () => <div data-testid="GitInitBannerMock" />,
}));

void mock.module("@/browser/components/ConfigureProvidersPrompt/ConfigureProvidersPrompt", () => ({
  ConfigureProvidersPrompt: () => <div data-testid="ConfigureProvidersPromptMock" />,
}));

void mock.module("@/browser/components/AgentsInitBanner/AgentsInitBanner", () => ({
  AgentsInitBanner: () => <div data-testid="AgentsInitBannerMock" />,
}));

void mock.module("@/browser/contexts/AgentContext", () => ({
  AgentProvider: ({ children }: { children: React.ReactNode }) => children,
}));

void mock.module("@/browser/contexts/ThinkingContext", () => ({
  ThinkingProvider: ({ children }: { children: React.ReactNode }) => children,
}));

void mock.module("@/browser/features/ChatInput/index", () => ({
  ChatInput: () => <div data-testid="ChatInputMock" />,
}));

void mock.module("@/browser/contexts/ProjectContext", () => ({
  useProjectContext: () => ({
    userProjects: new Map(),
    getProjectConfig: () => currentProjectConfig,
    refreshProjects: refreshProjectsMock,
  }),
}));

import { ProjectPage } from "../ProjectPage/ProjectPage";

function createEmptyMetadataIterator(): Awaited<ReturnType<APIClient["workspace"]["onMetadata"]>> {
  return (async function* () {
    return;
  })() as unknown as Awaited<ReturnType<APIClient["workspace"]["onMetadata"]>>;
}

const baseProps = {
  projectPath: "/projects/demo",
  projectName: "demo",
  leftSidebarCollapsed: true,
  onToggleLeftSidebarCollapsed: () => undefined,
  onWorkspaceCreated: () => undefined,
};

describe("ProjectPage metadata editor", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    currentProjectConfig = undefined;
    currentClientMock = {};
    refreshProjectsMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
    currentProjectConfig = undefined;
    currentClientMock = {};
    refreshProjectsMock.mockClear();
  });

  test("prepopulates metadata, hides root working directory, and preserves retained directory IDs", async () => {
    const updateMock = mock(() =>
      Promise.resolve({
        success: true as const,
        data: {
          workspaces: [],
          projectId: "proj_demo",
          name: "Demo Project",
          systemPrompt: undefined,
          workingDirectories: [
            { id: "wd-root", path: "/projects/demo" },
            { id: "wd-packages", path: "/projects/demo/packages" },
          ],
        },
      })
    );

    currentProjectConfig = {
      workspaces: [],
      projectId: "proj_demo",
      name: "Demo Project",
      systemPrompt: "Keep tests deterministic",
      workingDirectories: [
        { id: "wd-root", path: "/projects/demo" },
        { id: "wd-apps", path: "/projects/demo/apps" },
        { id: "wd-packages", path: "/projects/demo/packages" },
      ],
    };

    currentClientMock = {
      projects: {
        listBranches: () => Promise.resolve({ branches: ["main"], recommendedTrunk: "main" }),
        update: updateMock,
      },
      workspace: {
        list: () => Promise.resolve([]),
        onMetadata: () => Promise.resolve(createEmptyMetadataIterator()),
      },
    };

    const { getByLabelText, getByDisplayValue, getByRole, queryByDisplayValue } = render(
      <RouterProvider>
        <SettingsProvider>
          <ProjectPage {...baseProps} />
        </SettingsProvider>
      </RouterProvider>
    );

    await waitFor(() =>
      expect((getByLabelText("Project name") as HTMLInputElement).value).toBe("Demo Project")
    );
    expect((getByLabelText("System prompt") as HTMLTextAreaElement).value).toBe(
      "Keep tests deterministic"
    );
    expect(queryByDisplayValue("/projects/demo")).toBeNull();
    expect(getByDisplayValue("/projects/demo/apps")).toBeTruthy();
    expect(getByDisplayValue("/projects/demo/packages")).toBeTruthy();

    const user = userEvent.setup({ document: getByLabelText("Project name").ownerDocument });

    await user.click(
      getByRole("button", { name: "Remove extra working directory /projects/demo/apps" })
    );

    const systemPromptInput = getByLabelText("System prompt") as HTMLTextAreaElement;
    await user.click(systemPromptInput);
    await user.keyboard("{Control>}a{/Control}{Backspace}");

    await user.click(getByRole("button", { name: "Save metadata" }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/projects/demo",
        projectId: "proj_demo",
        name: "Demo Project",
        systemPrompt: null,
        workingDirectories: [{ id: "wd-packages", path: "/projects/demo/packages" }],
      })
    );

    await waitFor(() => expect(refreshProjectsMock).toHaveBeenCalledTimes(1));
  });

  test("sends an empty workingDirectories payload when all extras are removed", async () => {
    const updateMock = mock(() =>
      Promise.resolve({
        success: true as const,
        data: {
          workspaces: [],
          projectId: "proj_demo",
          name: "Demo Project",
          systemPrompt: "Updated prompt",
          workingDirectories: [{ id: "wd-root", path: "/projects/demo" }],
        },
      })
    );

    currentProjectConfig = {
      workspaces: [],
      projectId: "proj_demo",
      name: "Demo Project",
      systemPrompt: "Updated prompt",
      workingDirectories: [
        { id: "wd-root", path: "/projects/demo" },
        { id: "wd-apps", path: "/projects/demo/apps" },
      ],
    };

    currentClientMock = {
      projects: {
        listBranches: () => Promise.resolve({ branches: ["main"], recommendedTrunk: "main" }),
        update: updateMock,
      },
      workspace: {
        list: () => Promise.resolve([]),
        onMetadata: () => Promise.resolve(createEmptyMetadataIterator()),
      },
    };

    const { getByRole } = render(
      <RouterProvider>
        <SettingsProvider>
          <ProjectPage {...baseProps} />
        </SettingsProvider>
      </RouterProvider>
    );

    const user = userEvent.setup({ document: globalThis.document });

    await user.click(
      getByRole("button", { name: "Remove extra working directory /projects/demo/apps" })
    );
    await user.click(getByRole("button", { name: "Save metadata" }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/projects/demo",
        projectId: "proj_demo",
        workingDirectories: [],
      })
    );
  });
});

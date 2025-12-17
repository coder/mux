import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import type { WorkspaceContext } from "./WorkspaceContext";
import { WorkspaceProvider, useWorkspaceContext } from "./WorkspaceContext";
import { ProjectProvider } from "@/browser/contexts/ProjectContext";
import { useWorkspaceStoreRaw as getWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import {
  SELECTED_WORKSPACE_KEY,
  getModelKey,
  getThinkingLevelKey,
} from "@/common/constants/storage";
import type { RecursivePartial } from "@/browser/testUtils";

import type { APIClient } from "@/browser/contexts/API";

// Mock API
let currentClientMock: RecursivePartial<APIClient> = {};
void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: currentClientMock as APIClient,
    status: "connected" as const,
    error: null,
  }),
  APIProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Helper to create test workspace metadata with default runtime config
const createWorkspaceMetadata = (
  overrides: Partial<FrontendWorkspaceMetadata> & Pick<FrontendWorkspaceMetadata, "id">
): FrontendWorkspaceMetadata => ({
  projectPath: "/test",
  projectName: "test",
  name: "main",
  namedWorkspacePath: "/test-main",
  createdAt: "2025-01-01T00:00:00.000Z",
  runtimeConfig: { type: "local", srcBaseDir: "/home/user/.mux/src" },
  ...overrides,
});

describe("WorkspaceContext", () => {
  afterEach(() => {
    cleanup();

    // Reset global workspace store to avoid cross-test leakage
    getWorkspaceStoreRaw().dispose();

    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
    globalThis.localStorage = undefined as unknown as Storage;

    currentClientMock = {};
  });

  test("syncs workspace store subscriptions when metadata loads", async () => {
    const initialWorkspaces: FrontendWorkspaceMetadata[] = [
      createWorkspaceMetadata({
        id: "ws-sync-load",
        projectPath: "/alpha",
        projectName: "alpha",
        name: "main",
        namedWorkspacePath: "/alpha-main",
      }),
    ];

    const { workspace: workspaceApi } = createMockAPI({
      workspace: {
        list: () => Promise.resolve(initialWorkspaces),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().workspaceMetadata.size).toBe(1));
    await waitFor(() =>
      expect(
        workspaceApi.onChat.mock.calls.some(
          ([{ workspaceId }]: [{ workspaceId: string }, ...unknown[]]) =>
            workspaceId === "ws-sync-load"
        )
      ).toBe(true)
    );
  });

  test("subscribes to new workspace immediately when metadata event fires", async () => {
    const { workspace: workspaceApi } = createMockAPI({
      workspace: {
        list: () => Promise.resolve([]),
      },
    });

    await setup();

    await waitFor(() => expect(workspaceApi.onMetadata.mock.calls.length).toBeGreaterThan(0));
    expect(workspaceApi.onMetadata).toHaveBeenCalled();
  });

  test("seeds model + thinking localStorage from backend metadata", async () => {
    const initialWorkspaces: FrontendWorkspaceMetadata[] = [
      createWorkspaceMetadata({
        id: "ws-ai",
        aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "xhigh" },
      }),
    ];

    createMockAPI({
      workspace: {
        list: () => Promise.resolve(initialWorkspaces),
      },
      localStorage: {
        // Seed with different values; backend should win.
        [getModelKey("ws-ai")]: JSON.stringify("anthropic:claude-3.5"),
        [getThinkingLevelKey("ws-ai")]: JSON.stringify("low"),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().workspaceMetadata.size).toBe(1));

    expect(JSON.parse(globalThis.localStorage.getItem(getModelKey("ws-ai"))!)).toBe(
      "openai:gpt-5.2"
    );
    expect(JSON.parse(globalThis.localStorage.getItem(getThinkingLevelKey("ws-ai"))!)).toBe(
      "xhigh"
    );
  });
  test("loads workspace metadata on mount", async () => {
    const initialWorkspaces: FrontendWorkspaceMetadata[] = [
      createWorkspaceMetadata({
        id: "ws-1",
        projectPath: "/alpha",
        projectName: "alpha",
        name: "main",
        namedWorkspacePath: "/alpha-main",
      }),
    ];

    createMockAPI({
      workspace: {
        list: () => Promise.resolve(initialWorkspaces),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().workspaceMetadata.size).toBe(1));

    const metadata = ctx().workspaceMetadata.get("ws-1");
    expect(metadata?.createdAt).toBe("2025-01-01T00:00:00.000Z");
  });

  test("sets empty map on API error during load", async () => {
    createMockAPI({
      workspace: {
        list: () => Promise.reject(new Error("API Error")),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    expect(ctx().workspaceMetadata.size).toBe(0);
  });

  test("refreshWorkspaceMetadata reloads workspace data", async () => {
    const initialWorkspaces: FrontendWorkspaceMetadata[] = [
      createWorkspaceMetadata({ id: "ws-1" }),
    ];
    const updatedWorkspaces: FrontendWorkspaceMetadata[] = [
      createWorkspaceMetadata({ id: "ws-1" }),
      createWorkspaceMetadata({ id: "ws-2" }),
    ];

    let callCount = 0;
    createMockAPI({
      workspace: {
        list: () => {
          callCount++;
          return Promise.resolve(callCount === 1 ? initialWorkspaces : updatedWorkspaces);
        },
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().workspaceMetadata.size).toBe(1));

    await ctx().refreshWorkspaceMetadata();

    await waitFor(() => expect(ctx().workspaceMetadata.size).toBe(2));
  });

  test("createWorkspace creates new workspace and reloads data", async () => {
    const { workspace: workspaceApi } = createMockAPI();

    const ctx = await setup();

    const newMetadata = createWorkspaceMetadata({ id: "ws-new" });
    workspaceApi.create.mockResolvedValue({ success: true as const, metadata: newMetadata });

    await ctx().createWorkspace("path", "name", "main");

    expect(workspaceApi.create).toHaveBeenCalled();
    // Verify list called (might be 1 or 2 times depending on optimization)
    expect(workspaceApi.list).toHaveBeenCalled();
  });

  test("createWorkspace throws on failure", async () => {
    const { workspace: workspaceApi } = createMockAPI();

    const ctx = await setup();

    workspaceApi.create.mockResolvedValue({ success: false, error: "Failed" });

    return expect(ctx().createWorkspace("path", "name", "main")).rejects.toThrow("Failed");
  });

  test("removeWorkspace removes workspace and clears selection if active", async () => {
    const initialWorkspaces = [
      createWorkspaceMetadata({
        id: "ws-remove",
        projectPath: "/remove",
        projectName: "remove",
        name: "main",
        namedWorkspacePath: "/remove-main",
      }),
    ];

    createMockAPI({
      workspace: {
        list: () => Promise.resolve(initialWorkspaces),
      },
      localStorage: {
        selectedWorkspace: JSON.stringify({
          workspaceId: "ws-remove",
          projectPath: "/remove",
          projectName: "remove",
          namedWorkspacePath: "/remove-main",
        }),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().workspaceMetadata.size).toBe(1));
    expect(ctx().selectedWorkspace?.workspaceId).toBe("ws-remove");

    await ctx().removeWorkspace("ws-remove");

    await waitFor(() => expect(ctx().selectedWorkspace).toBeNull());
  });

  test("removeWorkspace handles failure gracefully", async () => {
    const { workspace: workspaceApi } = createMockAPI();

    const ctx = await setup();

    workspaceApi.remove.mockResolvedValue({
      success: false,
      error: "Failed",
    });

    const result = await ctx().removeWorkspace("ws-1");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Failed");
  });

  test("renameWorkspace updates workspace title (now uses updateTitle API)", async () => {
    const initialWorkspaces = [
      createWorkspaceMetadata({
        id: "ws-title-edit",
        projectPath: "/project",
        projectName: "project",
        name: "branch-a1b2",
        namedWorkspacePath: "/project-branch",
      }),
    ];

    const { workspace: workspaceApi } = createMockAPI({
      workspace: {
        list: () => Promise.resolve(initialWorkspaces),
      },
    });

    const ctx = await setup();

    workspaceApi.updateTitle.mockResolvedValue({
      success: true as const,
      data: undefined,
    });

    // Mock list to return workspace with updated title after update
    workspaceApi.list.mockResolvedValue([
      createWorkspaceMetadata({
        id: "ws-title-edit",
        projectPath: "/project",
        projectName: "project",
        name: "branch-a1b2",
        title: "New Title",
        namedWorkspacePath: "/project-branch",
      }),
    ]);

    await ctx().renameWorkspace("ws-title-edit", "New Title");

    expect(workspaceApi.updateTitle).toHaveBeenCalledWith({
      workspaceId: "ws-title-edit",
      title: "New Title",
    });
  });

  test("renameWorkspace handles failure gracefully", async () => {
    const { workspace: workspaceApi } = createMockAPI();

    const ctx = await setup();

    workspaceApi.updateTitle.mockResolvedValue({
      success: false,
      error: "Failed",
    });

    const result = await ctx().renameWorkspace("ws-1", "new");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Failed");
  });

  test("getWorkspaceInfo fetches workspace metadata", async () => {
    const { workspace: workspaceApi } = createMockAPI();
    const mockInfo = createWorkspaceMetadata({ id: "ws-info" });
    workspaceApi.getInfo.mockResolvedValue(mockInfo);

    const ctx = await setup();

    const info = await ctx().getWorkspaceInfo("ws-info");
    expect(info).toEqual(mockInfo);
    expect(workspaceApi.getInfo).toHaveBeenCalledWith({ workspaceId: "ws-info" });
  });

  test("beginWorkspaceCreation clears selection and tracks pending state", async () => {
    createMockAPI({
      localStorage: {
        selectedWorkspace: JSON.stringify({
          workspaceId: "ws-existing",
          projectPath: "/existing",
          projectName: "existing",
          namedWorkspacePath: "/existing-main",
        }),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().selectedWorkspace).toBeTruthy());

    act(() => {
      ctx().beginWorkspaceCreation("/new/project");
    });

    expect(ctx().selectedWorkspace).toBeNull();
    expect(ctx().pendingNewWorkspaceProject).toBe("/new/project");
  });

  test("reacts to metadata update events (new workspace)", async () => {
    const { workspace: workspaceApi } = createMockAPI();
    await setup();

    // Verify subscription started
    await waitFor(() => expect(workspaceApi.onMetadata).toHaveBeenCalled());

    // Note: We cannot easily simulate incoming events from the async generator mock
    // in this simple setup. We verify the subscription happens.
  });

  test("selectedWorkspace persists to localStorage", async () => {
    createMockAPI();
    const ctx = await setup();

    const selection = {
      workspaceId: "ws-persist",
      projectPath: "/persist",
      projectName: "persist",
      namedWorkspacePath: "/persist-main",
    };

    act(() => {
      ctx().setSelectedWorkspace(selection);
    });

    await waitFor(() =>
      expect(localStorage.getItem(SELECTED_WORKSPACE_KEY)).toContain("ws-persist")
    );
  });

  test("selectedWorkspace restores from localStorage on mount", async () => {
    createMockAPI({
      localStorage: {
        selectedWorkspace: JSON.stringify({
          workspaceId: "ws-restore",
          projectPath: "/restore",
          projectName: "restore",
          namedWorkspacePath: "/restore-main",
        }),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().selectedWorkspace?.workspaceId).toBe("ws-restore"));
  });

  test("launch project takes precedence over localStorage selection", async () => {
    createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([
            createWorkspaceMetadata({
              id: "ws-existing",
              projectPath: "/existing",
              projectName: "existing",
              name: "main",
              namedWorkspacePath: "/existing-main",
            }),
            createWorkspaceMetadata({
              id: "ws-launch",
              projectPath: "/launch-project",
              projectName: "launch-project",
              name: "main",
              namedWorkspacePath: "/launch-project-main",
            }),
          ]),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
      localStorage: {
        selectedWorkspace: JSON.stringify({
          workspaceId: "ws-existing",
          projectPath: "/existing",
          projectName: "existing",
          namedWorkspacePath: "/existing-main",
        }),
      },
      server: {
        getLaunchProject: () => Promise.resolve("/launch-project"),
      },
      locationHash: "#/launch-project", // Simulate launch project via URL hash
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));

    // Should have auto-selected the first workspace from launch project
    await waitFor(() => {
      expect(ctx().selectedWorkspace?.projectPath).toBe("/launch-project");
    });
  });

  test("launch project does not override existing selection", async () => {
    createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([
            createWorkspaceMetadata({
              id: "ws-existing",
              projectPath: "/existing",
              projectName: "existing",
              name: "main",
              namedWorkspacePath: "/existing-main",
            }),
            createWorkspaceMetadata({
              id: "ws-launch",
              projectPath: "/launch-project",
              projectName: "launch-project",
              name: "main",
              namedWorkspacePath: "/launch-project-main",
            }),
          ]),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
      localStorage: {
        selectedWorkspace: JSON.stringify({
          workspaceId: "ws-existing",
          projectPath: "/existing",
          projectName: "existing",
          namedWorkspacePath: "/existing-main",
        }),
      },
      server: {
        getLaunchProject: () => Promise.resolve("/launch-project"),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));

    // Should keep existing selection, not switch to launch project
    await waitFor(() => {
      expect(ctx().selectedWorkspace?.workspaceId).toBe("ws-existing");
    });
    expect(ctx().selectedWorkspace?.projectPath).toBe("/existing");
  });

  test("WorkspaceProvider calls ProjectContext.refreshProjects after loading", async () => {
    // Verify that projects.list is called during workspace metadata loading
    const projectsListMock = mock(() => Promise.resolve([]));

    createMockAPI({
      workspace: {
        list: () => Promise.resolve([]),
      },
      projects: {
        list: projectsListMock,
      },
    });

    await setup();

    await waitFor(() => {
      // projects.list should be called during workspace metadata loading
      expect(projectsListMock).toHaveBeenCalled();
    });
  });

  test("ensureCreatedAt adds default timestamp when missing", async () => {
    // Intentionally create incomplete metadata to test default createdAt addition
    const workspaceWithoutTimestamp = {
      id: "ws-1",
      projectPath: "/alpha",
      projectName: "alpha",
      name: "main",
      namedWorkspacePath: "/alpha-main",
      // createdAt intentionally omitted to test default value
    } as unknown as FrontendWorkspaceMetadata;

    createMockAPI({
      workspace: {
        list: () => Promise.resolve([workspaceWithoutTimestamp]),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().workspaceMetadata.size).toBe(1));

    const metadata = ctx().workspaceMetadata.get("ws-1");
    expect(metadata?.createdAt).toBe("2025-01-01T00:00:00.000Z");
  });
});

async function setup() {
  const contextRef = { current: null as WorkspaceContext | null };
  function ContextCapture() {
    contextRef.current = useWorkspaceContext();
    return null;
  }

  // WorkspaceProvider needs ProjectProvider to call useProjectContext
  render(
    <ProjectProvider>
      <WorkspaceProvider>
        <ContextCapture />
      </WorkspaceProvider>
    </ProjectProvider>
  );

  // Inject client immediately to handle race conditions where effects run before store update
  getWorkspaceStoreRaw().setClient(currentClientMock as APIClient);

  await waitFor(() => expect(contextRef.current).toBeTruthy());
  return () => contextRef.current!;
}

interface MockAPIOptions {
  workspace?: RecursivePartial<APIClient["workspace"]>;
  projects?: RecursivePartial<APIClient["projects"]>;
  server?: RecursivePartial<APIClient["server"]>;
  localStorage?: Record<string, string>;
  locationHash?: string;
}

function createMockAPI(options: MockAPIOptions = {}) {
  const happyWindow = new GlobalWindow();
  globalThis.window = happyWindow as unknown as Window & typeof globalThis;
  globalThis.document = happyWindow.document as unknown as Document;
  globalThis.localStorage = happyWindow.localStorage;

  // Set up localStorage with any provided data
  if (options.localStorage) {
    for (const [key, value] of Object.entries(options.localStorage)) {
      globalThis.localStorage.setItem(key, value);
    }
  }

  // Set up location hash if provided
  if (options.locationHash) {
    happyWindow.location.hash = options.locationHash;
  }

  // Create mocks
  const workspace = {
    create: mock(
      options.workspace?.create ??
        (() =>
          Promise.resolve({
            success: true as const,
            metadata: createWorkspaceMetadata({ id: "ws-1" }),
          }))
    ),
    list: mock(options.workspace?.list ?? (() => Promise.resolve([]))),
    remove: mock(options.workspace?.remove ?? (() => Promise.resolve({ success: true as const }))),
    rename: mock(
      options.workspace?.rename ??
        (() => Promise.resolve({ success: true as const, data: { newWorkspaceId: "ws-1" } }))
    ),
    updateTitle: mock(
      options.workspace?.updateTitle ??
        (() => Promise.resolve({ success: true as const, data: undefined }))
    ),
    getInfo: mock(options.workspace?.getInfo ?? (() => Promise.resolve(null))),
    // Async generators for subscriptions
    onMetadata: mock(
      options.workspace?.onMetadata ??
        (async () => {
          await Promise.resolve();
          return (
            // eslint-disable-next-line require-yield
            (async function* () {
              await Promise.resolve();
            })() as unknown as Awaited<ReturnType<APIClient["workspace"]["onMetadata"]>>
          );
        })
    ),
    getSessionUsage: mock(options.workspace?.getSessionUsage ?? (() => Promise.resolve(undefined))),
    onChat: mock(
      options.workspace?.onChat ??
        (async () => {
          await Promise.resolve();
          return (
            // eslint-disable-next-line require-yield
            (async function* () {
              await Promise.resolve();
            })() as unknown as Awaited<ReturnType<APIClient["workspace"]["onChat"]>>
          );
        })
    ),
    activity: {
      list: mock(options.workspace?.activity?.list ?? (() => Promise.resolve({}))),
      subscribe: mock(
        options.workspace?.activity?.subscribe ??
          (async () => {
            await Promise.resolve();
            return (
              // eslint-disable-next-line require-yield
              (async function* () {
                await Promise.resolve();
              })() as unknown as Awaited<
                ReturnType<APIClient["workspace"]["activity"]["subscribe"]>
              >
            );
          })
      ),
    },
    // Needed for ProjectCreateModal
    truncateHistory: mock(() => Promise.resolve({ success: true as const, data: undefined })),
    interruptStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
  };

  const projects = {
    list: mock(options.projects?.list ?? (() => Promise.resolve([]))),
    listBranches: mock(() => Promise.resolve({ branches: ["main"], recommendedTrunk: "main" })),
    secrets: {
      get: mock(() => Promise.resolve([])),
    },
  };

  const server = {
    getLaunchProject: mock(options.server?.getLaunchProject ?? (() => Promise.resolve(null))),
  };

  const terminal = {
    openWindow: mock(() => Promise.resolve()),
  };

  // Update the global mock
  currentClientMock = {
    workspace,
    projects,
    server,
    terminal,
  };

  return { workspace, projects, window: happyWindow };
}

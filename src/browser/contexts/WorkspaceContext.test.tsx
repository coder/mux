import type {
  FrontendWorkspaceMetadata,
  WorkspaceActivitySnapshot,
} from "@/common/types/workspace";
import type { IPCApi } from "@/common/types/ipc";
import type { ProjectConfig } from "@/common/types/project";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import type { WorkspaceContext } from "./WorkspaceContext";
import { WorkspaceProvider, useWorkspaceContext } from "./WorkspaceContext";
import { ProjectProvider } from "@/browser/contexts/ProjectContext";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";

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
    useWorkspaceStoreRaw().dispose();

    // @ts-expect-error - Resetting global state in tests
    globalThis.window = undefined;
    // @ts-expect-error - Resetting global state in tests
    globalThis.document = undefined;
    // @ts-expect-error - Resetting global state in tests
    globalThis.localStorage = undefined;
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
        workspaceApi.onChat.mock.calls.some(([workspaceId]) => workspaceId === "ws-sync-load")
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
    const metadataListener: Parameters<IPCApi["workspace"]["onMetadata"]>[0] =
      workspaceApi.onMetadata.mock.calls[0][0];

    const newWorkspace = createWorkspaceMetadata({ id: "ws-from-event" });
    act(() => {
      metadataListener({ workspaceId: newWorkspace.id, metadata: newWorkspace });
    });

    await waitFor(() =>
      expect(
        workspaceApi.onChat.mock.calls.some(([workspaceId]) => workspaceId === "ws-from-event")
      ).toBe(true)
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
        createdAt: "2025-01-01T00:00:00.000Z",
      }),
      createWorkspaceMetadata({
        id: "ws-2",
        projectPath: "/beta",
        projectName: "beta",
        name: "dev",
        namedWorkspacePath: "/beta-dev",
        createdAt: "2025-01-02T00:00:00.000Z",
      }),
    ];

    const { workspace: workspaceApi } = createMockAPI({
      workspace: {
        list: () => Promise.resolve(initialWorkspaces),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().workspaceMetadata.size).toBe(2));
    expect(workspaceApi.list).toHaveBeenCalled();
    expect(ctx().loading).toBe(false);
    expect(ctx().workspaceMetadata.has("ws-1")).toBe(true);
    expect(ctx().workspaceMetadata.has("ws-2")).toBe(true);
  });

  test("sets empty map on API error during load", async () => {
    createMockAPI({
      workspace: {
        list: () => Promise.reject(new Error("network failure")),
      },
    });

    const ctx = await setup();

    // Should have empty workspaces after failed load
    await waitFor(() => {
      expect(ctx().workspaceMetadata.size).toBe(0);
      expect(ctx().loading).toBe(false);
    });
  });

  test("refreshWorkspaceMetadata reloads workspace data", async () => {
    const initialWorkspaces: FrontendWorkspaceMetadata[] = [
      createWorkspaceMetadata({
        id: "ws-1",
        projectPath: "/alpha",
        projectName: "alpha",
        name: "main",
        namedWorkspacePath: "/alpha-main",
        createdAt: "2025-01-01T00:00:00.000Z",
      }),
    ];

    const updatedWorkspaces: FrontendWorkspaceMetadata[] = [
      ...initialWorkspaces,
      createWorkspaceMetadata({
        id: "ws-2",
        projectPath: "/beta",
        projectName: "beta",
        name: "dev",
        namedWorkspacePath: "/beta-dev",
        createdAt: "2025-01-02T00:00:00.000Z",
      }),
    ];

    let callCount = 0;
    const { workspace: workspaceApi } = createMockAPI({
      workspace: {
        list: () => {
          callCount++;
          return Promise.resolve(callCount === 1 ? initialWorkspaces : updatedWorkspaces);
        },
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().workspaceMetadata.size).toBe(1));

    await act(async () => {
      await ctx().refreshWorkspaceMetadata();
    });

    expect(ctx().workspaceMetadata.size).toBe(2);
    expect(workspaceApi.list.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("createWorkspace creates new workspace and reloads data", async () => {
    const newWorkspace: FrontendWorkspaceMetadata = createWorkspaceMetadata({
      id: "ws-new",
      projectPath: "/gamma",
      projectName: "gamma",
      name: "feature",
      namedWorkspacePath: "/gamma-feature",
      createdAt: "2025-01-03T00:00:00.000Z",
    });

    const { workspace: workspaceApi, projects: projectsApi } = createMockAPI({
      workspace: {
        list: () => Promise.resolve([]),
        create: () =>
          Promise.resolve({
            success: true as const,
            metadata: newWorkspace,
          }),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));

    let result: Awaited<ReturnType<WorkspaceContext["createWorkspace"]>>;
    await act(async () => {
      result = await ctx().createWorkspace("/gamma", "feature", "main");
    });

    expect(workspaceApi.create).toHaveBeenCalledWith("/gamma", "feature", "main", undefined);
    expect(projectsApi.list).toHaveBeenCalled();
    expect(result!.workspaceId).toBe("ws-new");
    expect(result!.projectPath).toBe("/gamma");
    expect(result!.projectName).toBe("gamma");
  });

  test("createWorkspace throws on failure", async () => {
    createMockAPI({
      workspace: {
        list: () => Promise.resolve([]),
        create: () =>
          Promise.resolve({
            success: false,
            error: "Failed to create workspace",
          }),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));

    expect(async () => {
      await act(async () => {
        await ctx().createWorkspace("/gamma", "feature", "main");
      });
    }).toThrow("Failed to create workspace");
  });

  test("removeWorkspace removes workspace and clears selection if active", async () => {
    const workspace: FrontendWorkspaceMetadata = createWorkspaceMetadata({
      id: "ws-1",
      projectPath: "/alpha",
      projectName: "alpha",
      name: "main",
      namedWorkspacePath: "/alpha-main",
      createdAt: "2025-01-01T00:00:00.000Z",
    });

    const { workspace: workspaceApi } = createMockAPI({
      workspace: {
        list: () => Promise.resolve([workspace]),
        remove: () => Promise.resolve({ success: true as const }),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));

    // Set the selected workspace via context API
    act(() => {
      ctx().setSelectedWorkspace({
        workspaceId: "ws-1",
        projectPath: "/alpha",
        projectName: "alpha",
        namedWorkspacePath: "/alpha-main",
      });
    });

    expect(ctx().selectedWorkspace?.workspaceId).toBe("ws-1");

    let result: Awaited<ReturnType<WorkspaceContext["removeWorkspace"]>>;
    await act(async () => {
      result = await ctx().removeWorkspace("ws-1");
    });

    expect(workspaceApi.remove).toHaveBeenCalledWith("ws-1", undefined);
    expect(result!.success).toBe(true);
    // Verify selectedWorkspace was cleared
    expect(ctx().selectedWorkspace).toBeNull();
  });

  test("removeWorkspace handles failure gracefully", async () => {
    const workspace: FrontendWorkspaceMetadata = createWorkspaceMetadata({
      id: "ws-1",
      projectPath: "/alpha",
      projectName: "alpha",
      name: "main",
      namedWorkspacePath: "/alpha-main",
      createdAt: "2025-01-01T00:00:00.000Z",
    });

    const { workspace: workspaceApi } = createMockAPI({
      workspace: {
        list: () => Promise.resolve([workspace]),
        remove: () => Promise.resolve({ success: false, error: "Permission denied" }),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));

    let result: Awaited<ReturnType<WorkspaceContext["removeWorkspace"]>>;
    await act(async () => {
      result = await ctx().removeWorkspace("ws-1");
    });

    expect(workspaceApi.remove).toHaveBeenCalledWith("ws-1", undefined);
    expect(result!.success).toBe(false);
    expect(result!.error).toBe("Permission denied");
  });

  test("renameWorkspace renames workspace and updates selection if active", async () => {
    const oldWorkspace: FrontendWorkspaceMetadata = createWorkspaceMetadata({
      id: "ws-1",
      projectPath: "/alpha",
      projectName: "alpha",
      name: "main",
      namedWorkspacePath: "/alpha-main",
      createdAt: "2025-01-01T00:00:00.000Z",
    });

    const newWorkspace: FrontendWorkspaceMetadata = createWorkspaceMetadata({
      id: "ws-2",
      projectPath: "/alpha",
      projectName: "alpha",
      name: "renamed",
      namedWorkspacePath: "/alpha-renamed",
      createdAt: "2025-01-01T00:00:00.000Z",
    });

    const { workspace: workspaceApi } = createMockAPI({
      workspace: {
        list: () => Promise.resolve([oldWorkspace]),
        rename: () =>
          Promise.resolve({
            success: true as const,
            data: { newWorkspaceId: "ws-2" },
          }),
        getInfo: (workspaceId: string) => {
          if (workspaceId === "ws-2") {
            return Promise.resolve(newWorkspace);
          }
          return Promise.resolve(null);
        },
      },
      projects: {
        list: () => Promise.resolve([]),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));

    // Set the selected workspace via context API
    act(() => {
      ctx().setSelectedWorkspace({
        workspaceId: "ws-1",
        projectPath: "/alpha",
        projectName: "alpha",
        namedWorkspacePath: "/alpha-main",
      });
    });

    expect(ctx().selectedWorkspace?.workspaceId).toBe("ws-1");

    let result: Awaited<ReturnType<WorkspaceContext["renameWorkspace"]>>;
    await act(async () => {
      result = await ctx().renameWorkspace("ws-1", "renamed");
    });

    expect(workspaceApi.rename).toHaveBeenCalledWith("ws-1", "renamed");
    expect(result!.success).toBe(true);
    expect(workspaceApi.getInfo).toHaveBeenCalledWith("ws-2");
    // Verify selectedWorkspace was updated with new ID
    expect(ctx().selectedWorkspace).toEqual({
      workspaceId: "ws-2",
      projectPath: "/alpha",
      projectName: "alpha",
      namedWorkspacePath: "/alpha-renamed",
    });
  });

  test("renameWorkspace handles failure gracefully", async () => {
    const workspace: FrontendWorkspaceMetadata = createWorkspaceMetadata({
      id: "ws-1",
      projectPath: "/alpha",
      projectName: "alpha",
      name: "main",
      namedWorkspacePath: "/alpha-main",
      createdAt: "2025-01-01T00:00:00.000Z",
    });

    const { workspace: workspaceApi } = createMockAPI({
      workspace: {
        list: () => Promise.resolve([workspace]),
        rename: () => Promise.resolve({ success: false, error: "Name already exists" }),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));

    let result: Awaited<ReturnType<WorkspaceContext["renameWorkspace"]>>;
    await act(async () => {
      result = await ctx().renameWorkspace("ws-1", "renamed");
    });

    expect(workspaceApi.rename).toHaveBeenCalledWith("ws-1", "renamed");
    expect(result!.success).toBe(false);
    expect(result!.error).toBe("Name already exists");
  });

  test("getWorkspaceInfo fetches workspace metadata", async () => {
    const workspace: FrontendWorkspaceMetadata = createWorkspaceMetadata({
      id: "ws-1",
      projectPath: "/alpha",
      projectName: "alpha",
      name: "main",
      namedWorkspacePath: "/alpha-main",
      createdAt: "2025-01-01T00:00:00.000Z",
    });

    const { workspace: workspaceApi } = createMockAPI({
      workspace: {
        list: () => Promise.resolve([]),
        getInfo: (workspaceId: string) => {
          if (workspaceId === "ws-1") {
            return Promise.resolve(workspace);
          }
          return Promise.resolve(null);
        },
      },
      projects: {
        list: () => Promise.resolve([]),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));

    const info = await ctx().getWorkspaceInfo("ws-1");
    expect(workspaceApi.getInfo).toHaveBeenCalledWith("ws-1");
    expect(info).toEqual(workspace);
  });

  test("beginWorkspaceCreation clears selection and tracks pending state", async () => {
    createMockAPI({
      workspace: {
        list: () => Promise.resolve([]),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));

    expect(ctx().pendingNewWorkspaceProject).toBeNull();

    act(() => {
      ctx().setSelectedWorkspace({
        workspaceId: "ws-123",
        projectPath: "/alpha",
        projectName: "alpha",
        namedWorkspacePath: "alpha/ws-123",
      });
    });
    expect(ctx().selectedWorkspace?.workspaceId).toBe("ws-123");

    act(() => {
      ctx().beginWorkspaceCreation("/alpha");
    });
    expect(ctx().pendingNewWorkspaceProject).toBe("/alpha");
    expect(ctx().selectedWorkspace).toBeNull();

    act(() => {
      ctx().clearPendingWorkspaceCreation();
    });
    expect(ctx().pendingNewWorkspaceProject).toBeNull();
  });

  test("reacts to metadata update events (new workspace)", async () => {
    let metadataListener:
      | ((event: { workspaceId: string; metadata: FrontendWorkspaceMetadata | null }) => void)
      | null = null;

    const { projects: projectsApi } = createMockAPI({
      workspace: {
        list: () => Promise.resolve([]),
        // Preload.ts type is incorrect - it should allow metadata: null for deletions
        /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
        onMetadata: ((
          listener: (event: {
            workspaceId: string;
            metadata: FrontendWorkspaceMetadata | null;
          }) => void
        ) => {
          metadataListener = listener;
          return () => {
            metadataListener = null;
          };
        }) as any,
        /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
      },
      projects: {
        list: () => Promise.resolve([]),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));

    const newWorkspace: FrontendWorkspaceMetadata = createWorkspaceMetadata({
      id: "ws-new",
      projectPath: "/gamma",
      projectName: "gamma",
      name: "feature",
      namedWorkspacePath: "/gamma-feature",
      createdAt: "2025-01-03T00:00:00.000Z",
    });

    await act(async () => {
      metadataListener!({ workspaceId: "ws-new", metadata: newWorkspace });
      // Give async side effects time to run
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(ctx().workspaceMetadata.has("ws-new")).toBe(true);
    // Should reload projects when new workspace is created
    expect(projectsApi.list.mock.calls.length).toBeGreaterThan(1);
  });

  test("reacts to metadata update events (delete workspace)", async () => {
    const workspace: FrontendWorkspaceMetadata = createWorkspaceMetadata({
      id: "ws-1",
      projectPath: "/alpha",
      projectName: "alpha",
      name: "main",
      namedWorkspacePath: "/alpha-main",
      createdAt: "2025-01-01T00:00:00.000Z",
    });

    let metadataListener:
      | ((event: { workspaceId: string; metadata: FrontendWorkspaceMetadata | null }) => void)
      | null = null;

    createMockAPI({
      workspace: {
        list: () => Promise.resolve([workspace]),
        // Preload.ts type is incorrect - it should allow metadata: null for deletions
        /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
        onMetadata: ((
          listener: (event: {
            workspaceId: string;
            metadata: FrontendWorkspaceMetadata | null;
          }) => void
        ) => {
          metadataListener = listener;
          return () => {
            metadataListener = null;
          };
        }) as any,
        /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
      },
      projects: {
        list: () => Promise.resolve([]),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().workspaceMetadata.has("ws-1")).toBe(true));

    act(() => {
      metadataListener!({ workspaceId: "ws-1", metadata: null });
    });

    expect(ctx().workspaceMetadata.has("ws-1")).toBe(false);
  });

  test("selectedWorkspace persists to localStorage", async () => {
    createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([
            createWorkspaceMetadata({
              id: "ws-1",
              projectPath: "/alpha",
              projectName: "alpha",
              name: "main",
              namedWorkspacePath: "/alpha-main",
            }),
          ]),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));

    // Set selected workspace
    act(() => {
      ctx().setSelectedWorkspace({
        workspaceId: "ws-1",
        projectPath: "/alpha",
        projectName: "alpha",
        namedWorkspacePath: "/alpha-main",
      });
    });

    // Verify it's set and persisted to localStorage
    await waitFor(() => {
      expect(ctx().selectedWorkspace?.workspaceId).toBe("ws-1");
      const stored = globalThis.localStorage.getItem("selectedWorkspace");
      expect(stored).toBeTruthy();
      const parsed = JSON.parse(stored!) as { workspaceId?: string };
      expect(parsed.workspaceId).toBe("ws-1");
    });
  });

  test("selectedWorkspace restores from localStorage on mount", async () => {
    // Pre-populate localStorage
    const mockSelection = {
      workspaceId: "ws-1",
      projectPath: "/alpha",
      projectName: "alpha",
      namedWorkspacePath: "/alpha-main",
    };

    createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([
            createWorkspaceMetadata({
              id: "ws-1",
              projectPath: "/alpha",
              projectName: "alpha",
              name: "main",
              namedWorkspacePath: "/alpha-main",
            }),
          ]),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
      localStorage: {
        selectedWorkspace: JSON.stringify(mockSelection),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));

    // Should have restored from localStorage (happens after loading completes)
    await waitFor(() => {
      expect(ctx().selectedWorkspace?.workspaceId).toBe("ws-1");
    });
    expect(ctx().selectedWorkspace?.projectPath).toBe("/alpha");
  });

  test("URL hash overrides localStorage for selectedWorkspace", async () => {
    createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([
            createWorkspaceMetadata({
              id: "ws-1",
              projectPath: "/alpha",
              projectName: "alpha",
              name: "main",
              namedWorkspacePath: "/alpha-main",
            }),
            createWorkspaceMetadata({
              id: "ws-2",
              projectPath: "/beta",
              projectName: "beta",
              name: "dev",
              namedWorkspacePath: "/beta-dev",
            }),
          ]),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
      localStorage: {
        selectedWorkspace: JSON.stringify({
          workspaceId: "ws-1",
          projectPath: "/alpha",
          projectName: "alpha",
          namedWorkspacePath: "/alpha-main",
        }),
      },
      locationHash: "#workspace=ws-2",
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));

    // Should have selected ws-2 from URL hash, not ws-1 from localStorage
    await waitFor(() => {
      expect(ctx().selectedWorkspace?.workspaceId).toBe("ws-2");
    });
    expect(ctx().selectedWorkspace?.projectPath).toBe("/beta");
  });

  test("URL hash with non-existent workspace ID does not crash", async () => {
    createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([
            createWorkspaceMetadata({
              id: "ws-1",
              projectPath: "/alpha",
              projectName: "alpha",
              name: "main",
              namedWorkspacePath: "/alpha-main",
            }),
          ]),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
      locationHash: "#workspace=non-existent",
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));

    // Should not have selected anything (workspace doesn't exist)
    expect(ctx().selectedWorkspace).toBeNull();
  });

  test("launch project selects first workspace when no selection exists", async () => {
    createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([
            createWorkspaceMetadata({
              id: "ws-1",
              projectPath: "/launch-project",
              projectName: "launch-project",
              name: "main",
              namedWorkspacePath: "/launch-project-main",
            }),
            createWorkspaceMetadata({
              id: "ws-2",
              projectPath: "/launch-project",
              projectName: "launch-project",
              name: "dev",
              namedWorkspacePath: "/launch-project-dev",
            }),
          ]),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
      server: {
        getLaunchProject: () => Promise.resolve("/launch-project"),
      },
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
  await waitFor(() => expect(contextRef.current).toBeTruthy());
  return () => contextRef.current!;
}

interface MockAPIOptions {
  workspace?: Partial<IPCApi["workspace"]>;
  projects?: Partial<IPCApi["projects"]>;
  server?: {
    getLaunchProject?: () => Promise<string | null>;
  };
  localStorage?: Record<string, string>;
  locationHash?: string;
}

// Mock type helpers - only include methods used in tests
interface MockedWorkspaceAPI {
  create: ReturnType<typeof mock<IPCApi["workspace"]["create"]>>;
  list: ReturnType<typeof mock<IPCApi["workspace"]["list"]>>;
  remove: ReturnType<typeof mock<IPCApi["workspace"]["remove"]>>;
  rename: ReturnType<typeof mock<IPCApi["workspace"]["rename"]>>;
  getInfo: ReturnType<typeof mock<IPCApi["workspace"]["getInfo"]>>;
  onMetadata: ReturnType<typeof mock<IPCApi["workspace"]["onMetadata"]>>;
  onChat: ReturnType<typeof mock<IPCApi["workspace"]["onChat"]>>;
  activity: {
    list: ReturnType<typeof mock<IPCApi["workspace"]["activity"]["list"]>>;
    subscribe: ReturnType<typeof mock<IPCApi["workspace"]["activity"]["subscribe"]>>;
  };
}

// Just type the list method directly since Pick with conditional types causes issues
interface MockedProjectsAPI {
  list: ReturnType<typeof mock<() => Promise<Array<[string, ProjectConfig]>>>>;
}

function createMockAPI(options: MockAPIOptions = {}) {
  // Create fresh window environment with explicit typing
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

  // Create workspace API with proper types
  const defaultActivityList: IPCApi["workspace"]["activity"]["list"] = () =>
    Promise.resolve({} as Record<string, WorkspaceActivitySnapshot>);
  const defaultActivitySubscribe: IPCApi["workspace"]["activity"]["subscribe"] = () => () =>
    undefined;

  const workspaceActivity = options.workspace?.activity;
  const activityListImpl: IPCApi["workspace"]["activity"]["list"] =
    workspaceActivity?.list?.bind(workspaceActivity) ?? defaultActivityList;
  const activitySubscribeImpl: IPCApi["workspace"]["activity"]["subscribe"] =
    workspaceActivity?.subscribe?.bind(workspaceActivity) ?? defaultActivitySubscribe;

  const workspace: MockedWorkspaceAPI = {
    create: mock(
      options.workspace?.create ??
        (() =>
          Promise.resolve({
            success: true as const,
            metadata: createWorkspaceMetadata({ id: "ws-1" }),
          }))
    ),
    list: mock(options.workspace?.list ?? (() => Promise.resolve([]))),
    remove: mock(
      options.workspace?.remove ??
        (() => Promise.resolve({ success: true as const, data: undefined }))
    ),
    rename: mock(
      options.workspace?.rename ??
        (() =>
          Promise.resolve({
            success: true as const,
            data: { newWorkspaceId: "ws-1" },
          }))
    ),
    getInfo: mock(options.workspace?.getInfo ?? (() => Promise.resolve(null))),
    onMetadata: mock(
      options.workspace?.onMetadata ??
        (() => () => {
          // Empty cleanup function
        })
    ),
    onChat: mock(
      options.workspace?.onChat ??
        ((_workspaceId: string, _callback: Parameters<IPCApi["workspace"]["onChat"]>[1]) => () => {
          // Empty cleanup function
        })
    ),
    activity: {
      list: mock(activityListImpl),
      subscribe: mock(activitySubscribeImpl),
    },
  };

  // Create projects API with proper types
  const projects: MockedProjectsAPI = {
    list: mock(options.projects?.list ?? (() => Promise.resolve([]))),
  };

  // Set up window.api with proper typing
  // Tests only mock the methods they need, so cast to full API type
  const windowWithApi = happyWindow as unknown as Window & { api: IPCApi };
  (windowWithApi.api as unknown) = {
    workspace,
    projects,
  };

  // Set up server API if provided
  if (options.server) {
    (windowWithApi.api as { server?: { getLaunchProject: () => Promise<string | null> } }).server =
      {
        getLaunchProject: mock(options.server.getLaunchProject ?? (() => Promise.resolve(null))),
      };
  }

  return { workspace, projects, window: happyWindow };
}

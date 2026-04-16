import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import type { WorkspaceContext } from "./WorkspaceContext";
import { WorkspaceProvider, useWorkspaceContext } from "./WorkspaceContext";
import { ProjectProvider, useProjectContext } from "@/browser/contexts/ProjectContext";
import { RouterProvider } from "@/browser/contexts/RouterContext";
import { useWorkspaceStoreRaw as getWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import {
  LAST_VISITED_ROUTE_KEY,
  LAUNCH_BEHAVIOR_KEY,
  SELECTED_WORKSPACE_KEY,
  getAgentIdKey,
  getModelKey,
  getRightSidebarLayoutKey,
  getTerminalTitlesKey,
  getThinkingLevelKey,
} from "@/common/constants/storage";
import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import type { RecursivePartial } from "@/browser/testUtils";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { getProjectRouteId } from "@/common/utils/projectRouteId";
import type { RightSidebarLayoutState } from "@/browser/utils/rightSidebarLayout";

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

type NavigationType = "navigate" | "reload" | "back_forward" | "prerender";

describe("WorkspaceContext", () => {
  afterEach(() => {
    cleanup();
    mock.restore();

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

    // Activate the workspace so onChat subscription starts (required after the
    // refactor that scoped onChat to the active workspace only).
    act(() => {
      getWorkspaceStoreRaw().setActiveWorkspaceId("ws-sync-load");
    });

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

  test("switches selection to parent when selected child workspace is deleted", async () => {
    const parentId = "ws-parent";
    const childId = "ws-child";

    const workspaces: FrontendWorkspaceMetadata[] = [
      createWorkspaceMetadata({
        id: parentId,
        projectPath: "/alpha",
        projectName: "alpha",
        name: "main",
        namedWorkspacePath: "/alpha-main",
      }),
      createWorkspaceMetadata({
        id: childId,
        projectPath: "/alpha",
        projectName: "alpha",
        name: "agent_explore_ws-child",
        namedWorkspacePath: "/alpha-agent",
        parentWorkspaceId: parentId,
      }),
    ];

    let emitDelete:
      | ((event: { workspaceId: string; metadata: FrontendWorkspaceMetadata | null }) => void)
      | null = null;

    const { workspace: workspaceApi } = createMockAPI({
      workspace: {
        list: () => Promise.resolve(workspaces),
        onMetadata: () =>
          Promise.resolve(
            (async function* () {
              const event = await new Promise<{
                workspaceId: string;
                metadata: FrontendWorkspaceMetadata | null;
              }>((resolve) => {
                emitDelete = resolve;
              });
              yield event;
            })() as unknown as Awaited<ReturnType<APIClient["workspace"]["onMetadata"]>>
          ),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("last-workspace"),
      },
      locationPath: `/workspace/${childId}`,
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().workspaceMetadata.size).toBe(2));
    await waitFor(() => expect(ctx().selectedWorkspace?.workspaceId).toBe(childId));
    await waitFor(() => expect(workspaceApi.onMetadata).toHaveBeenCalled());
    await waitFor(() => expect(emitDelete).toBeTruthy());

    act(() => {
      emitDelete?.({ workspaceId: childId, metadata: null });
    });

    await waitFor(() => expect(ctx().selectedWorkspace?.workspaceId).toBe(parentId));
  });

  test("navigates to project page when selected workspace is archived", async () => {
    const workspaceId = "ws-archive";
    const projectPath = "/alpha";

    const workspaces: FrontendWorkspaceMetadata[] = [
      createWorkspaceMetadata({
        id: workspaceId,
        projectPath,
        projectName: "alpha",
        name: "main",
        namedWorkspacePath: "/alpha-main",
      }),
    ];

    let emitArchive:
      | ((event: { workspaceId: string; metadata: FrontendWorkspaceMetadata | null }) => void)
      | null = null;

    createMockAPI({
      workspace: {
        list: () => Promise.resolve(workspaces),
        onMetadata: () =>
          Promise.resolve(
            (async function* () {
              const event = await new Promise<{
                workspaceId: string;
                metadata: FrontendWorkspaceMetadata | null;
              }>((resolve) => {
                emitArchive = resolve;
              });
              yield event;
            })() as unknown as Awaited<ReturnType<APIClient["workspace"]["onMetadata"]>>
          ),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("last-workspace"),
      },
      locationPath: `/workspace/${workspaceId}`,
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().selectedWorkspace?.workspaceId).toBe(workspaceId));
    await waitFor(() => expect(emitArchive).toBeTruthy());

    act(() => {
      emitArchive?.({
        workspaceId,
        metadata: createWorkspaceMetadata({
          id: workspaceId,
          projectPath,
          projectName: "alpha",
          name: "main",
          namedWorkspacePath: "/alpha-main",
          archivedAt: "2025-02-01T00:00:00.000Z",
        }),
      });
    });

    await waitFor(() => expect(ctx().pendingNewWorkspaceProject).toBe(projectPath));
    expect(ctx().selectedWorkspace).toBeNull();
    await waitFor(() => expect(ctx().workspaceMetadata.has(workspaceId)).toBe(false));
    expect(localStorage.getItem(SELECTED_WORKSPACE_KEY)).toBeNull();
  });

  test("archiving does not override a rapid manual workspace switch", async () => {
    const archivedId = "ws-archive-old";
    const nextId = "ws-keep";

    const workspaces: FrontendWorkspaceMetadata[] = [
      createWorkspaceMetadata({
        id: archivedId,
        projectPath: "/alpha",
        projectName: "alpha",
        name: "main",
        namedWorkspacePath: "/alpha-main",
      }),
      createWorkspaceMetadata({
        id: nextId,
        projectPath: "/beta",
        projectName: "beta",
        name: "main",
        namedWorkspacePath: "/beta-main",
      }),
    ];

    let emitArchive:
      | ((event: { workspaceId: string; metadata: FrontendWorkspaceMetadata | null }) => void)
      | null = null;

    createMockAPI({
      workspace: {
        list: () => Promise.resolve(workspaces),
        onMetadata: () =>
          Promise.resolve(
            (async function* () {
              const event = await new Promise<{
                workspaceId: string;
                metadata: FrontendWorkspaceMetadata | null;
              }>((resolve) => {
                emitArchive = resolve;
              });
              yield event;
            })() as unknown as Awaited<ReturnType<APIClient["workspace"]["onMetadata"]>>
          ),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("last-workspace"),
      },
      locationPath: `/workspace/${archivedId}`,
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().selectedWorkspace?.workspaceId).toBe(archivedId));
    await waitFor(() => expect(emitArchive).toBeTruthy());

    const nextSelection = {
      workspaceId: nextId,
      projectPath: "/beta",
      projectName: "beta",
      namedWorkspacePath: "/beta-main",
    };

    // Simulate a fast user click to switch workspaces while the archive event is in flight.
    // The metadata handler must not navigate to the project page after this intent.
    act(() => {
      ctx().setSelectedWorkspace(nextSelection);
      emitArchive?.({
        workspaceId: archivedId,
        metadata: createWorkspaceMetadata({
          id: archivedId,
          projectPath: "/alpha",
          projectName: "alpha",
          name: "main",
          namedWorkspacePath: "/alpha-main",
          archivedAt: "2025-02-01T00:00:00.000Z",
        }),
      });
    });

    await waitFor(() => expect(ctx().selectedWorkspace?.workspaceId).toBe(nextId));
    expect(ctx().pendingNewWorkspaceProject).toBeNull();
    await waitFor(() => expect(ctx().workspaceMetadata.has(archivedId)).toBe(false));
    expect(localStorage.getItem(SELECTED_WORKSPACE_KEY)).toContain(nextId);
  });

  test("removes non-selected child workspace from metadata map when deleted", async () => {
    // Bug regression: when a sub-agent workspace is deleted while not selected,
    // it was staying in the metadata map due to early return in the handler.
    const parentId = "ws-parent";
    const childId = "ws-child";

    const workspaces: FrontendWorkspaceMetadata[] = [
      createWorkspaceMetadata({
        id: parentId,
        projectPath: "/alpha",
        projectName: "alpha",
        name: "main",
        namedWorkspacePath: "/alpha-main",
      }),
      createWorkspaceMetadata({
        id: childId,
        projectPath: "/alpha",
        projectName: "alpha",
        name: "agent_explore_ws-child",
        namedWorkspacePath: "/alpha-agent",
        parentWorkspaceId: parentId,
      }),
    ];

    let emitDelete:
      | ((event: { workspaceId: string; metadata: FrontendWorkspaceMetadata | null }) => void)
      | null = null;

    createMockAPI({
      workspace: {
        list: () => Promise.resolve(workspaces),
        onMetadata: () =>
          Promise.resolve(
            (async function* () {
              const event = await new Promise<{
                workspaceId: string;
                metadata: FrontendWorkspaceMetadata | null;
              }>((resolve) => {
                emitDelete = resolve;
              });
              yield event;
            })() as unknown as Awaited<ReturnType<APIClient["workspace"]["onMetadata"]>>
          ),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("last-workspace"),
      },
      // Parent is selected, not the child
      locationPath: `/workspace/${parentId}`,
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().workspaceMetadata.size).toBe(2));
    await waitFor(() => expect(ctx().selectedWorkspace?.workspaceId).toBe(parentId));
    await waitFor(() => expect(emitDelete).toBeTruthy());

    // Delete the non-selected child workspace
    act(() => {
      emitDelete?.({ workspaceId: childId, metadata: null });
    });

    // Child should be removed from metadata map (this was the bug - it stayed)
    await waitFor(() => expect(ctx().workspaceMetadata.size).toBe(1));
    expect(ctx().workspaceMetadata.has(childId)).toBe(false);
    // Parent should still be selected
    expect(ctx().selectedWorkspace?.workspaceId).toBe(parentId);
  });

  test("refreshes projects when metadata delete event is received", async () => {
    const workspaceId = "ws-delete-refresh";

    const workspaces: FrontendWorkspaceMetadata[] = [
      createWorkspaceMetadata({
        id: workspaceId,
        projectPath: "/alpha",
        projectName: "alpha",
        name: "main",
        namedWorkspacePath: "/alpha-main",
      }),
    ];

    let emitDelete:
      | ((event: { workspaceId: string; metadata: FrontendWorkspaceMetadata | null }) => void)
      | null = null;

    const { projects: projectsApi } = createMockAPI({
      workspace: {
        list: () => Promise.resolve(workspaces),
        onMetadata: () =>
          Promise.resolve(
            (async function* () {
              const event = await new Promise<{
                workspaceId: string;
                metadata: FrontendWorkspaceMetadata | null;
              }>((resolve) => {
                emitDelete = resolve;
              });
              yield event;
            })() as unknown as Awaited<ReturnType<APIClient["workspace"]["onMetadata"]>>
          ),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
    });

    await setup();

    await waitFor(() => expect(emitDelete).toBeTruthy());
    await waitFor(() => expect(projectsApi.list).toHaveBeenCalled());
    const callsBeforeDelete = projectsApi.list.mock.calls.length;

    act(() => {
      emitDelete?.({ workspaceId, metadata: null });
    });

    await waitFor(() => {
      expect(projectsApi.list.mock.calls.length).toBeGreaterThan(callsBeforeDelete);
    });
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
  test("stale metadata does not override a main workspace agent selection", async () => {
    const workspaceId = "ws-agent-main";
    let emitMetadata:
      | ((event: { workspaceId: string; metadata: FrontendWorkspaceMetadata | null }) => void)
      | null = null;

    createMockAPI({
      workspace: {
        list: () => Promise.resolve([createWorkspaceMetadata({ id: workspaceId })]),
        onMetadata: () =>
          Promise.resolve(
            (async function* () {
              const event = await new Promise<{
                workspaceId: string;
                metadata: FrontendWorkspaceMetadata | null;
              }>((resolve) => {
                emitMetadata = resolve;
              });
              yield event;
            })() as unknown as Awaited<ReturnType<APIClient["workspace"]["onMetadata"]>>
          ),
      },
      localStorage: {
        [getAgentIdKey(workspaceId)]: JSON.stringify("exec"),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().workspaceMetadata.size).toBe(1));
    await waitFor(() => expect(emitMetadata).toBeTruthy());
    expect(ctx().workspaceMetadata.get(workspaceId)?.agentId).toBeUndefined();

    act(() => {
      emitMetadata?.({
        workspaceId,
        metadata: createWorkspaceMetadata({ id: workspaceId, agentId: "plan" }),
      });
    });

    await waitFor(() => expect(ctx().workspaceMetadata.get(workspaceId)?.agentId).toBe("plan"));
    expect(readPersistedState<string | undefined>(getAgentIdKey(workspaceId), undefined)).toBe(
      "exec"
    );
  });

  test("child workspace metadata still seeds the locked backend agent", async () => {
    const workspaceId = "ws-agent-child";

    createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([
            createWorkspaceMetadata({
              id: workspaceId,
              parentWorkspaceId: "ws-parent",
              agentType: "plan",
            }),
          ]),
      },
      localStorage: {
        [getAgentIdKey(workspaceId)]: JSON.stringify("exec"),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().workspaceMetadata.size).toBe(1));

    expect(readPersistedState<string | undefined>(getAgentIdKey(workspaceId), undefined)).toBe(
      "plan"
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
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("last-workspace"),
      },
      locationPath: "/workspace/ws-remove",
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

  describe("archiveWorkspace", () => {
    test("succeeds even when persisted layout is invalid JSON shape", async () => {
      const workspaceId = "ws-archive-invalid-layout";
      const layoutKey = getRightSidebarLayoutKey(workspaceId);

      const { workspace: workspaceApi } = createMockAPI({
        localStorage: {
          [layoutKey]: JSON.stringify({ broken: true }),
        },
      });

      const ctx = await setup();

      let result: Awaited<ReturnType<WorkspaceContext["archiveWorkspace"]>> | undefined;
      await act(async () => {
        result = await ctx().archiveWorkspace(workspaceId);
      });

      expect(workspaceApi.archive).toHaveBeenCalledWith({ workspaceId });
      expect(result).toEqual({ success: true, data: { kind: "archived" } });
    });

    test("strips terminal tabs from valid persisted layout on successful archive", async () => {
      const workspaceId = "ws-archive-clean-layout";
      const layoutKey = getRightSidebarLayoutKey(workspaceId);
      const terminalTitlesKey = getTerminalTitlesKey(workspaceId);
      const persistedLayout: RightSidebarLayoutState = {
        version: 1,
        nextId: 2,
        focusedTabsetId: "tabset-1",
        root: {
          type: "tabset",
          id: "tabset-1",
          tabs: ["costs", "explorer", "terminal:t1"],
          activeTab: "terminal:t1",
        },
      };

      const { workspace: workspaceApi } = createMockAPI({
        localStorage: {
          [layoutKey]: JSON.stringify(persistedLayout),
          [terminalTitlesKey]: JSON.stringify({ t1: "stale-title" }),
        },
      });

      const ctx = await setup();

      await act(async () => {
        await ctx().archiveWorkspace(workspaceId);
      });

      expect(workspaceApi.archive).toHaveBeenCalledWith({ workspaceId });

      const cleanedLayout = readPersistedState<RightSidebarLayoutState | null>(layoutKey, null);
      expect(cleanedLayout).not.toBeNull();
      if (cleanedLayout?.root.type !== "tabset") {
        throw new Error("Expected cleaned right sidebar layout to be a tabset");
      }

      // "explorer" becomes active because removeTabEverywhere picks the adjacent
      // tab after the removed terminal tab.
      expect(cleanedLayout.root.tabs).toEqual(["costs", "explorer"]);
      expect(cleanedLayout.root.activeTab).toBe("explorer");
      expect(
        readPersistedState<Record<string, string>>(terminalTitlesKey, { stale: "title" })
      ).toEqual({});
    });

    test("preserves persisted terminal state when archive needs refreshed confirmation", async () => {
      const workspaceId = "ws-archive-confirm-refresh";
      const layoutKey = getRightSidebarLayoutKey(workspaceId);
      const terminalTitlesKey = getTerminalTitlesKey(workspaceId);
      const persistedLayout: RightSidebarLayoutState = {
        version: 1,
        nextId: 2,
        focusedTabsetId: "tabset-1",
        root: {
          type: "tabset",
          id: "tabset-1",
          tabs: ["costs", "terminal:t1"],
          activeTab: "terminal:t1",
        },
      };

      const { workspace: workspaceApi } = createMockAPI({
        localStorage: {
          [layoutKey]: JSON.stringify(persistedLayout),
          [terminalTitlesKey]: JSON.stringify({ t1: "still-open" }),
        },
        workspace: {
          archive: () =>
            Promise.resolve({
              success: true as const,
              data: {
                kind: "confirm-lossy-untracked-files" as const,
                paths: ["late-file.txt"],
              },
            }),
        },
      });

      const ctx = await setup();

      let result: Awaited<ReturnType<WorkspaceContext["archiveWorkspace"]>> | undefined;
      await act(async () => {
        result = await ctx().archiveWorkspace(workspaceId);
      });

      expect(workspaceApi.archive).toHaveBeenCalledWith({ workspaceId });
      expect(result).toEqual({
        success: true,
        data: { kind: "confirm-lossy-untracked-files", paths: ["late-file.txt"] },
      });
      expect(readPersistedState<RightSidebarLayoutState | null>(layoutKey, null)).toEqual(
        persistedLayout
      );
      expect(readPersistedState<Record<string, string>>(terminalTitlesKey, {})).toEqual({
        t1: "still-open",
      });
    });
  });

  test("treats legacy archive success without data as archived", async () => {
    const workspaceId = "ws-archive-legacy-success";
    const layoutKey = getRightSidebarLayoutKey(workspaceId);
    const terminalTitlesKey = getTerminalTitlesKey(workspaceId);
    const persistedLayout: RightSidebarLayoutState = {
      version: 1,
      nextId: 2,
      focusedTabsetId: "tabset-1",
      root: {
        type: "tabset",
        id: "tabset-1",
        tabs: ["costs", "terminal:t1"],
        activeTab: "terminal:t1",
      },
    };

    const legacyArchiveSuccess = { success: true as const } as unknown as Awaited<
      ReturnType<APIClient["workspace"]["archive"]>
    >;
    const { workspace: workspaceApi } = createMockAPI({
      localStorage: {
        [layoutKey]: JSON.stringify(persistedLayout),
        [terminalTitlesKey]: JSON.stringify({ t1: "stale-title" }),
      },
      workspace: {
        // Older fixtures omitted the typed archive payload entirely; keep covering that
        // downgrade-compatibility shape even though the current schema always includes data.
        archive: () => Promise.resolve(legacyArchiveSuccess),
      },
    });

    const ctx = await setup();

    let result: Awaited<ReturnType<WorkspaceContext["archiveWorkspace"]>> | undefined;
    await act(async () => {
      result = await ctx().archiveWorkspace(workspaceId);
    });

    expect(workspaceApi.archive).toHaveBeenCalledWith({ workspaceId });
    expect(result).toEqual({ success: true, data: { kind: "archived" } });
    const cleanedLayout = readPersistedState<RightSidebarLayoutState | null>(layoutKey, null);
    expect(cleanedLayout?.root.type).toBe("tabset");
    if (cleanedLayout?.root.type !== "tabset") {
      throw new Error("Expected cleaned right sidebar layout to be a tabset");
    }
    expect(cleanedLayout.root.tabs).not.toContain("terminal:t1");
    expect(
      readPersistedState<Record<string, string>>(terminalTitlesKey, { stale: "title" })
    ).toEqual({});
  });

  test("updateWorkspaceTitle updates workspace title via updateTitle API", async () => {
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

    await ctx().updateWorkspaceTitle("ws-title-edit", "New Title");

    expect(workspaceApi.updateTitle).toHaveBeenCalledWith({
      workspaceId: "ws-title-edit",
      title: "New Title",
    });
  });

  test("updateWorkspaceTitle handles failure gracefully", async () => {
    const { workspace: workspaceApi } = createMockAPI();

    const ctx = await setup();

    workspaceApi.updateTitle.mockResolvedValue({
      success: false,
      error: "Failed",
    });

    const result = await ctx().updateWorkspaceTitle("ws-1", "new");
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
          ]),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("last-workspace"),
      },
      locationPath: "/workspace/ws-existing",
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

  test("root startup opens the recent project page instead of restoring selectedWorkspace localStorage", async () => {
    createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([
            createWorkspaceMetadata({
              id: "ws-restore",
              projectPath: "/restore",
              projectName: "restore",
              name: "main",
              namedWorkspacePath: "/restore-main",
            }),
          ]),
      },
      projects: {
        list: () => Promise.resolve([["/restore", { workspaces: [] }]]),
      },
      // Seed localStorage — WorkspaceContext should resolve the compatibility root
      // route to the project page instead of reviving the removed landing page.
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

    await waitFor(() => expect(ctx().loading).toBe(false));
    await waitFor(() => {
      expect(ctx().pendingNewWorkspaceProject).toBe("/restore");
    });
    expect(ctx().selectedWorkspace).toBeNull();
  });

  test("browser reload restores the open workspace instead of reopening project creation", async () => {
    createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([
            createWorkspaceMetadata({
              id: "ws-open-chat",
              projectPath: "/existing",
              projectName: "existing",
              name: "main",
              namedWorkspacePath: "/existing-main",
            }),
          ]),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("dashboard"),
      },
      locationPath: "/workspace/ws-open-chat",
      navigationType: "reload",
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    await waitFor(() => {
      expect(ctx().selectedWorkspace?.workspaceId).toBe("ws-open-chat");
    });
    expect(ctx().pendingNewWorkspaceProject).toBeNull();
  });

  test("resolves system project route IDs for pending workspace creation", async () => {
    const systemProjectPath = "/system/internal-project";
    const systemProjectId = getProjectRouteId(systemProjectPath);

    createMockAPI({
      locationPath: `/project?project=${encodeURIComponent(systemProjectId)}`,
      projects: {
        list: () =>
          Promise.resolve([[systemProjectPath, { workspaces: [], projectKind: "system" }]]),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    expect(ctx().pendingNewWorkspaceProject).toBe(systemProjectPath);
  });

  test("browser: launch-project opens project creation on true first launch", async () => {
    createMockAPI({
      workspace: {
        list: () => Promise.resolve([]),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
      server: {
        getLaunchProject: () => Promise.resolve("/launch-project"),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("dashboard"),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    await waitFor(() => {
      expect(ctx().pendingNewWorkspaceProject).toBe("/launch-project");
    });
    expect(ctx().selectedWorkspace).toBeNull();
  });

  test("desktop: launch-project opens project creation on true first launch", async () => {
    createMockAPI({
      workspace: {
        list: () => Promise.resolve([]),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
      server: {
        getLaunchProject: () => Promise.resolve("/launch-project"),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("dashboard"),
      },
      desktopMode: true,
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    await waitFor(() => {
      expect(ctx().pendingNewWorkspaceProject).toBe("/launch-project");
    });
    expect(ctx().selectedWorkspace).toBeNull();
  });

  test("desktop: launch-project overrides a restored desktop route", async () => {
    createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([
            createWorkspaceMetadata({
              id: "ws-existing",
              projectPath: "/existing-project",
              projectName: "existing-project",
              name: "main",
              namedWorkspacePath: "/existing-project-main",
            }),
          ]),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
      server: {
        getLaunchProject: () => Promise.resolve("/launch-project"),
      },
      localStorage: {
        [LAST_VISITED_ROUTE_KEY]: JSON.stringify("/workspace/ws-existing"),
      },
      desktopMode: true,
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    await waitFor(() => {
      expect(ctx().pendingNewWorkspaceProject).toBe("/launch-project");
    });
    expect(ctx().selectedWorkspace).toBeNull();
  });

  test("launch-project ignores seeded system projects and workspaces on true first launch", async () => {
    createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([
            createWorkspaceMetadata({
              id: "system-workspace",
              projectPath: "/system/internal-project",
              projectName: "internal-project",
              name: "main",
              namedWorkspacePath: "/system/internal-project-main",
            }),
          ]),
      },
      projects: {
        list: () =>
          Promise.resolve([
            ["/system/internal-project", { workspaces: [], projectKind: "system" }],
          ]),
      },
      server: {
        getLaunchProject: () => Promise.resolve("/launch-project"),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("dashboard"),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    await waitFor(() => {
      expect(ctx().pendingNewWorkspaceProject).toBe("/launch-project");
    });
    expect(ctx().selectedWorkspace).toBeNull();
  });

  test("browser: new-chat mode defers to backend launch-project when provided", async () => {
    createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([
            createWorkspaceMetadata({
              id: "ws-existing",
              projectPath: "/existing-project",
              projectName: "existing-project",
              name: "main",
              namedWorkspacePath: "/existing-project-main",
            }),
          ]),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
      server: {
        getLaunchProject: () => Promise.resolve("/launch-project"),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("new-chat"),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    await waitFor(() => {
      expect(ctx().pendingNewWorkspaceProject).toBe("/launch-project");
    });
    expect(ctx().selectedWorkspace).toBeNull();
  });

  test("desktop: new-chat mode uses the recent workspace when backend has no launch-project", async () => {
    createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([
            createWorkspaceMetadata({
              id: "ws-existing",
              projectPath: "/existing-project",
              projectName: "existing-project",
              name: "main",
              namedWorkspacePath: "/existing-project-main",
            }),
          ]),
      },
      projects: {
        list: () => Promise.resolve([["/existing-project", { workspaces: [] }]]),
      },
      server: {
        getLaunchProject: () => Promise.resolve(null),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("new-chat"),
      },
      desktopMode: true,
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    await waitFor(() => {
      expect(ctx().pendingNewWorkspaceProject).toBe("/existing-project");
    });
    expect(ctx().selectedWorkspace).toBeNull();
  });

  test("desktop: new-chat mode fails closed when project metadata is unavailable", async () => {
    createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([
            createWorkspaceMetadata({
              id: "ws-existing",
              projectPath: "/existing-project",
              projectName: "existing-project",
              name: "main",
              namedWorkspacePath: "/existing-project-main",
            }),
          ]),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
      server: {
        getLaunchProject: () => Promise.resolve(null),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("new-chat"),
      },
      desktopMode: true,
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    await waitFor(() => {
      expect(ctx().pendingNewWorkspaceProject).toBeNull();
    });
    expect(ctx().selectedWorkspace).toBeNull();
  });

  test("desktop: new-chat mode retries startup fallback after project metadata loads", async () => {
    const { projects: projectsApi } = createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([
            createWorkspaceMetadata({
              id: "ws-existing",
              projectPath: "/existing-project",
              projectName: "existing-project",
              name: "main",
              namedWorkspacePath: "/existing-project-main",
            }),
          ]),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
      server: {
        getLaunchProject: () => Promise.resolve(null),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("new-chat"),
      },
      desktopMode: true,
    });

    const contexts = await setupWithProjectContext();

    await waitFor(() => expect(contexts.workspace().loading).toBe(false));
    expect(contexts.workspace().pendingNewWorkspaceProject).toBeNull();

    projectsApi.list.mockImplementation(() =>
      Promise.resolve([["/existing-project", { workspaces: [] }]])
    );
    await act(async () => {
      await contexts.project().refreshProjects();
    });

    await waitFor(() => {
      expect(contexts.workspace().pendingNewWorkspaceProject).toBe("/existing-project");
    });
    expect(contexts.workspace().selectedWorkspace).toBeNull();
  });

  test("desktop: new-chat mode skips legacy system workspaces when choosing a recent project", async () => {
    createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([
            createWorkspaceMetadata({
              id: "ws-system",
              projectPath: "/system/internal-project",
              projectName: "internal-project",
              name: "main",
              namedWorkspacePath: "/system/internal-project-main",
            }),
            createWorkspaceMetadata({
              id: "ws-user",
              projectPath: "/existing-project",
              projectName: "existing-project",
              name: "main",
              namedWorkspacePath: "/existing-project-main",
            }),
          ]),
      },
      projects: {
        list: () =>
          Promise.resolve([
            ["/system/internal-project", { workspaces: [], projectKind: "system" }],
            ["/existing-project", { workspaces: [] }],
          ]),
      },
      server: {
        getLaunchProject: () => Promise.resolve(null),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("new-chat"),
      },
      desktopMode: true,
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    await waitFor(() => {
      expect(ctx().pendingNewWorkspaceProject).toBe("/existing-project");
    });
    expect(ctx().selectedWorkspace).toBeNull();
  });

  test("desktop: new-chat mode keeps visible multi-project workspaces eligible as recents", async () => {
    createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([
            createWorkspaceMetadata({
              id: "ws-multi",
              projectPath: MULTI_PROJECT_CONFIG_KEY,
              projectName: "_multi",
              name: "main",
              namedWorkspacePath: "/tmp/multi-container/main",
            }),
          ]),
      },
      projects: {
        list: () =>
          Promise.resolve([[MULTI_PROJECT_CONFIG_KEY, { workspaces: [], projectKind: "system" }]]),
      },
      server: {
        getLaunchProject: () => Promise.resolve(null),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("new-chat"),
      },
      desktopMode: true,
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    await waitFor(() => {
      expect(ctx().pendingNewWorkspaceProject).toBe(MULTI_PROJECT_CONFIG_KEY);
    });
    expect(ctx().selectedWorkspace).toBeNull();
  });

  test("browser: launch project does not override existing selection", async () => {
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
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("last-workspace"),
      },
      locationPath: "/workspace/ws-existing",
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

  test("launch project does not override pending workspace creation", async () => {
    // Race condition test: if user starts creating a workspace while
    // getLaunchProject is in flight, the launch project should not override

    let resolveLaunchProject: (value: string | null) => void;
    const launchProjectPromise = new Promise<string | null>((resolve) => {
      resolveLaunchProject = resolve;
    });

    const initialWorkspaces = [
      createWorkspaceMetadata({
        id: "ws-launch",
        projectPath: "/launch-project",
        projectName: "launch-project",
        name: "main",
        namedWorkspacePath: "/launch-project-main",
      }),
    ];

    createMockAPI({
      workspace: {
        list: () => Promise.resolve(initialWorkspaces),
      },
      server: {
        getLaunchProject: () => launchProjectPromise,
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));

    // User starts workspace creation (this sets pendingNewWorkspaceProject)
    act(() => {
      ctx().beginWorkspaceCreation("/new-project");
    });

    // Verify pending state is set
    expect(ctx().pendingNewWorkspaceProject).toBe("/new-project");
    expect(ctx().selectedWorkspace).toBeNull();

    // Now the launch project response arrives
    await act(async () => {
      resolveLaunchProject!("/launch-project");
      // Give effect time to process
      await new Promise((r) => setTimeout(r, 50));
    });

    // Should NOT have selected the launch project workspace because creation is pending
    expect(ctx().selectedWorkspace).toBeNull();
    expect(ctx().pendingNewWorkspaceProject).toBe("/new-project");
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
  test("unscoped new_chat deep link does nothing when no user projects exist", async () => {
    const systemPath = "/system/internal-project";
    createMockAPI({
      projects: {
        list: () => Promise.resolve([[systemPath, { workspaces: [], projectKind: "system" }]]),
      },
      pendingDeepLinks: [{ type: "new_chat" }],
    });

    const ctx = await setup();

    await waitFor(() => {
      const state = ctx();
      expect(state.pendingNewWorkspaceProject).toBeNull();
    });
  });
});

async function setup() {
  const contextRef = { current: null as WorkspaceContext | null };
  function ContextCapture() {
    contextRef.current = useWorkspaceContext();
    return null;
  }

  // WorkspaceProvider needs RouterProvider and ProjectProvider
  render(
    <RouterProvider>
      <ProjectProvider>
        <WorkspaceProvider>
          <ContextCapture />
        </WorkspaceProvider>
      </ProjectProvider>
    </RouterProvider>
  );

  // Inject client immediately to handle race conditions where effects run before store update
  getWorkspaceStoreRaw().setClient(currentClientMock as APIClient);

  await waitFor(() => expect(contextRef.current).toBeTruthy());
  return () => contextRef.current!;
}

async function setupWithProjectContext() {
  const workspaceRef = { current: null as WorkspaceContext | null };
  const projectRef = { current: null as ReturnType<typeof useProjectContext> | null };

  function ContextCapture() {
    workspaceRef.current = useWorkspaceContext();
    projectRef.current = useProjectContext();
    return null;
  }

  render(
    <RouterProvider>
      <ProjectProvider>
        <WorkspaceProvider>
          <ContextCapture />
        </WorkspaceProvider>
      </ProjectProvider>
    </RouterProvider>
  );

  getWorkspaceStoreRaw().setClient(currentClientMock as APIClient);

  await waitFor(() => expect(workspaceRef.current).toBeTruthy());
  await waitFor(() => expect(projectRef.current).toBeTruthy());

  return {
    workspace: () => workspaceRef.current!,
    project: () => projectRef.current!,
  };
}

interface MockAPIOptions {
  workspace?: RecursivePartial<APIClient["workspace"]>;
  projects?: RecursivePartial<APIClient["projects"]>;
  server?: RecursivePartial<APIClient["server"]>;
  localStorage?: Record<string, string>;
  locationHash?: string;
  locationPath?: string;
  desktopMode?: boolean;
  navigationType?: NavigationType;
  pendingDeepLinks?: Array<{ type: string; [key: string]: unknown }>;
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

  if (options.desktopMode) {
    // Desktop/Electron uses file: protocol
    happyWindow.location.href = options.locationPath
      ? `file:///index.html#${options.locationPath}`
      : "file:///index.html";
  } else if (options.locationPath) {
    happyWindow.location.href = `http://localhost${options.locationPath}`;
  }

  // Set up location hash if provided
  if (options.locationHash) {
    happyWindow.location.hash = options.locationHash;
  }

  const navigationEntries = [
    { type: options.navigationType ?? "navigate" } as unknown as PerformanceNavigationTiming,
  ];
  Object.defineProperty(happyWindow.performance, "getEntriesByType", {
    configurable: true,
    value: (entryType: string) =>
      entryType === "navigation" ? (navigationEntries as unknown as PerformanceEntryList) : [],
  });

  // Set up deep link API on the window object for pending deep-link tests
  (happyWindow as unknown as { api?: Record<string, unknown> }).api = {
    ...(happyWindow as unknown as { api?: Record<string, unknown> }).api,
    consumePendingDeepLinks: mock(() => options.pendingDeepLinks ?? []),
    onDeepLink: mock(() => () => undefined),
    platform: "darwin",
  };

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
    archive: mock(
      options.workspace?.archive ??
        (() => Promise.resolve({ success: true as const, data: { kind: "archived" as const } }))
    ),
    unarchive: mock(
      options.workspace?.unarchive ??
        (() => Promise.resolve({ success: true as const, data: undefined }))
    ),
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

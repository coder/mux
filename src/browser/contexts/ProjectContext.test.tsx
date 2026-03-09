import type { ProjectConfig } from "@/node/config";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import type { ProjectContext } from "./ProjectContext";
import { ProjectProvider, useProjectContext } from "./ProjectContext";
import type { RecursivePartial } from "@/browser/testUtils";

import { getProjectRouteId } from "@/common/utils/projectRouteId";
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

describe("ProjectContext", () => {
  afterEach(() => {
    cleanup();

    // Resetting global state in tests
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    // Resetting global state in tests
    globalThis.document = undefined as unknown as Document;

    currentClientMock = {};
  });

  test("loads projects on mount and supports add/remove mutations", async () => {
    const initialProjects: Array<[string, ProjectConfig]> = [
      ["/alpha", { workspaces: [] }],
      ["/beta", { workspaces: [] }],
    ];

    const projectsApi = createMockAPI({
      list: () => Promise.resolve(initialProjects),
      remove: () => Promise.resolve({ success: true as const, data: undefined }),
      listBranches: () => Promise.resolve({ branches: ["main"], recommendedTrunk: "main" }),
      secrets: {
        get: () => Promise.resolve([{ key: "A", value: "1" }]),
        update: () => Promise.resolve({ success: true as const, data: undefined }),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().userProjects.size).toBe(2));
    expect(projectsApi.list).toHaveBeenCalled();

    await act(async () => {
      await ctx().refreshProjects();
    });
    expect(projectsApi.list.mock.calls.length).toBeGreaterThanOrEqual(2);

    act(() => {
      ctx().addProject("/gamma", { workspaces: [] });
    });
    expect(ctx().userProjects.has("/gamma")).toBe(true);

    await act(async () => {
      await ctx().removeProject("/alpha");
    });
    expect(projectsApi.remove).toHaveBeenCalledWith({ projectPath: "/alpha" });
    expect(ctx().userProjects.has("/alpha")).toBe(false);
  });

  test("exposes intent-based project resolvers for user/system project lookups", async () => {
    const systemProjectPath = "/path/to/system-project";
    createMockAPI({
      list: () =>
        Promise.resolve([
          ["/path/to/user-project", { workspaces: [] }],
          [systemProjectPath, { workspaces: [], projectKind: "system" }],
        ]),
      remove: () => Promise.resolve({ success: true as const, data: undefined }),
      listBranches: () => Promise.resolve({ branches: ["main"], recommendedTrunk: "main" }),
      secrets: {
        get: () => Promise.resolve([]),
        update: () => Promise.resolve({ success: true as const, data: undefined }),
      },
    });

    const ctx = await setup();

    await waitFor(() => {
      expect(ctx().userProjects.size).toBe(1);
      expect(ctx().systemProjectPath).toBe(systemProjectPath);
    });

    expect(ctx().userProjects.has("/path/to/user-project")).toBe(true);
    expect(ctx().userProjects.has(systemProjectPath)).toBe(false);
    expect(ctx().getProjectConfig(systemProjectPath)?.projectKind).toBe("system");
    expect(ctx().resolveProjectPath({ type: "path", value: `${systemProjectPath}/` })).toBe(
      systemProjectPath
    );
    expect(
      ctx().resolveProjectPath({ type: "routeId", value: getProjectRouteId(systemProjectPath) })
    ).toBe(systemProjectPath);
    expect(ctx().resolveProjectPath({ type: "fuzzy", value: "system-project" })).toBe(
      systemProjectPath
    );
  });

  test("tracks modal and pending workspace creation state", async () => {
    createMockAPI({
      list: () => Promise.resolve([]),
      remove: () => Promise.resolve({ success: true as const, data: undefined }),
      listBranches: () => Promise.resolve({ branches: ["main"], recommendedTrunk: "main" }),
      secrets: {
        get: () => Promise.resolve([]),
        update: () => Promise.resolve({ success: true as const, data: undefined }),
      },
    });

    const ctx = await setup();

    act(() => {
      ctx().openProjectCreateModal();
    });
    await waitFor(() => {
      expect(ctx().isProjectCreateModalOpen).toBe(true);
    });

    act(() => {
      ctx().closeProjectCreateModal();
    });
    await waitFor(() => {
      expect(ctx().isProjectCreateModalOpen).toBe(false);
    });
  });

  test("opens workspace modal and loads branches", async () => {
    createMockAPI({
      list: () => Promise.resolve([]),
      remove: () => Promise.resolve({ success: true as const, data: undefined }),
      listBranches: () => Promise.resolve({ branches: ["main", "feat"], recommendedTrunk: "main" }),
      secrets: {
        get: () => Promise.resolve([]),
        update: () => Promise.resolve({ success: true as const, data: undefined }),
      },
    });

    const ctx = await setup();

    await act(async () => {
      await ctx().openWorkspaceModal("/my-project", { projectName: "MyProject" });
    });

    const state = ctx().workspaceModalState;
    expect(state.isOpen).toBe(true);
    expect(state.projectPath).toBe("/my-project");
    expect(state.projectName).toBe("MyProject");
    expect(state.branches).toEqual(["main", "feat"]);
    expect(state.defaultTrunkBranch).toBe("main");
    expect(state.isLoading).toBe(false);
    expect(state.loadErrorMessage).toBeNull();

    act(() => {
      ctx().closeWorkspaceModal();
    });
    expect(ctx().workspaceModalState.isOpen).toBe(false);
  });

  test("surfaces branch loading errors inside workspace modal", async () => {
    createMockAPI({
      list: () => Promise.resolve([]),
      remove: () => Promise.resolve({ success: true as const, data: undefined }),
      listBranches: () => Promise.reject(new Error("boom")),
      secrets: {
        get: () => Promise.resolve([]),
        update: () => Promise.resolve({ success: true as const, data: undefined }),
      },
    });

    const ctx = await setup();

    await act(async () => {
      await ctx().openWorkspaceModal("/broken");
    });

    const state = ctx().workspaceModalState;
    expect(state.projectPath).toBe("/broken");
    expect(state.projectName).toBe("broken");
    expect(state.branches).toEqual([]);
    expect(state.loadErrorMessage).toContain("boom");
    expect(state.isLoading).toBe(false);
  });

  test("exposes secrets helpers", async () => {
    const projectsApi = createMockAPI({
      list: () => Promise.resolve([]),
      remove: () => Promise.resolve({ success: true as const, data: undefined }),
      listBranches: () => Promise.resolve({ branches: ["main"], recommendedTrunk: "main" }),
      secrets: {
        get: () => Promise.resolve([{ key: "A", value: "1" }]),
        update: () => Promise.resolve({ success: true as const, data: undefined }),
      },
    });

    const ctx = await setup();

    const secrets = await ctx().getSecrets("/alpha");
    expect(projectsApi.secrets.get).toHaveBeenCalledWith({ projectPath: "/alpha" });
    expect(secrets).toEqual([{ key: "A", value: "1" }]);

    await ctx().updateSecrets("/alpha", [{ key: "B", value: "2" }]);
    expect(projectsApi.secrets.update).toHaveBeenCalledWith({
      projectPath: "/alpha",
      secrets: [{ key: "B", value: "2" }],
    });
  });

  test("updateSecrets handles failure gracefully", async () => {
    const projectsApi = createMockAPI({
      list: () => Promise.resolve([]),
      remove: () => Promise.resolve({ success: true as const, data: undefined }),
      listBranches: () => Promise.resolve({ branches: ["main"], recommendedTrunk: "main" }),
      secrets: {
        get: () => Promise.resolve([]),
        update: () => Promise.resolve({ success: false, error: "something went wrong" }),
      },
    });

    const ctx = await setup();

    // Should not throw even when update fails
    expect(ctx().updateSecrets("/alpha", [{ key: "C", value: "3" }])).resolves.toBeUndefined();
    expect(projectsApi.secrets.update).toHaveBeenCalledWith({
      projectPath: "/alpha",
      secrets: [{ key: "C", value: "3" }],
    });
  });

  test("refreshProjects sets empty map on API error", async () => {
    createMockAPI({
      list: () => Promise.reject(new Error("network failure")),
      remove: () => Promise.resolve({ success: true as const, data: undefined }),
      listBranches: () => Promise.resolve({ branches: ["main"], recommendedTrunk: "main" }),
      secrets: {
        get: () => Promise.resolve([]),
        update: () => Promise.resolve({ success: true as const, data: undefined }),
      },
    });

    const ctx = await setup();

    // Should have empty projects after failed load
    await waitFor(() => {
      expect(ctx().userProjects.size).toBe(0);
    });
  });

  test("refreshProjects ignores stale responses (race condition)", async () => {
    let staleResolver: ((value: Array<[string, ProjectConfig]>) => void) | null = null;
    const stalePromise = new Promise<Array<[string, ProjectConfig]>>((resolve) => {
      staleResolver = resolve;
    });

    let latestResolver: ((value: Array<[string, ProjectConfig]>) => void) | null = null;
    const latestPromise = new Promise<Array<[string, ProjectConfig]>>((resolve) => {
      latestResolver = resolve;
    });

    let listCallCount = 0;
    createMockAPI({
      list: () => {
        listCallCount += 1;

        // Mount refresh (stale)
        if (listCallCount === 1) {
          return stalePromise;
        }

        // Manual refresh (latest)
        if (listCallCount === 2) {
          return latestPromise;
        }

        return Promise.resolve([]);
      },
      remove: () => Promise.resolve({ success: true as const, data: undefined }),
      listBranches: () => Promise.resolve({ branches: ["main"], recommendedTrunk: "main" }),
      secrets: {
        get: () => Promise.resolve([]),
        update: () => Promise.resolve({ success: true as const, data: undefined }),
      },
    });

    const ctx = await setup();

    // Resolve the manual refresh first.
    await act(async () => {
      const refreshPromise = ctx().refreshProjects();
      latestResolver!([["/new", { workspaces: [] }]]);
      await refreshPromise;
    });

    await waitFor(() => {
      expect(ctx().userProjects.has("/new")).toBe(true);
    });

    // Now resolve the stale mount refresh; it should be ignored.
    act(() => {
      staleResolver!([["/stale", { workspaces: [] }]]);
    });

    await waitFor(() => {
      expect(ctx().userProjects.has("/new")).toBe(true);
    });
    expect(ctx().userProjects.has("/stale")).toBe(false);
  });

  test("refreshProjects applies older success if a newer overlapping refresh fails", async () => {
    let olderResolver: ((value: Array<[string, ProjectConfig]>) => void) | null = null;
    const olderPromise = new Promise<Array<[string, ProjectConfig]>>((resolve) => {
      olderResolver = resolve;
    });

    let newerRejecter: ((error: unknown) => void) | null = null;
    const newerPromise = new Promise<Array<[string, ProjectConfig]>>((_, reject) => {
      newerRejecter = reject;
    });

    let listCallCount = 0;
    createMockAPI({
      list: () => {
        listCallCount += 1;

        // Mount refresh (older)
        if (listCallCount === 1) {
          return olderPromise;
        }

        // Manual refresh (newer, but fails)
        if (listCallCount === 2) {
          return newerPromise;
        }

        return Promise.resolve([]);
      },
      remove: () => Promise.resolve({ success: true as const, data: undefined }),
      listBranches: () => Promise.resolve({ branches: ["main"], recommendedTrunk: "main" }),
      secrets: {
        get: () => Promise.resolve([]),
        update: () => Promise.resolve({ success: true as const, data: undefined }),
      },
    });

    const ctx = await setup();

    // Trigger a newer refresh, but reject it while the mount refresh is still in-flight.
    await act(async () => {
      const refreshPromise = ctx().refreshProjects();
      newerRejecter!(new Error("boom"));
      await refreshPromise;
    });

    // Now resolve the mount refresh; it should populate the list.
    act(() => {
      olderResolver!([["/older", { workspaces: [] }]]);
    });

    await waitFor(() => {
      expect(ctx().userProjects.has("/older")).toBe(true);
    });
  });

  test("getBranchesForProject sanitizes malformed branch data", async () => {
    createMockAPI({
      list: () => Promise.resolve([]),
      remove: () => Promise.resolve({ success: true as const, data: undefined }),
      listBranches: () =>
        Promise.resolve({
          branches: ["main", 123, null, "dev", undefined, { name: "feat" }] as unknown as string[],
          recommendedTrunk: "main",
        }),
      secrets: {
        get: () => Promise.resolve([]),
        update: () => Promise.resolve({ success: true as const, data: undefined }),
      },
    });

    const ctx = await setup();

    const result = await ctx().getBranchesForProject("/project");
    // Should filter out non-string values
    expect(result.branches).toEqual(["main", "dev"]);
    expect(result.recommendedTrunk).toBe("main");
  });

  test("getBranchesForProject handles non-array branches", async () => {
    createMockAPI({
      list: () => Promise.resolve([]),
      remove: () => Promise.resolve({ success: true as const, data: undefined }),
      listBranches: () =>
        Promise.resolve({
          branches: null as unknown as string[],
          recommendedTrunk: "main",
        }),
      secrets: {
        get: () => Promise.resolve([]),
        update: () => Promise.resolve({ success: true as const, data: undefined }),
      },
    });

    const ctx = await setup();

    const result = await ctx().getBranchesForProject("/project");
    expect(result.branches).toEqual([]);
    expect(result.recommendedTrunk).toBe("");
  });

  test("getBranchesForProject falls back when recommendedTrunk not in branches", async () => {
    createMockAPI({
      list: () => Promise.resolve([]),
      remove: () => Promise.resolve({ success: true as const, data: undefined }),
      listBranches: () =>
        Promise.resolve({
          branches: ["main", "dev"],
          recommendedTrunk: "nonexistent",
        }),
      secrets: {
        get: () => Promise.resolve([]),
        update: () => Promise.resolve({ success: true as const, data: undefined }),
      },
    });

    const ctx = await setup();

    const result = await ctx().getBranchesForProject("/project");
    expect(result.branches).toEqual(["main", "dev"]);
    // Should fall back to first branch
    expect(result.recommendedTrunk).toBe("main");
  });

  test("openWorkspaceModal cancels stale requests (race condition)", async () => {
    let projectAResolver:
      | ((value: { branches: string[]; recommendedTrunk: string }) => void)
      | null = null;
    const projectAPromise = new Promise<{ branches: string[]; recommendedTrunk: string }>(
      (resolve) => {
        projectAResolver = resolve;
      }
    );

    createMockAPI({
      list: () => Promise.resolve([]),
      remove: () => Promise.resolve({ success: true as const, data: undefined }),
      listBranches: ({ projectPath }: { projectPath: string }) => {
        if (projectPath === "/project-a") {
          return projectAPromise;
        }
        return Promise.resolve({ branches: ["main-b"], recommendedTrunk: "main-b" });
      },
      secrets: {
        get: () => Promise.resolve([]),
        update: () => Promise.resolve({ success: true as const, data: undefined }),
      },
    });

    const ctx = await setup();

    await act(async () => {
      // Open modal for project A (won't resolve yet)
      const openA = ctx().openWorkspaceModal("/project-a");

      // Immediately open modal for project B (resolves quickly)
      await ctx().openWorkspaceModal("/project-b");

      // Now resolve project A
      projectAResolver!({ branches: ["main-a"], recommendedTrunk: "main-a" });
      await openA;
    });

    // Modal should show project B data, not project A
    const state = ctx().workspaceModalState;
    expect(state.projectPath).toBe("/project-b");
    expect(state.branches).toEqual(["main-b"]);
    expect(state.defaultTrunkBranch).toBe("main-b");
  });
  test("resolveNewChatProjectPath prefers user project when both exist", async () => {
    createMockAPI({
      list: () =>
        Promise.resolve([
          ["/user-proj", { workspaces: [] }],
          ["/system-proj", { workspaces: [], projectKind: "system" }],
        ]),
    });

    const ctx = await setup();
    await waitFor(() => expect(ctx().userProjects.size).toBe(1));

    // Unscoped selector should prefer user project
    const result = ctx().resolveNewChatProjectPath({});
    expect(result).toBe("/user-proj");
  });

  test("resolveNewChatProjectPath falls back to system project when no user projects", async () => {
    createMockAPI({
      list: () => Promise.resolve([["/system-only", { workspaces: [], projectKind: "system" }]]),
    });

    const ctx = await setup();
    await waitFor(() => expect(ctx().hasAnyProject).toBe(true));

    const result = ctx().resolveNewChatProjectPath({});
    expect(result).toBe("/system-only");
  });

  test("resolveNewChatProjectPath returns null when no projects exist", async () => {
    createMockAPI({
      list: () => Promise.resolve([]),
    });

    const ctx = await setup();
    // Wait for loading to complete
    await waitFor(() => expect(ctx().loading).toBe(false));

    const result = ctx().resolveNewChatProjectPath({});
    expect(result).toBeNull();
  });
  test("resolveNewChatProjectPath treats blank project selector as absent and falls back to projectPath fuzzy match", async () => {
    createMockAPI({
      list: () =>
        Promise.resolve([
          ["/Users/me/repos/default-first", { workspaces: [] }],
          ["/Users/me/repos/mux", { workspaces: [] }],
        ]),
    });

    const ctx = await setup();
    await waitFor(() => expect(ctx().userProjects.size).toBe(2));

    // Blank project should be treated as absent, falling back to projectPath fuzzy match
    const result = ctx().resolveNewChatProjectPath({
      project: "   ",
      projectPath: "/tmp/other-machine/mux",
    });

    expect(result).toBe("/Users/me/repos/mux");
  });
});

async function setup() {
  const contextRef = { current: null as ProjectContext | null };
  function ContextCapture() {
    contextRef.current = useProjectContext();
    return null;
  }
  render(
    <ProjectProvider>
      <ContextCapture />
    </ProjectProvider>
  );
  await waitFor(() => expect(contextRef.current).toBeTruthy());
  return () => contextRef.current!;
}

function createMockAPI(overrides: RecursivePartial<APIClient["projects"]>) {
  const projects = {
    create: mock(
      overrides.create ??
        (() =>
          Promise.resolve({
            success: true as const,
            data: { projectConfig: { workspaces: [] }, normalizedPath: "" },
          }))
    ),
    list: mock(overrides.list ?? (() => Promise.resolve([]))),
    listBranches: mock(
      overrides.listBranches ?? (() => Promise.resolve({ branches: [], recommendedTrunk: "main" }))
    ),
    remove: mock(
      overrides.remove ??
        (() =>
          Promise.resolve({
            success: true as const,
            data: undefined,
          }))
    ),
    pickDirectory: mock(overrides.pickDirectory ?? (() => Promise.resolve(null))),
    secrets: {
      get: mock(overrides.secrets?.get ?? (() => Promise.resolve([]))),
      update: mock(
        overrides.secrets?.update ??
          (() =>
            Promise.resolve({
              success: true as const,
              data: undefined,
            }))
      ),
    },
  };

  // Update the global mock
  currentClientMock = {
    projects: projects as unknown as RecursivePartial<APIClient["projects"]>,
    secrets: projects.secrets as unknown as RecursivePartial<APIClient["secrets"]>,
  };

  // Setting up global state for tests
  globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
  // Setting up global state for tests
  globalThis.document = globalThis.window.document;

  return projects;
}

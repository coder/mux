import type { ProjectConfig } from "@/node/config";
import type { IPCApi } from "@/common/types/ipc";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import type { ProjectContext } from "./ProjectContext";
import { ProjectProvider, useProjectContext } from "./ProjectContext";

describe("ProjectContext", () => {
  afterEach(() => {
    cleanup();

    // @ts-expect-error - Resetting global state in tests
    globalThis.window = undefined;
    // @ts-expect-error - Resetting global state in tests
    globalThis.document = undefined;
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

    await waitFor(() => expect(ctx().projects.size).toBe(2));
    expect(projectsApi.list).toHaveBeenCalled();

    await act(async () => {
      await ctx().refreshProjects();
    });
    expect(projectsApi.list.mock.calls.length).toBeGreaterThanOrEqual(2);

    act(() => {
      ctx().addProject("/gamma", { workspaces: [] });
    });
    expect(ctx().projects.has("/gamma")).toBe(true);

    await act(async () => {
      await ctx().removeProject("/alpha");
    });
    expect(projectsApi.remove).toHaveBeenCalledWith("/alpha");
    expect(ctx().projects.has("/alpha")).toBe(false);
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

    act(() => {
      ctx().beginWorkspaceCreation("/alpha");
    });
    expect(ctx().pendingNewWorkspaceProject).toBe("/alpha");

    act(() => {
      ctx().clearPendingWorkspaceCreation();
    });
    expect(ctx().pendingNewWorkspaceProject).toBeNull();
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
    expect(projectsApi.secrets.get).toHaveBeenCalledWith("/alpha");
    expect(secrets).toEqual([{ key: "A", value: "1" }]);

    await ctx().updateSecrets("/alpha", [{ key: "B", value: "2" }]);
    expect(projectsApi.secrets.update).toHaveBeenCalledWith("/alpha", [{ key: "B", value: "2" }]);
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
    expect(projectsApi.secrets.update).toHaveBeenCalledWith("/alpha", [{ key: "C", value: "3" }]);
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
      expect(ctx().projects.size).toBe(0);
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
      listBranches: (path: string) => {
        if (path === "/project-a") {
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

function createMockAPI(overrides: Partial<IPCApi["projects"]>) {
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
      get: mock(
        overrides.secrets?.get
          ? (...args: Parameters<typeof overrides.secrets.get>) => overrides.secrets!.get(...args)
          : () => Promise.resolve([])
      ),
      update: mock(
        overrides.secrets?.update
          ? (...args: Parameters<typeof overrides.secrets.update>) =>
              overrides.secrets!.update(...args)
          : () =>
              Promise.resolve({
                success: true as const,
                data: undefined,
              })
      ),
    },
  } satisfies IPCApi["projects"];

  // @ts-expect-error - Setting up global state for tests
  globalThis.window = new GlobalWindow();
  // @ts-expect-error - Setting up global state for tests
  globalThis.window.api = {
    projects,
  };
  globalThis.document = globalThis.window.document;

  return projects;
}

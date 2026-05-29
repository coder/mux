import {
  CHROMATIC_SMOKE_MODES,
  appMeta,
  AppWithMocks,
  type AppStory,
} from "@/browser/stories/meta.js";
import { createGitStatusExecutor } from "@/browser/stories/helpers/git";
import {
  collapseLeftSidebar,
  collapseRightSidebar,
  expandProjects,
  selectWorkspace,
} from "@/browser/stories/helpers/uiState";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { createWorkspace, groupWorkspacesByProject } from "@/browser/stories/mocks/workspaces";

export default {
  ...appMeta,
  title: "Components/WorkspaceMenuBar",
};

// Integration: stories render full app to show devcontainer runtime indicator in WorkspaceMenuBar context.

const DEVCONTAINER_RUNTIME = {
  type: "devcontainer" as const,
  configPath: ".devcontainer/devcontainer.json",
};

/**
 * Build a mock executor that handles BranchSelector's `git rev-parse --abbrev-ref HEAD`
 * plus GitStatusStore's consolidated status script, using a per-workspace branch map.
 */
function createBranchAwareExecutor(
  branches: Map<string, string>,
  gitStatus?: Map<string, { ahead?: number; behind?: number; dirty?: number }>
) {
  const baseExecutor = createGitStatusExecutor(gitStatus);
  return (workspaceId: string, script: string) => {
    // BranchSelector uses `git rev-parse --abbrev-ref HEAD` to detect the current branch
    if (script.includes("git rev-parse --abbrev-ref HEAD")) {
      const branch = branches.get(workspaceId) ?? "main";
      return Promise.resolve({
        success: true as const,
        output: branch,
        exitCode: 0,
        wall_duration_ms: 10,
      });
    }
    return baseExecutor(workspaceId, script);
  };
}

function createDevcontainerClient(runtimeStatus: "running" | "stopped" | "unknown") {
  const stableCreatedAt = "2023-11-14T22:13:20.000Z";

  const workspaces = [
    createWorkspace({
      id: "dc-1",
      name: "feature/lazy-start",
      projectName: "mux",
      runtimeConfig: DEVCONTAINER_RUNTIME,
      createdAt: stableCreatedAt,
    }),
    createWorkspace({
      id: "dc-2",
      name: "fix/sidebar-overflow",
      projectName: "mux",
      createdAt: stableCreatedAt,
    }),
  ];
  const projects = groupWorkspacesByProject(workspaces);

  selectWorkspace(workspaces[0]);
  expandProjects([...projects.keys()]);
  collapseRightSidebar();
  collapseLeftSidebar();

  const branches = new Map([
    // dc-1 branch is only available from git when the runtime is running;
    // otherwise BranchSelector falls back to branchCache / workspaceName.
    ...(runtimeStatus === "running" ? [["dc-1", "feature/lazy-start"] as const] : []),
    ["dc-2", "fix/sidebar-overflow"],
  ]);
  const gitStatus = new Map([
    // Passive git status is gated behind runtime eligibility — stopped/unknown
    // devcontainers have no git status data until the runtime starts.
    ...(runtimeStatus === "running" ? [["dc-1", { ahead: 2, dirty: 1 }] as const] : []),
    ["dc-2", { ahead: 0, behind: 3 }],
  ]);

  return createMockORPCClient({
    projects,
    workspaces,
    executeBash: createBranchAwareExecutor(branches, gitStatus),
    runtimeStatuses: new Map([
      ["dc-1", runtimeStatus],
      ["dc-2", "unsupported"],
    ]),
  });
}

/**
 * Devcontainer workspace with a running container.
 * The top bar shows a "Container running" indicator next to the branch selector.
 */
export const DevcontainerRunning: AppStory = {
  parameters: {
    chromatic: { modes: CHROMATIC_SMOKE_MODES },
  },
  render: () => <AppWithMocks setup={() => createDevcontainerClient("running")} />,
};

/**
 * Devcontainer workspace with a stopped container.
 * The top bar does NOT show a container indicator — verifies absence.
 */
export const DevcontainerStopped: AppStory = {
  render: () => <AppWithMocks setup={() => createDevcontainerClient("stopped")} />,
};

/** Devcontainer with unknown runtime status — no status chip should be visible. */
export const DevcontainerUnknown: AppStory = {
  render: () => <AppWithMocks setup={() => createDevcontainerClient("unknown")} />,
};

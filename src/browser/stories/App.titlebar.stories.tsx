/**
 * Title bar stories - demonstrates title bar layout variants.
 *
 * Each story shows a populated app (projects + workspaces in sidebar)
 * so the title bar coexists with real content rather than an empty shell.
 */

import React from "react";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { createWorkspace, groupWorkspacesByProject } from "./mockFactory";
import {
  selectWorkspace,
  expandProjects,
  collapseRightSidebar,
  createGitStatusExecutor,
} from "./storyHelpers";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";

export default {
  ...appMeta,
  title: "App/TitleBar",
};

// ─────────────────────────────────────────────────────────────────────────────
// Shared workspace fixtures (2 projects, 4 workspaces)
// ─────────────────────────────────────────────────────────────────────────────

function createPopulatedClient() {
  // Keep createdAt deterministic so recency tie-breakers can't reorder sibling
  // workspaces between Storybook/Chromatic runs.
  const stableCreatedAt = "2023-11-14T22:13:20.000Z";
  const workspaces = [
    createWorkspace({
      id: "tb-1",
      name: "feature/dark-mode",
      projectName: "web-app",
      createdAt: stableCreatedAt,
    }),
    createWorkspace({
      id: "tb-2",
      name: "fix/nav-overflow",
      projectName: "web-app",
      createdAt: stableCreatedAt,
    }),
    createWorkspace({
      id: "tb-3",
      name: "main",
      projectName: "api-server",
      createdAt: stableCreatedAt,
    }),
    createWorkspace({
      id: "tb-4",
      name: "refactor/auth",
      projectName: "api-server",
      createdAt: stableCreatedAt,
    }),
  ];
  const projects = groupWorkspacesByProject(workspaces);

  selectWorkspace(workspaces[0]);
  expandProjects([...projects.keys()]);
  collapseRightSidebar();

  return createMockORPCClient({ projects, workspaces });
}

// ─────────────────────────────────────────────────────────────────────────────
// Stories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * macOS desktop mode with traffic lights inset.
 * Logo is stacked above version to fit in constrained space.
 */
export const MacOSDesktop: AppStory = {
  decorators: [
    (Story) => {
      // Save and restore window.api to prevent leaking to other stories
      const originalApiRef = React.useRef(window.api);
      window.api = {
        platform: "darwin",
        versions: {
          node: "20.0.0",
          chrome: "120.0.0",
          electron: "28.0.0",
        },
        // This function's presence triggers isDesktopMode() → true
        getIsRosetta: () => Promise.resolve(false),
      };

      // Cleanup on unmount
      React.useEffect(() => {
        const savedApi = originalApiRef.current;
        return () => {
          window.api = savedApi;
        };
      }, []);

      return <Story />;
    },
  ],
  render: () => <AppWithMocks setup={createPopulatedClient} />,
};

/**
 * Browser / web mode — no Electron API, standard title bar.
 * Uses the same populated workspace data as MacOSDesktop.
 */
export const BrowserMode: AppStory = {
  render: () => <AppWithMocks setup={createPopulatedClient} />,
};

// ─────────────────────────────────────────────────────────────────────────────
// Devcontainer runtime indicator stories
// ─────────────────────────────────────────────────────────────────────────────

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

function createDevcontainerClient(runtimeStatus: "running" | "stopped") {
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

  const branches = new Map([
    ["dc-1", "feature/lazy-start"],
    ["dc-2", "fix/sidebar-overflow"],
  ]);
  const gitStatus = new Map([
    ["dc-1", { ahead: 2, dirty: 1 }],
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
  render: () => <AppWithMocks setup={() => createDevcontainerClient("running")} />,
};

/**
 * Devcontainer workspace with a stopped container.
 * The top bar does NOT show a container indicator — verifies absence.
 */
export const DevcontainerStopped: AppStory = {
  render: () => <AppWithMocks setup={() => createDevcontainerClient("stopped")} />,
};

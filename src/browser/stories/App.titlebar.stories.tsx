/**
 * Title bar stories - demonstrates title bar layout variants.
 *
 * Each story shows a populated app (projects + workspaces in sidebar)
 * so the title bar coexists with real content rather than an empty shell.
 */

import React from "react";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { createWorkspace, groupWorkspacesByProject } from "./mockFactory";
import { selectWorkspace, expandProjects, collapseRightSidebar } from "./storyHelpers";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";

export default {
  ...appMeta,
  title: "App/TitleBar",
};

// ─────────────────────────────────────────────────────────────────────────────
// Shared workspace fixtures (2 projects, 4 workspaces)
// ─────────────────────────────────────────────────────────────────────────────

function createPopulatedClient() {
  const workspaces = [
    createWorkspace({ id: "tb-1", name: "feature/dark-mode", projectName: "web-app" }),
    createWorkspace({ id: "tb-2", name: "fix/nav-overflow", projectName: "web-app" }),
    createWorkspace({ id: "tb-3", name: "main", projectName: "api-server" }),
    createWorkspace({ id: "tb-4", name: "refactor/auth", projectName: "api-server" }),
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

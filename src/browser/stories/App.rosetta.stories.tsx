/**
 * Rosetta banner stories - demonstrates the warning shown when running under Rosetta 2
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { createMockORPCClient } from "../../../.storybook/mocks/orpc";
import { setupSimpleChatStory, expandProjects } from "./storyHelpers";
import {
  STABLE_TIMESTAMP,
  createUserMessage,
  createAssistantMessage,
  createLocalWorkspace,
} from "./mockFactory";

export default {
  ...appMeta,
  title: "App/Rosetta",
};

/** Mock window.api to simulate Rosetta detection */
function mockRosettaEnvironment(): void {
  // Clear any previously dismissed state
  localStorage.removeItem("rosettaBannerDismissedAt");

  // Set window.api to simulate Rosetta environment
  window.api = {
    platform: "darwin",
    versions: {
      node: "20.0.0",
      chrome: "120.0.0",
      electron: "28.0.0",
    },
    isRosetta: true,
  };
}

/** Rosetta banner shown at top of app when running under translation */
export const RosettaBanner: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        mockRosettaEnvironment();
        return setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Hello! Can you help me with my code?", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 60000,
            }),
            createAssistantMessage(
              "msg-2",
              "Of course! I'd be happy to help. What would you like to work on today?",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 50000,
              }
            ),
          ],
        });
      }}
    />
  ),
};

/** Rosetta banner with multiple workspaces visible in sidebar */
export const RosettaBannerWithSidebar: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        mockRosettaEnvironment();
        expandProjects(["/Users/dev/my-project", "/Users/dev/another-project"]);
        return createMockORPCClient({
          projects: new Map([
            ["/Users/dev/my-project", { workspaces: [] }],
            ["/Users/dev/another-project", { workspaces: [] }],
          ]),
          workspaces: [
            createLocalWorkspace({
              id: "workspace-1",
              name: "feature-branch",
              projectName: "my-project",
              projectPath: "/Users/dev/my-project",
              createdAt: new Date(STABLE_TIMESTAMP - 3600000).toISOString(),
            }),
            createLocalWorkspace({
              id: "workspace-2",
              name: "main",
              projectName: "my-project",
              projectPath: "/Users/dev/my-project",
              createdAt: new Date(STABLE_TIMESTAMP - 7200000).toISOString(),
            }),
          ],
        });
      }}
    />
  ),
};

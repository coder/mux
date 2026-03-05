import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks } from "@/browser/stories/meta.js";
import { STABLE_TIMESTAMP, createUserMessage } from "@/browser/stories/mockFactory";
import { setupSimpleChatStory } from "@/browser/stories/storyHelpers.js";
import type { WorkspaceChatMessage } from "@/common/orpc/types";

const meta = { ...appMeta, title: "App/Chat/Messages/Init" };
export default meta;

/**
 * Story showing the InitMessage component in success state.
 * Tests the workspace init hook display with completed status.
 */
export const InitHookSuccess: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-init-success",
          messages: [
            createUserMessage("msg-1", "Start working on the project", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
          ],
          onChat: (_wsId, emit) => {
            // Emit init events to show completed init hook
            setTimeout(() => {
              emit({
                type: "init-start",
                hookPath: "/home/user/projects/my-app/.mux/init.sh",
                timestamp: STABLE_TIMESTAMP - 110000,
              } as WorkspaceChatMessage);
              emit({
                type: "init-output",
                line: "Installing dependencies...",
                timestamp: STABLE_TIMESTAMP - 109000,
              } as WorkspaceChatMessage);
              emit({
                type: "init-output",
                line: "Setting up environment variables...",
                timestamp: STABLE_TIMESTAMP - 108000,
              } as WorkspaceChatMessage);
              emit({
                type: "init-output",
                line: "Starting development server...",
                timestamp: STABLE_TIMESTAMP - 107000,
              } as WorkspaceChatMessage);
              emit({
                type: "init-end",
                exitCode: 0,
                timestamp: STABLE_TIMESTAMP - 106000,
              } as WorkspaceChatMessage);
            }, 100);
          },
        })
      }
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Shows the InitMessage component after a successful init hook execution. " +
          "The message displays with a green checkmark, hook path, and output lines.",
      },
    },
  },
};

/**
 * Story showing the InitMessage component in error state.
 * Tests the workspace init hook display with failed status.
 */
export const InitHookError: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-init-error",
          messages: [
            createUserMessage("msg-1", "Start working on the project", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
          ],
          onChat: (_wsId, emit) => {
            // Emit init events to show failed init hook
            setTimeout(() => {
              emit({
                type: "init-start",
                hookPath: "/home/user/projects/my-app/.mux/init.sh",
                timestamp: STABLE_TIMESTAMP - 110000,
              } as WorkspaceChatMessage);
              emit({
                type: "init-output",
                line: "Installing dependencies...",
                timestamp: STABLE_TIMESTAMP - 109000,
              } as WorkspaceChatMessage);
              emit({
                type: "init-output",
                line: "Failed to install package 'missing-dep'",
                timestamp: STABLE_TIMESTAMP - 108000,
                isError: true,
              } as WorkspaceChatMessage);
              emit({
                type: "init-output",
                line: "npm ERR! code E404",
                timestamp: STABLE_TIMESTAMP - 107500,
                isError: true,
              } as WorkspaceChatMessage);
              emit({
                type: "init-end",
                exitCode: 1,
                timestamp: STABLE_TIMESTAMP - 107000,
              } as WorkspaceChatMessage);
            }, 100);
          },
        })
      }
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Shows the InitMessage component after a failed init hook execution. " +
          "The message displays with a red alert icon, error styling, and error output.",
      },
    },
  },
};

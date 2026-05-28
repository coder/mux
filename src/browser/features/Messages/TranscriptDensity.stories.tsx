import { userEvent, waitFor } from "@storybook/test";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks, CHROMATIC_SMOKE_MODES } from "@/browser/stories/meta.js";
import { setupSimpleChatStory } from "@/browser/stories/helpers/chatSetup";
import { collapseLeftSidebar } from "@/browser/stories/helpers/uiState";
import { createAssistantMessage, createUserMessage } from "@/browser/stories/mocks/messages";
import {
  createAgentSkillReadTool,
  createBashTool,
  createFileEditTool,
  createFileReadTool,
  createGenericTool,
  createPendingTool,
  createWebSearchTool,
} from "@/browser/stories/mocks/tools";
import { STABLE_TIMESTAMP } from "@/browser/stories/mocks/workspaces";
import { TRANSCRIPT_DENSITY_KEY, type TranscriptDensity } from "@/common/constants/storage";

const meta = { ...appMeta, title: "App/Chat/Transcript Density" };
export default meta;

function setDensity(density: TranscriptDensity): void {
  updatePersistedState<TranscriptDensity>(TRANSCRIPT_DENSITY_KEY, density);
}

function setupTranscriptDensityStory(density: TranscriptDensity) {
  collapseLeftSidebar();
  setDensity(density);
  return setupSimpleChatStory({
    messages: [
      createUserMessage("density-user-1", "Audit the auth module and make the smallest safe fix", {
        historySequence: 1,
        timestamp: STABLE_TIMESTAMP - 60_000,
      }),
      createAssistantMessage("density-assistant-1", "I'll gather context first.", {
        historySequence: 2,
        timestamp: STABLE_TIMESTAMP - 55_000,
        reasoning:
          "Need to inspect auth code, search related validation guidance, and then make a minimal patch.",
        toolCalls: [
          createFileReadTool("density-read-1", "src/auth.ts", "export function verify() {}"),
          createWebSearchTool("density-search-1", "JWT validation best practices", 3),
          createAgentSkillReadTool("density-skill-1", "react-effects", { scope: "global" }),
          createBashTool("density-rg-1", 'rg "verify" src', "src/auth.ts:1:verify"),
          {
            type: "text",
            text: "I found the relevant code and will patch it.",
            timestamp: STABLE_TIMESTAMP - 35_000,
          },
          createFileEditTool(
            "density-edit-1",
            "src/auth.ts",
            [
              "--- src/auth.ts",
              "+++ src/auth.ts",
              "@@ -1,3 +1,4 @@",
              "+import { timingSafeEqual } from 'crypto';",
              " export function verify() {}",
            ].join("\n")
          ),
          createBashTool(
            "density-test-1",
            "make test",
            "42 tests passed",
            0,
            30,
            500,
            "Running tests"
          ),
          {
            type: "text",
            text: "Implemented the auth audit fix and validated it.",
            timestamp: STABLE_TIMESTAMP - 15_000,
          },
        ],
      }),
    ],
  });
}

function getRequiredStoryElement(canvasElement: HTMLElement, testId: string): HTMLElement {
  const element = canvasElement.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Expected ${testId} to be rendered`);
  }
  return element;
}

export const NormalNoisyTranscript: AppStory = {
  parameters: { chromatic: { modes: CHROMATIC_SMOKE_MODES } },
  render: () => <AppWithMocks setup={() => setupTranscriptDensityStory("normal")} />,
};

export const HyperCollapsedBundles: AppStory = {
  parameters: { chromatic: { modes: CHROMATIC_SMOKE_MODES } },
  render: () => <AppWithMocks setup={() => setupTranscriptDensityStory("hyper")} />,
};

export const HyperExpandedBundle: AppStory = {
  // Chromatic executes this play function for the visual snapshot, while the
  // app-level UI test covers expansion behavior without Storybook's manager-page timing.
  tags: ["!test"],
  render: () => <AppWithMocks setup={() => setupTranscriptDensityStory("hyper")} />,
  play: async ({ canvasElement }) => {
    const workBundle = await waitFor(() => getRequiredStoryElement(canvasElement, "work-bundle"), {
      timeout: 15_000,
    });

    await userEvent.click(workBundle);

    await waitFor(
      () => {
        if (workBundle.getAttribute("aria-expanded") !== "true") {
          throw new Error("Expected HyperExpandedBundle work bundle to be expanded");
        }
      },
      { timeout: 15_000 }
    );
    await waitFor(() => getRequiredStoryElement(canvasElement, "operational-bundle"), {
      timeout: 15_000,
    });
  },
};

export const HyperActiveExpandedBundle: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        setDensity("hyper");
        return setupSimpleChatStory({
          messages: [
            createUserMessage("active-user-1", "Inspect the repository", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 40_000,
            }),
            createAssistantMessage("active-assistant-1", "I'll read the key files now.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 35_000,
              toolCalls: [
                createPendingTool("active-read-1", "file_read", { path: "src/App.tsx" }),
                createPendingTool("active-search-1", "web_search", {
                  query: "Mux transcript density",
                }),
              ],
            }),
          ],
        });
      }}
    />
  ),
};

export const HyperVisibleCriticalEvents: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        setDensity("hyper");
        return setupSimpleChatStory({
          messages: [
            createUserMessage("critical-user-1", "Make the change and validate it", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 40_000,
            }),
            createAssistantMessage("critical-assistant-1", "I'll inspect, edit, and validate.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 35_000,
              toolCalls: [
                createFileReadTool(
                  "critical-read-1",
                  "src/config.ts",
                  "export const enabled = false;"
                ),
                createFileEditTool(
                  "critical-edit-1",
                  "src/config.ts",
                  "--- src/config.ts\n+++ src/config.ts\n@@ -1 +1 @@\n-export const enabled = false;\n+export const enabled = true;"
                ),
                createBashTool(
                  "critical-validation-1",
                  "make typecheck",
                  "Type error in src/config.ts",
                  1
                ),
                createGenericTool(
                  "critical-question-1",
                  "ask_user_question",
                  { question: "Proceed?" },
                  { answer: "Yes" }
                ),
                createGenericTool(
                  "critical-notify-1",
                  "notify",
                  { title: "Validation failed" },
                  { success: true }
                ),
              ],
            }),
          ],
        });
      }}
    />
  ),
};

export const HyperAllMissSearchBundle: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        setDensity("hyper");
        return setupSimpleChatStory({
          messages: [
            createUserMessage("miss-user-1", "Look for a deprecated helper", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 40_000,
            }),
            createAssistantMessage("miss-assistant-1", "I'll search for that helper.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 35_000,
              toolCalls: [createWebSearchTool("miss-search-1", "deprecatedMuxHelper", 0)],
            }),
          ],
        });
      }}
    />
  ),
};

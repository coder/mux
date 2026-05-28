import "../dom";
import { fireEvent, waitFor } from "@testing-library/react";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { TRANSCRIPT_DENSITY_KEY, type TranscriptDensity } from "@/common/constants/storage";
import { setupSimpleChatStory } from "@/browser/stories/helpers/chatSetup";
import { createWorkspace } from "@/browser/stories/mocks/workspaces";
import { createAssistantMessage, createUserMessage } from "@/browser/stories/mocks/messages";
import {
  createAgentSkillReadTool,
  createBashTool,
  createFileReadTool,
  createWebSearchTool,
} from "@/browser/stories/mocks/tools";
import { installDom } from "../dom";
import { cleanupView, setupWorkspaceView } from "../helpers";
import { renderApp } from "../renderReviewPanel";

function queryButton(container: HTMLElement, testId: string): HTMLButtonElement | null {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  return element instanceof HTMLButtonElement
    ? element
    : (element?.querySelector("button") ?? null);
}

describe("Hyper transcript density", () => {
  test("expands work bundles and nested operational bundles through the app render path", async () => {
    const cleanupDom = installDom();
    updatePersistedState<TranscriptDensity>(TRANSCRIPT_DENSITY_KEY, "hyper");

    const metadata = createWorkspace({
      id: "ws-density",
      name: "feature",
      projectName: "my-app",
      projectPath: "/home/user/projects/my-app",
    });
    const client = setupSimpleChatStory({
      workspaceId: metadata.id,
      workspaceName: metadata.name,
      projectName: metadata.projectName,
      projectPath: metadata.projectPath,
      messages: [
        createUserMessage("density-user-1", "Audit the auth module", { historySequence: 1 }),
        createAssistantMessage("density-assistant-1", "I'll gather context first.", {
          historySequence: 2,
          reasoning: "Need to inspect auth code before changing it.",
          toolCalls: [
            createFileReadTool("density-read-1", "src/auth.ts", "export function verify() {}"),
            createWebSearchTool("density-search-1", "JWT validation best practices", 1),
            createAgentSkillReadTool("density-skill-1", "react-effects", { scope: "global" }),
            createBashTool("density-rg-1", 'rg "verify" src', "src/auth.ts:1:verify"),
            { type: "text", text: "Implemented the auth audit fix." },
          ],
        }),
      ],
    });
    const view = renderApp({ apiClient: client, metadata });

    try {
      await setupWorkspaceView(view, metadata, metadata.id);

      const workButton = await waitFor(() => {
        const button = queryButton(view.container, "work-bundle");
        if (!button) {
          throw new Error("Work bundle button not found");
        }
        return button;
      });
      expect(workButton.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(workButton);

      const operationalButton = await waitFor(() => {
        const button = queryButton(view.container, "operational-bundle");
        if (!button) {
          throw new Error("Operational bundle button not found");
        }
        return button;
      });
      fireEvent.click(operationalButton);

      await waitFor(() => {
        expect(view.container.textContent).toContain("src/auth.ts");
      });
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);
});

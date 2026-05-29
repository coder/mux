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
  createGenericTool,
  createWebSearchTool,
} from "@/browser/stories/mocks/tools";
import { installDom } from "../dom";
import { cleanupView, setupWorkspaceView } from "../helpers";
import { renderApp } from "../renderReviewPanel";

function queryButtons(container: HTMLElement, testId: string): HTMLButtonElement[] {
  const HTMLButton = container.ownerDocument.defaultView?.HTMLButtonElement;
  if (!HTMLButton) {
    throw new Error("Expected test DOM to provide HTMLButtonElement");
  }
  return Array.from(container.querySelectorAll(`[data-testid="${testId}"]`)).flatMap((element) => {
    if (element instanceof HTMLButton) {
      return [element];
    }
    const button = element.querySelector("button");
    return button ? [button] : [];
  });
}

function queryButton(container: HTMLElement, testId: string): HTMLButtonElement | null {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  const HTMLButton = container.ownerDocument.defaultView?.HTMLButtonElement;
  if (!HTMLButton) {
    throw new Error("Expected test DOM to provide HTMLButtonElement");
  }
  return element instanceof HTMLButton ? element : (element?.querySelector("button") ?? null);
}

function expectTextOrder(container: HTMLElement, ...orderedText: string[]): void {
  const text = container.textContent ?? "";
  let previousIndex = -1;
  for (const expected of orderedText) {
    const index = text.indexOf(expected);
    if (index === -1) {
      throw new Error(`Expected transcript text to contain "${expected}"`);
    }
    expect(index).toBeGreaterThan(previousIndex);
    previousIndex = index;
  }
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
        createUserMessage("density-user-1", "Audit the auth module", {
          historySequence: 1,
          timestamp: 0,
        }),
        createAssistantMessage("density-assistant-1", "I'll gather context first.", {
          historySequence: 2,
          timestamp: 1_000,
          partial: true,
          reasoning: "Need to inspect auth code before changing it.",
          toolCalls: [
            createFileReadTool("density-read-1", "src/auth.ts", "export function verify() {}"),
            createWebSearchTool("density-search-1", "JWT validation best practices", 1),
            createAgentSkillReadTool("density-skill-1", "react-effects", { scope: "global" }),
            createGenericTool(
              "density-question-1",
              "ask_user_question",
              { question: "Any additional validation needed?" },
              { answer: "Please validate with typecheck too" }
            ),
          ],
        }),
        createUserMessage("density-user-2", "Please validate with typecheck too", {
          historySequence: 3,
          timestamp: 11_000,
        }),
        createAssistantMessage("density-assistant-2", "I'll patch and validate now.", {
          historySequence: 4,
          timestamp: 21_000,
          toolCalls: [
            createBashTool(
              "density-fail-1",
              "make typecheck",
              "Type error in src/auth.ts",
              1,
              30,
              500,
              "Failing validation"
            ),
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
      expect(view.container.textContent).toContain("Please validate with typecheck too");
      expect(view.container.textContent).not.toContain("make typecheck");
      expect(view.container.textContent).toContain("Implemented the auth audit fix.");
      expect(view.container.textContent).not.toContain("I'll patch and validate now.");
      expect(view.container.textContent).not.toContain("I'll gather context first.");
      expectTextOrder(
        view.container,
        "Audit the auth module",
        "Worked for",
        "Please validate with typecheck too",
        "Implemented the auth audit fix."
      );
      fireEvent.click(workButton);

      const firstOperationalButton = await waitFor(() => {
        const button = queryButton(view.container, "operational-bundle");
        if (!button) {
          throw new Error("Operational bundle button not found");
        }
        return button;
      });
      expect(firstOperationalButton.textContent).toContain("Ran 5 operations");
      expect(firstOperationalButton.getAttribute("aria-expanded")).toBe("false");
      expect(view.container.textContent).toContain("Please validate with typecheck too");
      expect(view.container.textContent).not.toContain("src/auth.ts");
      expect(view.container.textContent).not.toContain("make typecheck");
      expectTextOrder(
        view.container,
        "I'll gather context first.",
        "Please validate with typecheck too",
        "I'll patch and validate now."
      );
      fireEvent.click(firstOperationalButton);

      await waitFor(() => {
        expect(view.container.textContent).toContain("src/auth.ts");
      });

      const failedOperationalButton = await waitFor(() => {
        const button = queryButtons(view.container, "operational-bundle").find((candidate) =>
          candidate.textContent?.includes("Ran 1 shell command")
        );
        if (!button) {
          throw new Error("Failed operational bundle button not found");
        }
        return button;
      });
      expect(failedOperationalButton.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(failedOperationalButton);

      await waitFor(() => {
        expect(view.container.textContent).toContain("make typecheck");
      });
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);
});

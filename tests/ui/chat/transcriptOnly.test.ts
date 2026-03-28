/**
 * UI integration test for transcript-only workspaces.
 * Verifies the transcript stays visible while the composer becomes read-only.
 */

import "../dom";
import { waitFor } from "@testing-library/react";

import { installDom } from "../dom";
import { renderApp } from "../renderReviewPanel";
import { cleanupView, setupWorkspaceView } from "../helpers";
import {
  createAssistantMessage,
  createStaticChatHandler,
  createUserMessage,
  createWorkspace,
  groupWorkspacesByProject,
} from "@/browser/stories/mockFactory";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";

async function getTranscriptComposer(container: HTMLElement): Promise<HTMLTextAreaElement> {
  return waitFor(
    () => {
      const textareas = Array.from(
        container.querySelectorAll('textarea[aria-label="Message Claude"]')
      ) as HTMLTextAreaElement[];
      const composer = [...textareas].reverse()[0];
      if (!composer) {
        throw new Error("Chat textarea not found");
      }
      return composer;
    },
    { timeout: 10_000 }
  );
}

describe("Transcript-only workspace UI", () => {
  test("shows a read-only notice, disables the composer, and keeps transcript messages visible", async () => {
    const cleanupDom = installDom();
    const metadata = createWorkspace({
      id: "ws-transcript-only",
      name: "deleted-worktree",
      projectName: "my-app",
      transcriptOnly: true,
    });
    const messages = [
      createUserMessage("msg-user-1", "Past user question", { historySequence: 1 }),
      createAssistantMessage("msg-assistant-1", "Past assistant answer", { historySequence: 2 }),
    ];
    const staticChatHandler = createStaticChatHandler(messages);
    const client = createMockORPCClient({
      projects: groupWorkspacesByProject([metadata]),
      workspaces: [metadata],
      onChat: (workspaceId, emit) => {
        if (workspaceId !== metadata.id) {
          queueMicrotask(() => emit({ type: "caught-up", hasOlderHistory: false }));
          return undefined;
        }
        return staticChatHandler(emit);
      },
    });
    const view = renderApp({ apiClient: client, metadata });

    try {
      await setupWorkspaceView(view, metadata, metadata.id);

      const noticeBanner = await waitFor(
        () => {
          const banner = view.getByText(/worktree is no longer available/i);
          if (!banner.textContent?.match(/read-only chat transcript/i)) {
            throw new Error("Transcript-only notice did not render full copy");
          }
          return banner;
        },
        { timeout: 10_000 }
      );

      expect(noticeBanner.className).toContain("border-border-medium");
      expect(noticeBanner.className).toContain("bg-background-secondary");
      expect(noticeBanner.className).toContain("text-muted");
      expect(noticeBanner.className).toContain("rounded-md");

      const composer = await getTranscriptComposer(view.container);
      expect(composer.disabled).toBe(true);
      expect(composer.placeholder).toContain("worktree is no longer available");
      expect(composer.placeholder).toContain("read-only chat transcript");

      await waitFor(
        () => {
          expect(view.getByText("Past user question")).toBeTruthy();
          expect(view.getByText("Past assistant answer")).toBeTruthy();
        },
        { timeout: 10_000 }
      );
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);
});

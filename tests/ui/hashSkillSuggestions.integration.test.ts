/**
 * Integration tests for #skill mentions.
 *
 * Focus:
 * - Typing #... shows skill suggestions
 * - Selecting a suggestion inserts "#skill-name " into the draft
 */

import "./dom";

import { act, fireEvent, waitFor, within } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  withSharedWorkspace,
} from "../ipc/sendMessageTestHelpers";

import { renderApp } from "./renderReviewPanel";
import { cleanupView, setupTestDom, setupWorkspaceView } from "./helpers";

import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getInputKey } from "@/common/constants/storage";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

async function getActiveChatTextarea(container: HTMLElement): Promise<HTMLTextAreaElement> {
  return waitFor(
    () => {
      // There can be multiple ChatInput instances mounted (e.g., ProjectPage + Workspace view).
      // Use the last textarea in DOM order to target the active view.
      const textareas = Array.from(
        container.querySelectorAll('textarea[aria-label="Message Claude"]')
      ) as HTMLTextAreaElement[];

      if (textareas.length === 0) {
        throw new Error("Chat textarea not found");
      }

      const enabled = [...textareas].reverse().find((el) => !el.disabled);
      if (!enabled) {
        throw new Error(`Chat textarea is disabled (found ${textareas.length})`);
      }

      return enabled;
    },
    { timeout: 10_000 }
  );
}

describeIntegration("Hash skill suggestions", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("typing # shows skill suggestions and inserts selection (workspace mode)", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = setupTestDom();
      const view = renderApp({ apiClient: env.orpc, metadata });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        const textarea = await getActiveChatTextarea(view.container);
        textarea.focus();

        act(() => {
          updatePersistedState(getInputKey(workspaceId), "#");
        });

        await waitFor(
          () => {
            expect(textarea.value).toBe("#");
          },
          { timeout: 5_000 }
        );

        // Ensure cursor is at end so the # token is considered "at cursor".
        textarea.selectionStart = textarea.value.length;
        textarea.selectionEnd = textarea.value.length;
        fireEvent.select(textarea);

        const listbox = await waitFor(
          () => {
            const el = within(view.container).getByRole("listbox", { name: "Skill suggestions" });
            return el;
          },
          { timeout: 10_000 }
        );

        const firstOption = listbox.querySelector('[role="option"]') as HTMLElement | null;
        if (!firstOption) {
          throw new Error("No skill options found");
        }

        fireEvent.click(firstOption);

        await waitFor(
          () => {
            expect(textarea.value).toMatch(/^#[^\s]+ $/);
          },
          { timeout: 5_000 }
        );

        await waitFor(
          () => {
            expect(
              within(view.container).queryByRole("listbox", { name: "Skill suggestions" })
            ).toBeNull();
          },
          { timeout: 5_000 }
        );
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 30_000);
});

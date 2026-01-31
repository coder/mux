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

import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getInputKey } from "@/common/constants/storage";

import { createAppHarness } from "./harness/createAppHarness";

function getTextFromPromptMessage(message: import("@/common/types/message").MuxMessage): string {
  return message.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("");
}

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("Hash skill suggestions", () => {
  test("suggesting + sending #skill inserts skill snapshot into the prompt", async () => {
    const app = await createAppHarness({ aiMode: "mock-router" });

    try {
      const textarea = await waitFor(
        () => {
          const el = app.view.container.querySelector(
            'textarea[aria-label="Message Claude"]'
          ) as HTMLTextAreaElement | null;
          if (!el || el.disabled) {
            throw new Error("Active chat textarea not ready");
          }
          return el;
        },
        { timeout: 10_000 }
      );

      textarea.focus();

      act(() => {
        updatePersistedState(getInputKey(app.workspaceId), "#");
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
          return within(app.view.container).getByRole("listbox", { name: "Skill suggestions" });
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

      const match = textarea.value.match(/^#([^\s]+) $/);
      if (!match) {
        throw new Error(
          `Inserted skill mention did not match expected pattern: "${textarea.value}"`
        );
      }
      const skillName = match[1];

      // Send a message that uses the inserted mention.
      // ChatHarness.send updates the persisted draft deterministically and clicks Send.
      await app.chat.send(`${textarea.value}Please summarize the key points.`);

      await waitFor(
        () => {
          const promptResult = app.env.services.aiService.debugGetLastMockPrompt(app.workspaceId);
          if (!promptResult.success) {
            throw new Error(promptResult.error);
          }

          const prompt = promptResult.data;
          expect(prompt).not.toBeNull();

          // Backend should have materialized the skill into a synthetic snapshot message.
          const snapshot = prompt?.find((m) =>
            getTextFromPromptMessage(m).includes("<agent-skill")
          );
          expect(snapshot).toBeDefined();
          expect(getTextFromPromptMessage(snapshot!)).toContain(`name=\"${skillName}\"`);

          // And the user message sent to the model should be the formatted "Using skill(s)…" text.
          const latestUser = [...(prompt ?? [])].reverse().find((m) => m.role === "user");
          expect(latestUser).toBeDefined();
          const latestUserText = getTextFromPromptMessage(latestUser!);
          expect(latestUserText).toContain("Using skill");
          expect(latestUserText).not.toContain(`#${skillName}`);
        },
        { timeout: 15_000 }
      );
    } finally {
      await app.dispose();
    }
  }, 45_000);
});

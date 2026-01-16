import { act, waitFor } from "@testing-library/react";

import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getModelKey, getThinkingLevelKey } from "@/common/constants/storage";

import { createAppHarness } from "./harness";

describe("Thinking keybind (UI)", () => {
  test("cycles to xhigh for gpt-5.2-codex", async () => {
    const app = await createAppHarness({ branchPrefix: "thinking-keybind" });

    try {
      const model = "openai:gpt-5.2-codex-2025-12-11-preview";

      act(() => {
        updatePersistedState(getModelKey(app.workspaceId), model);
        updatePersistedState(getThinkingLevelKey(app.workspaceId), "high");
      });

      await waitFor(() => {
        const slider = app.view.getByLabelText("Thinking level") as HTMLInputElement | null;
        if (!slider) {
          throw new Error("Thinking slider not found");
        }
        if (slider.getAttribute("aria-valuetext") !== "high") {
          throw new Error("Thinking level has not updated to high");
        }
      });

      act(() => {
        window.dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "T",
            ctrlKey: true,
            shiftKey: true,
          })
        );
      });

      await waitFor(() => {
        const slider = app.view.getByLabelText("Thinking level") as HTMLInputElement | null;
        if (!slider) {
          throw new Error("Thinking slider not found");
        }
        if (slider.getAttribute("aria-valuetext") !== "xhigh") {
          throw new Error("Thinking level did not advance to xhigh");
        }
      });

      act(() => {
        window.dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "T",
            ctrlKey: true,
            shiftKey: true,
            repeat: true,
          })
        );
      });

      await waitFor(() => {
        const slider = app.view.getByLabelText("Thinking level") as HTMLInputElement | null;
        if (!slider) {
          throw new Error("Thinking slider not found");
        }
        if (slider.getAttribute("aria-valuetext") !== "xhigh") {
          throw new Error("Thinking level should ignore repeated keydown");
        }
      });
    } finally {
      await app.dispose();
    }
  });
});

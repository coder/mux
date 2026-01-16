import { act, waitFor } from "@testing-library/react";

import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getModelKey, getThinkingLevelKey } from "@/common/constants/storage";

import { createAppHarness } from "./harness";

describe("Thinking keybind (UI)", () => {
  test("cycles to xhigh for gpt-5.2-codex (selected via /model)", async () => {
    const app = await createAppHarness({ branchPrefix: "thinking-keybind" });

    try {
      await app.chat.send("/model codex");

      await waitFor(() => {
        const model = readPersistedState<string>(getModelKey(app.workspaceId), "");
        expect(model).toBe("openai:gpt-5.2-codex");
      });

      // Start from a deterministic thinking level so we can assert the next step.
      act(() => {
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

        // 5 allowed levels means max index 4.
        expect(slider.getAttribute("aria-valuemax")).toBe("4");
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

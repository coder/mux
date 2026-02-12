/**
 * Integration test: System 1 settings should only expose thinking levels
 * supported by the selected System 1 model.
 */

import "../dom";
import { fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { EXPERIMENT_IDS, getExperimentKey } from "@/common/constants/experiments";
import {
  PREFERRED_SYSTEM_1_MODEL_KEY,
  PREFERRED_SYSTEM_1_THINKING_LEVEL_KEY,
} from "@/common/constants/storage";

import { shouldRunIntegrationTests } from "../../testUtils";
import { createAppHarness } from "../harness";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

const GEMINI_FLASH_PREVIEW = "google:gemini-3-flash-preview";

/**
 * Regression for: the System 1 Reasoning dropdown showing unsupported options.
 *
 * Example:
 * - Model: gemini-3-flash-preview
 * - Stored level: xhigh (unsupported)
 *
 * Expected:
 * - UI clamps display to "high"
 * - Dropdown does not include "xhigh"
 */
describeIntegration("System 1 reasoning policy", () => {
  test("clamps and filters unsupported thinking levels for the selected model", async () => {
    const harness = await createAppHarness({
      branchPrefix: "system1",
      beforeRender() {
        updatePersistedState(getExperimentKey(EXPERIMENT_IDS.SYSTEM_1), true);
        updatePersistedState(PREFERRED_SYSTEM_1_MODEL_KEY, GEMINI_FLASH_PREVIEW);
        updatePersistedState(PREFERRED_SYSTEM_1_THINKING_LEVEL_KEY, "xhigh");
      },
    });

    try {
      const doc = harness.view.container.ownerDocument;
      const user = userEvent.setup({ document: doc });

      const canvas = within(harness.view.container);
      const settingsButton = await canvas.findByTestId("settings-button", {}, { timeout: 10_000 });
      await user.click(settingsButton);

      // Settings now render as a route page in the main pane (not a modal dialog).
      const settingsCanvas = within(harness.view.container);
      const body = within(harness.view.container.ownerDocument.body);

      const system1TabButtons = await settingsCanvas.findAllByRole(
        "button",
        {
          name: /system 1/i,
        },
        { timeout: 10_000 }
      );
      const system1TabButton = system1TabButtons[0];
      if (!system1TabButton) {
        throw new Error("System 1 tab button not found");
      }
      await user.click(system1TabButton);

      await settingsCanvas.findByText(/System 1 Reasoning/i);

      const reasoningSelect = await waitFor(() => {
        const el = harness.view.container.querySelector(
          'button[role="combobox"]'
        ) as HTMLButtonElement | null;
        if (!el) {
          throw new Error("System 1 Reasoning select not found");
        }
        return el;
      });

      await waitFor(() => {
        const value = reasoningSelect.textContent?.trim();
        if (value !== "high") {
          throw new Error(`Expected reasoning value "high" but got ${JSON.stringify(value)}`);
        }
      });

      // Radix Select opens on keyboard interactions (ArrowDown/Enter) reliably in tests.
      fireEvent.keyDown(reasoningSelect, { key: "ArrowDown" });

      await body.findByRole("option", { name: "high" });

      const xhighOption = body.queryByRole("option", { name: "xhigh" });
      if (xhighOption) {
        throw new Error(
          "Expected System 1 Reasoning dropdown to hide xhigh for gemini-3-flash-preview"
        );
      }
    } finally {
      await harness.dispose();
    }
  }, 90_000);
});

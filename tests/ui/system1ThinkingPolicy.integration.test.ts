/**
 * Integration test: System1 agent defaults should only expose thinking levels
 * supported by the selected model.
 */

import "./dom";
import { fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { shouldRunIntegrationTests } from "../testUtils";
import { createAppHarness } from "./harness";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

const GEMINI_FLASH_PREVIEW = "google:gemini-3-flash-preview";

/**
 * Regression for: the System1 Reasoning dropdown showing unsupported options.
 *
 * Example:
 * - Model: gemini-3-flash-preview
 * - Stored level: xhigh (unsupported)
 *
 * Expected:
 * - UI clamps display to "high"
 * - Dropdown does not include "xhigh"
 */
describeIntegration("System1 reasoning policy", () => {
  test("clamps and filters unsupported thinking levels for the selected model", async () => {
    const harness = await createAppHarness({
      branchPrefix: "system1",
    });

    try {
      await harness.env.orpc.config.updateAgentAiDefaults({
        agentAiDefaults: {
          system1_bash: {
            modelString: GEMINI_FLASH_PREVIEW,
            thinkingLevel: "xhigh",
          },
        },
      });

      const doc = harness.view.container.ownerDocument;
      const user = userEvent.setup({ document: doc });

      const canvas = within(harness.view.container);
      const settingsButton = await canvas.findByTestId("settings-button", {}, { timeout: 10_000 });
      settingsButton.click();

      const body = within(doc.body);
      const dialog = await body.findByRole("dialog", {}, { timeout: 10_000 });
      const dialogCanvas = within(dialog);

      const agentsTabButton = await dialogCanvas.findByRole(
        "button",
        {
          name: /agents/i,
        },
        { timeout: 10_000 }
      );
      await user.click(agentsTabButton);

      await dialogCanvas.findByText(/System1 Defaults \(internal\)/i);

      const system1BashTitle = await dialogCanvas.findByText("System1 Bash");
      const system1BashCard = system1BashTitle.closest("div.rounded-md") as HTMLElement | null;
      if (!system1BashCard) {
        throw new Error("System1 Bash defaults card not found");
      }

      const reasoningLabel = within(system1BashCard).getByText("Reasoning");
      const reasoningContainer = reasoningLabel.parentElement;
      const reasoningSelect = reasoningContainer?.querySelector(
        'button[role="combobox"]'
      ) as HTMLButtonElement | null;
      if (!reasoningSelect) {
        throw new Error("System1 Bash Reasoning select not found");
      }

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
          "Expected System1 Reasoning dropdown to hide xhigh for gemini-3-flash-preview"
        );
      }
    } finally {
      await harness.dispose();
    }
  }, 90_000);
});

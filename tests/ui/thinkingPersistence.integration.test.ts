/**
 * Integration test for thinking level persistence across model switches.
 */

import "./dom";
import { fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CUSTOM_EVENTS } from "@/common/constants/events";
import { getModelKey } from "@/common/constants/storage";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { formatModelDisplayName } from "@/common/utils/ai/modelDisplay";

import { shouldRunIntegrationTests } from "../testUtils";
import { createAppHarness } from "./harness";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

const CODEX_MODEL = "openai:gpt-5.2-codex";
const OPUS_MODEL = "anthropic:claude-opus-4-5";

async function openModelSelector(container: HTMLElement): Promise<HTMLInputElement> {
  window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_MODEL_SELECTOR));

  return await waitFor(() => {
    const input = container.querySelector<HTMLInputElement>(
      'input[placeholder="Search [provider:model-name]"]'
    );
    if (!input) {
      throw new Error("Model selector input not found");
    }
    return input;
  });
}

async function selectModel(
  container: HTMLElement,
  workspaceId: string,
  model: string
): Promise<void> {
  const input = await openModelSelector(container);

  const user = userEvent.setup({ document: container.ownerDocument });
  await user.clear(input);
  await user.type(input, model);

  const option = await waitFor(() => {
    const match = within(container).getByText(model);
    if (!match) {
      throw new Error("Model option not found");
    }
    return match;
  });

  fireEvent.click(option);

  await waitFor(() => {
    const persisted = readPersistedState(getModelKey(workspaceId), "");
    if (persisted !== model) {
      throw new Error(`Expected model ${model} but got ${persisted}`);
    }
  });

  // Wait for the UI to reflect the new model. This guards against race conditions
  // where backend metadata updates can temporarily revert localStorage (and thus
  // the displayed model) when switching models rapidly.
  // Use the exact display name that the UI will show.
  const modelName = model.split(":")[1] ?? model;
  const expectedDisplayName = formatModelDisplayName(modelName).toLowerCase();
  await waitFor(
    () => {
      const modelGroup = container.querySelector('[data-component="ModelSelectorGroup"]');
      const displayedModel = (modelGroup?.textContent ?? "").toLowerCase();
      if (!displayedModel.includes(expectedDisplayName)) {
        throw new Error(
          `Waiting for UI to show "${expectedDisplayName}", currently shows "${displayedModel}"`
        );
      }
    },
    { timeout: 3000 }
  );

  // Wait for UI to stabilize - ensure thinking slider is present and not in flux.
  // Backend metadata updates can cause re-renders; waiting for a stable state
  // prevents races when the test immediately interacts with thinking controls.
  await waitFor(
    () => {
      const thinkingButton = container.querySelector(
        '[data-component="ThinkingSliderGroup"] button span'
      );
      if (!thinkingButton?.textContent) {
        throw new Error("Waiting for thinking controls to stabilize");
      }
    },
    { timeout: 2000 }
  );
}

async function setThinkingToMax(container: HTMLElement): Promise<void> {
  // Wait for the thinking slider to render and for it to show xhigh.
  // We cycle by clicking the button, which cycles through levels.
  // For CODEX model the levels are: off → low → medium → high → xhigh → off...
  await waitFor(
    async () => {
      const button = container.querySelector(
        '[data-component="ThinkingSliderGroup"] button'
      ) as HTMLButtonElement | null;
      if (!button) {
        throw new Error("Thinking level button not found");
      }

      const current = button.querySelector("span")?.textContent?.trim()?.toLowerCase();
      if (current === "xhigh") {
        return; // Done!
      }

      // Click to cycle to next level
      fireEvent.click(button);
      throw new Error(`Cycling thinking level, currently at: ${current ?? "<missing>"}`);
    },
    { timeout: 10000, interval: 200 }
  );
}

async function expectThinkingLabel(container: HTMLElement, expected: string): Promise<void> {
  await waitFor(
    () => {
      const label = container.querySelector('[data-component="ThinkingSliderGroup"] button span');
      const text = label?.textContent?.trim();
      if (text !== expected) {
        throw new Error(`Expected thinking label ${expected} but got ${text ?? "<missing>"}`);
      }
    },
    { timeout: 3000 }
  );
}

describeIntegration("Thinking level persistence", () => {
  test("keeps xhigh preference when switching away and back", async () => {
    const harness = await createAppHarness({ branchPrefix: "thinking" });

    try {
      await selectModel(harness.view.container, harness.workspaceId, CODEX_MODEL);
      await setThinkingToMax(harness.view.container);
      await expectThinkingLabel(harness.view.container, "xhigh");

      await selectModel(harness.view.container, harness.workspaceId, OPUS_MODEL);
      await expectThinkingLabel(harness.view.container, "high");

      await selectModel(harness.view.container, harness.workspaceId, CODEX_MODEL);
      await expectThinkingLabel(harness.view.container, "xhigh");
    } finally {
      await harness.dispose();
    }
  }, 90_000);
});

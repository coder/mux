/**
 * Integration test for the PRO reasoning-mode toggle:
 * visibility gating per model + persistence across model switches.
 */

import "../dom";
import { fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CUSTOM_EVENTS } from "@/common/constants/events";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { getModelKey } from "@/common/constants/storage";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { formatModelDisplayName } from "@/common/utils/ai/modelDisplay";

import { shouldRunIntegrationTests } from "../../testUtils";
import { createAppHarness } from "../harness";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

const SOL_MODEL = KNOWN_MODELS.GPT.id;
// Pro mode is family-wide across GPT-5.6 (incl. Luna), so the "hidden" case
// must use a pre-5.6 model without pro support.
const NON_PRO_MODEL = KNOWN_MODELS.GPT_PRO.id;

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

  const modelName = model.split(":")[1] ?? model;
  const modelDisplayName = formatModelDisplayName(modelName);

  const option = await waitFor(() => {
    const match = within(container).getByText(modelDisplayName);
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
}

function getToggle(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('[data-component="ProModeToggle"]');
}

async function expectToggleVisible(container: HTMLElement): Promise<HTMLButtonElement> {
  return await waitFor(() => {
    const toggle = getToggle(container);
    if (!toggle) {
      throw new Error("ProModeToggle not rendered");
    }
    return toggle;
  });
}

async function expectToggleHidden(container: HTMLElement): Promise<void> {
  await waitFor(() => {
    if (getToggle(container)) {
      throw new Error("ProModeToggle should not render for this model");
    }
  });
}

async function expectTogglePressed(container: HTMLElement, pressed: boolean): Promise<void> {
  await waitFor(() => {
    const toggle = getToggle(container);
    if (!toggle) {
      throw new Error("ProModeToggle not rendered");
    }
    if (toggle.getAttribute("aria-pressed") !== String(pressed)) {
      throw new Error(
        `Expected aria-pressed=${pressed} but got ${toggle.getAttribute("aria-pressed")}`
      );
    }
  });
}

describeIntegration("Pro reasoning-mode toggle", () => {
  test("renders only for pro-capable models and persists across model switches", async () => {
    const harness = await createAppHarness({ branchPrefix: "promode" });

    try {
      const { container } = harness.view;

      // Visible on Sol; enable PRO.
      await selectModel(container, harness.workspaceId, SOL_MODEL);
      const toggle = await expectToggleVisible(container);
      await expectTogglePressed(container, false);
      fireEvent.click(toggle);
      await expectTogglePressed(container, true);

      // Hidden on GPT-5.5 Pro (no reasoning.mode pro support).
      await selectModel(container, harness.workspaceId, NON_PRO_MODEL);
      await expectToggleHidden(container);

      // Back to Sol: persisted PRO state survives the switch.
      await selectModel(container, harness.workspaceId, SOL_MODEL);
      await expectTogglePressed(container, true);
    } finally {
      await harness.dispose();
    }
  }, 90_000);
});

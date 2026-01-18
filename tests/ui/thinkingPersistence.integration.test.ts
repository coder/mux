/**
 * Integration test for thinking level persistence across model switches.
 */

import { fireEvent, waitFor, within } from "@testing-library/react";

import { CUSTOM_EVENTS } from "@/common/constants/events";
import { getModelKey, getThinkingLevelKey } from "@/common/constants/storage";
import { readPersistedState } from "@/browser/hooks/usePersistedState";

import { shouldRunIntegrationTests } from "../testUtils";
import { createAppHarness } from "./harness";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

const CODEX_MODEL = "openai:gpt-5.2-codex";
const OPUS_MODEL = "anthropic:claude-opus-4-5";

async function openModelSelector(container: HTMLElement): Promise<HTMLInputElement> {
  window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_MODEL_SELECTOR));

  return await waitFor(() => {
    const input = container.querySelector<HTMLInputElement>(
      'input[placeholder="provider:model-name"]'
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

  fireEvent.change(input, { target: { value: model } });

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
}

async function setThinkingToMax(container: HTMLElement): Promise<void> {
  const steps = ["low", "medium", "high", "xhigh"] as const;

  for (const level of steps) {
    fireEvent.keyDown(window, { key: "T", ctrlKey: true, shiftKey: true });
    await expectThinkingLabel(container, level);
  }
}

async function expectThinkingLabel(container: HTMLElement, expected: string): Promise<void> {
  await waitFor(() => {
    const label = container.querySelector('[data-component="ThinkingSliderGroup"] button span');
    const text = label?.textContent?.trim();
    if (text !== expected) {
      throw new Error(`Expected thinking label ${expected} but got ${text ?? "<missing>"}`);
    }
  });
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

      const persistedThinking = readPersistedState(getThinkingLevelKey(harness.workspaceId), "off");
      expect(persistedThinking).toBe("xhigh");

      await selectModel(harness.view.container, harness.workspaceId, CODEX_MODEL);
      await expectThinkingLabel(harness.view.container, "xhigh");
    } finally {
      await harness.dispose();
    }
  }, 90_000);
});

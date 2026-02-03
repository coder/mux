import { describe, expect, test } from "bun:test";
import { checkContextSwitch } from "./contextSwitchCheck";
import { getEffectiveContextLimit } from "./contextLimit";

const OPTIONS = { providersConfig: null, policy: null };

describe("checkContextSwitch", () => {
  test("returns null when target model matches previous model", () => {
    const targetModel = "openai:gpt-5.2-codex";
    const limit = getEffectiveContextLimit(targetModel, false);
    expect(limit).not.toBeNull();
    if (!limit) return;

    const warning = checkContextSwitch(
      Math.floor(limit * 0.95),
      targetModel,
      targetModel,
      false,
      OPTIONS
    );
    expect(warning).toBeNull();
  });

  test("allows same-model warnings when the effective limit changes", () => {
    const targetModel = "anthropic:claude-sonnet-4-5";
    const baseLimit = getEffectiveContextLimit(targetModel, false);
    const expandedLimit = getEffectiveContextLimit(targetModel, true);
    expect(baseLimit).not.toBeNull();
    expect(expandedLimit).not.toBeNull();
    if (!baseLimit || !expandedLimit) return;

    expect(expandedLimit).toBeGreaterThan(baseLimit);

    const warning = checkContextSwitch(
      Math.floor(baseLimit * 0.95),
      targetModel,
      targetModel,
      false,
      OPTIONS,
      { allowSameModel: true }
    );
    expect(warning).not.toBeNull();
    expect(warning?.targetModel).toBe(targetModel);
  });

  test("returns warning when switching to a smaller context model", () => {
    const targetModel = "openai:gpt-5.2-codex";
    const limit = getEffectiveContextLimit(targetModel, false);
    expect(limit).not.toBeNull();
    if (!limit) return;

    const warning = checkContextSwitch(
      Math.floor(limit * 0.95),
      targetModel,
      "anthropic:claude-sonnet-4-5",
      false,
      OPTIONS
    );
    expect(warning).not.toBeNull();
    expect(warning?.targetModel).toBe(targetModel);
  });
});

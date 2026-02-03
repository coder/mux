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

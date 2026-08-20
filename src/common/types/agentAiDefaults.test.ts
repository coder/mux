import { describe, expect, test } from "bun:test";
import { normalizeAgentAiDefaults } from "./agentAiDefaults";
import { normalizeSubagentAiDefaults } from "./tasks";

describe("normalizeAgentAiDefaults reasoningMode", () => {
  test("keeps an entry that only sets reasoningMode", () => {
    const result = normalizeAgentAiDefaults({ exec: { reasoningMode: "pro" } });
    expect(result.exec?.reasoningMode).toBe("pro");
  });

  test("drops an invalid reasoningMode and the then-empty entry", () => {
    const result = normalizeAgentAiDefaults({ exec: { reasoningMode: "ultra" } });
    expect(result.exec).toBeUndefined();
  });

  test("drops an invalid reasoningMode while keeping other fields", () => {
    const result = normalizeAgentAiDefaults({
      exec: { modelString: "openai:gpt-5.6-sol", reasoningMode: "ultra" },
    });
    expect(result.exec?.modelString).toBe("openai:gpt-5.6-sol");
    expect(result.exec?.reasoningMode).toBeUndefined();
  });
});

describe("normalizeSubagentAiDefaults reasoningMode", () => {
  test("keeps an entry that only sets reasoningMode", () => {
    const result = normalizeSubagentAiDefaults({ explore: { reasoningMode: "pro" } });
    expect(result.explore?.reasoningMode).toBe("pro");
  });

  test("drops an invalid reasoningMode and the then-empty entry", () => {
    const result = normalizeSubagentAiDefaults({ explore: { reasoningMode: "ultra" } });
    expect(result.explore).toBeUndefined();
  });
});

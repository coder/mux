import { describe, expect, test } from "bun:test";

import { formatModelBreakdownLabel } from "./StatsTab";

describe("formatModelBreakdownLabel", () => {
  test("prefers agentId over mode", () => {
    expect(
      formatModelBreakdownLabel({ model: "openai:gpt-4o", mode: "exec", agentId: "explore" })
    ).toBe("openai:gpt-4o (explore)");
  });

  test("falls back to mode when agentId is missing", () => {
    expect(formatModelBreakdownLabel({ model: "openai:gpt-4o", mode: "plan" })).toBe(
      "openai:gpt-4o (plan)"
    );
  });

  test("shows model only when no split label is available", () => {
    expect(formatModelBreakdownLabel({ model: "openai:gpt-4o" })).toBe("openai:gpt-4o");
  });
});

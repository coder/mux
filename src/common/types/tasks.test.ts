import { describe, expect, test } from "bun:test";

import { DEFAULT_TASK_SETTINGS, TASK_SETTINGS_LIMITS, normalizeTaskSettings } from "./tasks";

describe("normalizeTaskSettings", () => {
  test("fills defaults when missing", () => {
    expect(normalizeTaskSettings(undefined)).toEqual(DEFAULT_TASK_SETTINGS);
    expect(normalizeTaskSettings({})).toEqual(DEFAULT_TASK_SETTINGS);
  });

  test("defaults include preserveSubagentsUntilArchive: false", () => {
    const normalized = normalizeTaskSettings(undefined);
    expect(normalized.preserveSubagentsUntilArchive).toBe(false);
  });

  test("explicit preserveSubagentsUntilArchive true survives normalization", () => {
    const normalized = normalizeTaskSettings({ preserveSubagentsUntilArchive: true });
    expect(normalized.preserveSubagentsUntilArchive).toBe(true);
  });

  test("missing preserveSubagentsUntilArchive falls back to default", () => {
    const normalized = normalizeTaskSettings({});
    expect(normalized.preserveSubagentsUntilArchive).toBe(false);
  });

  test("clamps values into valid ranges", () => {
    const normalized = normalizeTaskSettings({
      maxParallelAgentTasks: 999,
      maxTaskNestingDepth: 0,
    });

    expect(normalized.maxParallelAgentTasks).toBe(TASK_SETTINGS_LIMITS.maxParallelAgentTasks.max);
    expect(normalized.maxTaskNestingDepth).toBe(TASK_SETTINGS_LIMITS.maxTaskNestingDepth.min);
  });

  test("uses fallbacks for NaN", () => {
    const normalized = normalizeTaskSettings({
      maxParallelAgentTasks: Number.NaN,
      maxTaskNestingDepth: Number.NaN,
    });

    expect(normalized).toEqual(DEFAULT_TASK_SETTINGS);
  });

  test("preserves explicit planSubagentExecutorRouting values", () => {
    const normalized = normalizeTaskSettings({
      planSubagentExecutorRouting: "auto",
    });

    expect(normalized.planSubagentExecutorRouting).toBe("auto");
    expect(normalized.planSubagentDefaultsToOrchestrator).toBe(false);
  });

  test("migrates deprecated planSubagentDefaultsToOrchestrator when routing is unset", () => {
    expect(
      normalizeTaskSettings({
        planSubagentDefaultsToOrchestrator: true,
      }).planSubagentExecutorRouting
    ).toBe("orchestrator");

    expect(
      normalizeTaskSettings({
        planSubagentDefaultsToOrchestrator: false,
      }).planSubagentExecutorRouting
    ).toBe("exec");
  });

  test("prefers planSubagentExecutorRouting when both new and deprecated fields are set", () => {
    const normalized = normalizeTaskSettings({
      planSubagentExecutorRouting: "exec",
      planSubagentDefaultsToOrchestrator: true,
    });

    expect(normalized.planSubagentExecutorRouting).toBe("exec");
    expect(normalized.planSubagentDefaultsToOrchestrator).toBe(false);
  });
});

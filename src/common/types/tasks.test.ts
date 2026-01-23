import { describe, expect, test } from "bun:test";

import {
  DEFAULT_TASK_SETTINGS,
  SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS,
  TASK_SETTINGS_LIMITS,
  normalizeTaskSettings,
} from "./tasks";

describe("normalizeTaskSettings", () => {
  test("fills defaults when missing", () => {
    expect(normalizeTaskSettings(undefined)).toEqual(DEFAULT_TASK_SETTINGS);
    expect(normalizeTaskSettings({})).toEqual(DEFAULT_TASK_SETTINGS);
  });

  test("clamps values into valid ranges", () => {
    const normalized = normalizeTaskSettings({
      maxParallelAgentTasks: 999,
      maxTaskNestingDepth: 0,
      bashOutputCompactionMinLines: -1,
      bashOutputCompactionMinTotalBytes: 999999999999,
      bashOutputCompactionMaxKeptLines: 0,
      bashOutputCompactionTimeoutMs: 0,
    });

    expect(normalized.maxParallelAgentTasks).toBe(TASK_SETTINGS_LIMITS.maxParallelAgentTasks.max);
    expect(normalized.maxTaskNestingDepth).toBe(TASK_SETTINGS_LIMITS.maxTaskNestingDepth.min);

    expect(normalized.bashOutputCompactionMinLines).toBe(
      SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinLines.min
    );
    expect(normalized.bashOutputCompactionMinTotalBytes).toBe(
      SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinTotalBytes.max
    );
    expect(normalized.bashOutputCompactionMaxKeptLines).toBe(
      SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMaxKeptLines.min
    );
    expect(normalized.bashOutputCompactionTimeoutMs).toBe(
      SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionTimeoutMs.min
    );
  });

  test("uses fallbacks for NaN", () => {
    const normalized = normalizeTaskSettings({
      maxParallelAgentTasks: Number.NaN,
      maxTaskNestingDepth: Number.NaN,
      bashOutputCompactionMinLines: Number.NaN,
      bashOutputCompactionMinTotalBytes: Number.NaN,
      bashOutputCompactionMaxKeptLines: Number.NaN,
      bashOutputCompactionTimeoutMs: Number.NaN,
    });

    expect(normalized).toEqual(DEFAULT_TASK_SETTINGS);
  });
});

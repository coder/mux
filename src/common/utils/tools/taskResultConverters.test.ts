import { describe, expect, test } from "bun:test";

import {
  coerceBashToolResult,
  convertTaskBashResult,
  isBashToolResult,
} from "./taskResultConverters";

import type { BashToolResult } from "@/common/types/tools";

describe("taskResultConverters", () => {
  test("convertTaskBashResult returns null for null/undefined", () => {
    expect(convertTaskBashResult(null)).toBeNull();
    expect(convertTaskBashResult(undefined)).toBeNull();
  });

  test("convertTaskBashResult maps explicit {success:false,error} shape", () => {
    expect(convertTaskBashResult({ success: false, error: "boom" })).toEqual({
      success: false,
      error: "boom",
      exitCode: -1,
      wall_duration_ms: 0,
    });

    expect(convertTaskBashResult({ success: false })).toEqual({
      success: false,
      error: "Task failed",
      exitCode: -1,
      wall_duration_ms: 0,
    });
  });

  test("convertTaskBashResult prefers structured bashResult", () => {
    const bashResult: BashToolResult = {
      success: true,
      output: "hello",
      exitCode: 0,
      wall_duration_ms: 12,
    };

    expect(
      convertTaskBashResult({
        status: "completed",
        bashResult,
      })
    ).toBe(bashResult);
  });

  test("convertTaskBashResult synthesizes background result from bash: taskId", () => {
    expect(
      convertTaskBashResult({
        status: "running",
        taskId: "bash:proc-123",
      })
    ).toEqual({
      success: true,
      output: "",
      exitCode: 0,
      wall_duration_ms: 0,
      backgroundProcessId: "proc-123",
    });
  });

  test("convertTaskBashResult parses legacy reportMarkdown", () => {
    expect(
      convertTaskBashResult({
        status: "completed",
        reportMarkdown: "exitCode: 42\nwall_duration_ms: 7\n```text\nhi\n```\nerror: nope",
      })
    ).toEqual({
      success: false,
      output: "hi",
      exitCode: 42,
      error: "nope",
      wall_duration_ms: 7,
      note: undefined,
      truncated: undefined,
    });
  });

  test("convertTaskBashResult legacy success semantics can treat error: line as failure", () => {
    // Desktop semantics: success iff exitCode===0
    expect(
      convertTaskBashResult({
        status: "completed",
        reportMarkdown: "exitCode: 0\nerror: still bad",
      })
    ).toEqual({
      success: true,
      output: "",
      exitCode: 0,
      wall_duration_ms: 0,
      note: undefined,
      truncated: undefined,
    });

    // Mobile semantics: success iff exitCode===0 AND no `error:` line
    expect(
      convertTaskBashResult(
        {
          status: "completed",
          reportMarkdown: "exitCode: 0\nerror: still bad",
        },
        { legacySuccessCheckInclErrorLine: true }
      )
    ).toEqual({
      success: false,
      output: undefined,
      exitCode: 0,
      error: "still bad",
      wall_duration_ms: 0,
      note: undefined,
      truncated: undefined,
    });
  });

  test("isBashToolResult/coerceBashToolResult detect minimal bash result shape", () => {
    expect(
      isBashToolResult({
        success: true,
        output: "x",
        exitCode: 0,
        wall_duration_ms: 1,
      })
    ).toBe(true);

    expect(isBashToolResult({ success: "true" })).toBe(false);

    const obj: BashToolResult = {
      success: false,
      error: "nope",
      exitCode: 1,
      wall_duration_ms: 1,
    };

    expect(coerceBashToolResult(obj)).toBe(obj);
    expect(coerceBashToolResult(null)).toBeNull();
  });
});

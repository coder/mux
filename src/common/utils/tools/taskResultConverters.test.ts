import { describe, it, expect } from "@jest/globals";

import { coerceBashToolResult } from "./taskResultConverters";

describe("coerceBashToolResult", () => {
  it("accepts legacy background results with only backgroundProcessId", () => {
    const result = coerceBashToolResult({
      success: true,
      output: "started",
      exitCode: 0,
      wall_duration_ms: 1,
      backgroundProcessId: "proc-123",
    });

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      success: true,
      backgroundProcessId: "proc-123",
      taskId: "bash:proc-123",
    });
  });

  it("accepts legacy background results with only taskId", () => {
    const result = coerceBashToolResult({
      success: true,
      output: "started",
      exitCode: 0,
      wall_duration_ms: 1,
      taskId: "bash:proc-456",
    });

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      success: true,
      backgroundProcessId: "proc-456",
      taskId: "bash:proc-456",
    });
  });

  it("rejects backgroundProcessId when not a string", () => {
    const result = coerceBashToolResult({
      success: true,
      output: "started",
      exitCode: 0,
      wall_duration_ms: 1,
      // legacy sessions should never do this; ensure we fail closed
      backgroundProcessId: 123,
    });

    expect(result).toBeNull();
  });
});

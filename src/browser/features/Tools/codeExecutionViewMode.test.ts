import { describe, expect, test } from "bun:test";
import { resolveCodeExecutionViewMode } from "./codeExecutionViewMode";

describe("resolveCodeExecutionViewMode", () => {
  test("uses the code view immediately for successful completed executions with no nested tools", () => {
    expect(
      resolveCodeExecutionViewMode("tools", {
        isComplete: true,
        hasToolCalls: false,
        noToolCallsDefaultView: "code",
      })
    ).toBe("code");
  });

  test("uses the result view immediately for failed completed executions with no nested tools", () => {
    expect(
      resolveCodeExecutionViewMode("tools", {
        isComplete: true,
        hasToolCalls: false,
        noToolCallsDefaultView: "result",
      })
    ).toBe("result");
  });

  test("keeps tools selected while nested tools exist or execution is still active", () => {
    expect(
      resolveCodeExecutionViewMode("tools", {
        isComplete: true,
        hasToolCalls: true,
        noToolCallsDefaultView: "code",
      })
    ).toBe("tools");
    expect(
      resolveCodeExecutionViewMode("tools", {
        isComplete: false,
        hasToolCalls: false,
        noToolCallsDefaultView: "code",
      })
    ).toBe("tools");
  });
});

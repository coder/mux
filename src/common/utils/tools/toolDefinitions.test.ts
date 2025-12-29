import { TaskToolArgsSchema, TOOL_DEFINITIONS } from "./toolDefinitions";

describe("TOOL_DEFINITIONS", () => {
  it("accepts custom subagent_type IDs (deprecated alias)", () => {
    const parsed = TaskToolArgsSchema.safeParse({
      subagent_type: "potato",
      prompt: "do the thing",
      title: "Test",
      run_in_background: true,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.subagent_type).toBe("potato");
    }
  });

  it("asks for clarification via ask_user_question (instead of emitting open questions)", () => {
    expect(TOOL_DEFINITIONS.ask_user_question.description).toContain(
      "MUST be used when you need user clarification"
    );
    expect(TOOL_DEFINITIONS.ask_user_question.description).toContain(
      "Do not output a list of open questions"
    );
  });

  it("rejects task(kind=bash) tool calls (bash is a separate tool)", () => {
    const parsed = TOOL_DEFINITIONS.task.schema.safeParse({
      // Legacy shape; should not validate against the current task schema.
      kind: "bash",
      script: "ls",
      timeout_secs: 100000,
      run_in_background: false,
    });

    expect(parsed.success).toBe(false);
  });

  it("discourages repeating plan contents or plan file location after propose_plan", () => {
    expect(TOOL_DEFINITIONS.propose_plan.description).toContain("do not paste the plan contents");
    expect(TOOL_DEFINITIONS.propose_plan.description).toContain("plan file path");
  });
});

import { TOOL_DEFINITIONS } from "./toolDefinitions";

describe("TOOL_DEFINITIONS", () => {
  it("asks for clarification via ask_user_question (instead of emitting open questions)", () => {
    expect(TOOL_DEFINITIONS.ask_user_question.description).toContain(
      "MUST be used when you need user clarification"
    );
    expect(TOOL_DEFINITIONS.ask_user_question.description).toContain(
      "Do not output a list of open questions"
    );
  });

  it("allows task(kind=bash) without display_name", () => {
    const parsed = TOOL_DEFINITIONS.task.schema.safeParse({
      kind: "bash",
      script: "ls",
      timeout_secs: 100000,
      run_in_background: false,
    });

    expect(parsed.success).toBe(true);
  });

  it("discourages repeating plan contents or plan file location after propose_plan", () => {
    expect(TOOL_DEFINITIONS.propose_plan.description).toContain("do not paste the plan contents");
    expect(TOOL_DEFINITIONS.propose_plan.description).toContain("plan file path");
  });
});

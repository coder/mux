import { getPlanModeInstruction } from "./modeUtils";

describe("getPlanModeInstruction", () => {
  it("includes instructions to use ask_user_question (and avoid post-propose_plan clutter)", () => {
    const instruction = getPlanModeInstruction("/tmp/plan.md", false);

    expect(instruction).toContain("MUST use the ask_user_question tool");
    expect(instruction).toContain('Do not include an "Open Questions" section');

    // UI already renders the plan + plan file location, so the agent should not repeat them in chat.
    expect(instruction).toContain("do not repeat/paste the plan contents");
    expect(instruction).toContain('do not say "the plan is ready at <path>"');
  });
});

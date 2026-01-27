import { getPlanFileHint, getPlanModeInstruction } from "./modeUtils";

describe("getPlanModeInstruction", () => {
  it("provides plan file path context", () => {
    const instruction = getPlanModeInstruction("/tmp/plan.md", false);

    expect(instruction).toContain("Plan file path: /tmp/plan.md");
    expect(instruction).toContain("No plan file exists yet");
    expect(instruction).toContain("file_edit_* tools");
  });

  it("indicates when plan file already exists", () => {
    const instruction = getPlanModeInstruction("/tmp/existing-plan.md", true);

    expect(instruction).toContain("Plan file path: /tmp/existing-plan.md");
    expect(instruction).toContain("A plan file already exists");
    expect(instruction).toContain("read it to determine if it's relevant");
  });

  it("includes instructions to use ask_user_question (and avoid post-propose_plan clutter)", () => {
    const instruction = getPlanModeInstruction("/tmp/plan.md", false);

    expect(instruction).toContain("MUST use the ask_user_question tool");
    expect(instruction).toContain('Do not include an "Open Questions" section');

    // UI already renders the plan + plan file location, so the agent should not repeat them in chat.
    expect(instruction).toContain("do not repeat/paste the plan contents");
    expect(instruction).toContain('do not say "the plan is ready at <path>"');
  });

  it("includes sub-agent delegation guidance", () => {
    const instruction = getPlanModeInstruction("/tmp/plan.md", false);

    expect(instruction).toContain("Trust Explore sub-agent reports as authoritative");
    expect(instruction).toContain('MUST ONLY spawn `agentId: "explore"` tasks');
    expect(instruction).toContain("Do NOT call `propose_plan` until");
  });
});

describe("getPlanFileHint", () => {
  it("returns null when the plan file does not exist", () => {
    expect(getPlanFileHint("/tmp/plan.md", false)).toBeNull();
  });

  it("includes post-compaction guidance and an ignore escape hatch", () => {
    const hint = getPlanFileHint("/tmp/plan.md", true);

    if (!hint) throw new Error("expected non-null hint");

    expect(hint).toContain("A plan file exists at: /tmp/plan.md");
    expect(hint).toContain("compaction/context reset");
    expect(hint).toContain("If it is unrelated to the current request, ignore it.");
  });
});

import { getPlanFileHint, getPlanModeInstruction } from "./modeUtils";

describe("getPlanModeInstruction", () => {
  it("threads the exact plan file path through both creation and resume flows", () => {
    const newPlanInstruction = getPlanModeInstruction("/tmp/plan.md", false);
    const existingPlanInstruction = getPlanModeInstruction("/tmp/plan.md", true);

    expect(newPlanInstruction).toContain("/tmp/plan.md");
    expect(existingPlanInstruction).toContain("/tmp/plan.md");
    expect(newPlanInstruction).not.toEqual(existingPlanInstruction);
  });
});

describe("getPlanFileHint", () => {
  it("returns null when the plan file does not exist", () => {
    expect(getPlanFileHint("/tmp/plan.md", false)).toBeNull();
  });

  it("returns a non-null hint keyed to the saved plan path", () => {
    const hint = getPlanFileHint("/tmp/plan.md", true);

    expect(hint).not.toBeNull();
    expect(hint).toContain("/tmp/plan.md");
  });
});

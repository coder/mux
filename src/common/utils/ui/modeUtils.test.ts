import { getPlanFileHint, getPlanModeInstruction } from "./modeUtils";

describe("getPlanModeInstruction", () => {
  it("provides plan file path context", () => {
    const instruction = getPlanModeInstruction("/tmp/plan.md", false);

    expect(instruction).toContain("Plan file path: /tmp/plan.md");
    expect(instruction).toContain("No plan file exists yet");
    expect(instruction).toContain("file_edit_* tools");
  });

  it("routes ambiguous Explore reports to another narrow Explore task", () => {
    const instruction = getPlanModeInstruction("/tmp/plan.md", false);

    expect(instruction).toContain("Anti-pattern: using `file_read` or `bash` in Plan Mode");
    expect(instruction).toContain("spawn another narrowly focused Explore task instead");
    expect(instruction).toContain("plan file itself");
    expect(instruction).toContain("user-provided text already in this conversation");
    expect(instruction).toContain("task delegation is unavailable in this workspace");
    expect(instruction).toContain("use the narrowest read-only investigation needed");
    expect(instruction).not.toContain(
      "only re-check if the report is ambiguous or contradicts other evidence"
    );
  });

  it("indicates when plan file already exists", () => {
    const instruction = getPlanModeInstruction("/tmp/existing-plan.md", true);

    expect(instruction).toContain("Plan file path: /tmp/existing-plan.md");
    expect(instruction).toContain("A plan file already exists");
    expect(instruction).toContain("read it to determine if it's relevant");
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

import { parseGitRevList, parseGitShowBranchForStatus } from "./parseGitStatus";

// Base result shape with zero line deltas (parseGitRevList doesn't compute these)
const base = {
  dirty: false,
  outgoingAdditions: 0,
  outgoingDeletions: 0,
  incomingAdditions: 0,
  incomingDeletions: 0,
};

describe("parseGitRevList", () => {
  test("parses valid ahead and behind counts", () => {
    expect(parseGitRevList("5\t3")).toEqual({ ...base, ahead: 5, behind: 3 });
    expect(parseGitRevList("0\t0")).toEqual({ ...base, ahead: 0, behind: 0 });
    expect(parseGitRevList("10\t0")).toEqual({ ...base, ahead: 10, behind: 0 });
    expect(parseGitRevList("0\t7")).toEqual({ ...base, ahead: 0, behind: 7 });
  });

  test("handles whitespace variations", () => {
    expect(parseGitRevList("  5\t3  ")).toEqual({ ...base, ahead: 5, behind: 3 });
    expect(parseGitRevList("5  3")).toEqual({ ...base, ahead: 5, behind: 3 });
    expect(parseGitRevList("5   3")).toEqual({ ...base, ahead: 5, behind: 3 });
  });

  test("returns null for invalid formats", () => {
    expect(parseGitRevList("")).toBe(null);
    expect(parseGitRevList("5")).toBe(null);
    expect(parseGitRevList("5\t3\t1")).toBe(null);
    expect(parseGitRevList("abc\tdef")).toBe(null);
    expect(parseGitRevList("5\tabc")).toBe(null);
    expect(parseGitRevList("abc\t3")).toBe(null);
  });

  test("returns null for empty or whitespace-only input", () => {
    expect(parseGitRevList("")).toBe(null);
    expect(parseGitRevList("   ")).toBe(null);
    expect(parseGitRevList("\n")).toBe(null);
    expect(parseGitRevList("\t")).toBe(null);
  });
});

function makeBehindCommitLines(count: number): string {
  return Array.from({ length: count }, (_, i) => ` + [${i + 1}] behind commit ${i + 1}`).join("\n");
}

describe("parseGitShowBranchForStatus", () => {
  test("parses 2-branch output correctly", () => {
    const output = `! [HEAD] feat: add feature
 ! [origin/main] fix: bug fix
--
+  [cf9cbfb7] feat: add feature
++ [306f4968] fix: bug fix`;

    const result = parseGitShowBranchForStatus(output);
    expect(result).not.toBeNull();
    expect(result!.ahead).toBe(1);
    expect(result!.behind).toBe(0);
  });

  test("parses 2-branch output with behind commits", () => {
    const output = `! [HEAD] feat: add feature
 ! [origin/main] latest on main
--
+  [cf9cbfb7] feat: add feature
${makeBehindCommitLines(9)}
++ [base] common ancestor`;

    const result = parseGitShowBranchForStatus(output);
    expect(result).not.toBeNull();
    expect(result!.ahead).toBe(1);
    expect(result!.behind).toBe(9);
  });

  test("handles 3-branch output (misuse case)", () => {
    // This tests what happens if 3-branch output is accidentally fed to the parser.
    // The parser uses columns 0 and 1, ignoring column 2.
    const output = `! [HEAD] feat: add feature
 ! [origin/main] fix: bug fix
  ! [origin/feature] feat: add feature
---
+ + [cf9cbfb7] feat: add feature
 ++ [306f4968] fix: bug fix`;

    // With 3 columns: "+ +" means col0='+', col1=' ', col2='+'
    // Parser sees col0='+', col1=' ' -> ahead
    // With 3 columns: " ++" means col0=' ', col1='+', col2='+'
    // Parser sees col0=' ', col1='+' -> behind
    const result = parseGitShowBranchForStatus(output);
    expect(result).not.toBeNull();
    expect(result!.ahead).toBe(1); // "+ +" has col0='+', col1=' '
    expect(result!.behind).toBe(1); // " ++" has col0=' ', col1='+'
  });
});

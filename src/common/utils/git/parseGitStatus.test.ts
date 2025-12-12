import { parseGitRevList } from "./parseGitStatus";

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

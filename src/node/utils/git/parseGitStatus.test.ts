import { parseGitRevList } from "./parseGitStatus";

describe("parseGitRevList", () => {
  test("parses valid ahead and behind counts", () => {
    expect(parseGitRevList("5\t3")).toEqual({ ahead: 5, behind: 3, dirty: false });
    expect(parseGitRevList("0\t0")).toEqual({ ahead: 0, behind: 0, dirty: false });
    expect(parseGitRevList("10\t0")).toEqual({ ahead: 10, behind: 0, dirty: false });
    expect(parseGitRevList("0\t7")).toEqual({ ahead: 0, behind: 7, dirty: false });
  });

  test("handles whitespace variations", () => {
    expect(parseGitRevList("  5\t3  ")).toEqual({ ahead: 5, behind: 3, dirty: false });
    expect(parseGitRevList("5  3")).toEqual({ ahead: 5, behind: 3, dirty: false });
    expect(parseGitRevList("5   3")).toEqual({ ahead: 5, behind: 3, dirty: false });
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

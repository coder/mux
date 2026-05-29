import { describe, it, expect } from "bun:test";
import { parseNameStatus } from "./nameStatusParser";

describe("parseNameStatus", () => {
  it("parses added/modified/deleted entries", () => {
    const output = ["A\tnew.ts", "M\tsrc/changed.ts", "D\told.ts"].join("\n");

    expect(parseNameStatus(output)).toEqual([
      { filePath: "new.ts", changeType: "added" },
      { filePath: "src/changed.ts", changeType: "modified" },
      { filePath: "old.ts", changeType: "deleted" },
    ]);
  });

  it("parses copied entries", () => {
    const output = "C100\tsrc/orig.ts\tsrc/copy.ts\n";

    expect(parseNameStatus(output)).toEqual([
      { filePath: "src/copy.ts", oldPath: "src/orig.ts", changeType: "added" },
    ]);
  });
  it("parses renamed entries", () => {
    const output = "R100\tsrc/old.ts\tsrc/new.ts\n";

    expect(parseNameStatus(output)).toEqual([
      { filePath: "src/new.ts", oldPath: "src/old.ts", changeType: "renamed" },
    ]);
  });

  it("dedupes by changeType precedence", () => {
    const output = [
      "M\tsame.ts",
      "D\tsame.ts",
      "A\tother.ts",
      "M\tother.ts",
      "R100\tfrom.ts\tother.ts",
    ].join("\n");

    // deleted > added > renamed > modified
    expect(parseNameStatus(output)).toEqual([
      { filePath: "same.ts", changeType: "deleted" },
      { filePath: "other.ts", changeType: "added" },
    ]);
  });
});

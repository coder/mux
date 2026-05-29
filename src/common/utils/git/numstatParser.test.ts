import { describe, expect, test } from "bun:test";
import { extractNewPath } from "./numstatParser";

describe("extractNewPath", () => {
  test("returns unchanged path for normal files", () => {
    expect(extractNewPath("src/foo.ts")).toBe("src/foo.ts");
    expect(extractNewPath("file.txt")).toBe("file.txt");
    expect(extractNewPath("dir/subdir/file.js")).toBe("dir/subdir/file.js");
  });

  test("extracts new path from plain arrow syntax", () => {
    expect(extractNewPath("helpers.ts => helpers-renamed.ts")).toBe("helpers-renamed.ts");
    expect(extractNewPath("src/helpers.ts => src/helpers-renamed.ts")).toBe(
      "src/helpers-renamed.ts"
    );
  });
  test("extracts new path from rename syntax", () => {
    expect(extractNewPath("{old.ts => new.ts}")).toBe("new.ts");
    expect(extractNewPath("src/{old.ts => new.ts}")).toBe("src/new.ts");
    expect(extractNewPath("src/components/{ChatMetaSidebar.tsx => RightSidebar.tsx}")).toBe(
      "src/components/RightSidebar.tsx"
    );
  });

  test("handles rename with directory prefix and suffix", () => {
    expect(extractNewPath("src/{foo => bar}/file.ts")).toBe("src/bar/file.ts");
    expect(extractNewPath("{a => b}/c/d.ts")).toBe("b/c/d.ts");
  });

  test("handles complex paths", () => {
    expect(extractNewPath("very/long/path/{oldname.tsx => newname.tsx}")).toBe(
      "very/long/path/newname.tsx"
    );
  });
});

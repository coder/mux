import { describe, expect, test } from "bun:test";

import { getDefaultBashDisplayName, resolveBashDisplayName } from "./bashDisplayName";

describe("bashDisplayName", () => {
  test("getDefaultBashDisplayName derives from first non-empty line", () => {
    expect(getDefaultBashDisplayName("\n\n  echo   hi\n")).toBe("echo hi");
  });

  test("getDefaultBashDisplayName falls back to 'bash' when script is empty", () => {
    expect(getDefaultBashDisplayName("\n\n\n")).toBe("bash");
  });

  test("resolveBashDisplayName sanitizes user-provided display_name", () => {
    expect(resolveBashDisplayName("echo hi", "dev/server"))
      // Slash is invalid in filenames and must not create path segments.
      .toBe("dev_server");
  });

  test("resolveBashDisplayName strips trailing dots/spaces", () => {
    expect(resolveBashDisplayName("echo hi", "name. ")).toBe("name");
  });

  test("resolveBashDisplayName falls back to script-derived name when display_name is empty", () => {
    expect(resolveBashDisplayName("echo hi", "   ")).toBe("echo hi");
  });

  test("resolveBashDisplayName rejects dot segments", () => {
    expect(resolveBashDisplayName("echo hi", ".."))
      // Dot segments are rejected (even without path separators) to avoid ambiguity.
      .toBe("bash");
  });
});

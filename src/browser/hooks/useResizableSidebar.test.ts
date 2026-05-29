import { describe, expect, test } from "bun:test";

import { resolveInitialResizableSidebarWidth } from "./useResizableSidebar";

describe("resolveInitialResizableSidebarWidth", () => {
  test("clamps stored widths above the temporary max instead of falling back to default", () => {
    expect(
      resolveInitialResizableSidebarWidth({
        storedValue: "900",
        defaultWidth: 400,
        minWidth: 300,
        maxWidth: 650,
      })
    ).toBe(650);
  });

  test("falls back to the default width when the stored value is malformed", () => {
    expect(
      resolveInitialResizableSidebarWidth({
        storedValue: '{"bad":true}',
        defaultWidth: 400,
        minWidth: 300,
        maxWidth: 650,
      })
    ).toBe(400);
  });

  test("clamps stored widths below the minimum", () => {
    expect(
      resolveInitialResizableSidebarWidth({
        storedValue: "200",
        defaultWidth: 400,
        minWidth: 300,
        maxWidth: 650,
      })
    ).toBe(300);
  });
});

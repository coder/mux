import { describe, expect, test } from "bun:test";
import * as path from "path";
import { resolveMuxUserDataDir } from "./userDataDir";

describe("resolveMuxUserDataDir", () => {
  test("prefers explicit MUX_USER_DATA_DIR", () => {
    const result = resolveMuxUserDataDir({
      muxUserDataDir: "/tmp/custom-user-data",
      muxRoot: "/tmp/mux-root",
      isE2E: true,
      muxHome: "/tmp/mux-home",
    });

    expect(result).toBe("/tmp/custom-user-data");
  });

  test("defaults to <muxHome>/user-data when muxRoot is set", () => {
    const result = resolveMuxUserDataDir({ muxRoot: "/tmp/mux-root", muxHome: "/tmp/mux-root" });
    expect(result).toBe(path.join("/tmp/mux-root", "user-data"));
  });

  test("defaults to <muxHome>/user-data when running E2E", () => {
    const result = resolveMuxUserDataDir({ isE2E: true, muxHome: "/tmp/mux-e2e" });
    expect(result).toBe(path.join("/tmp/mux-e2e", "user-data"));
  });

  test("returns undefined when no overrides", () => {
    const result = resolveMuxUserDataDir({});
    expect(result).toBeUndefined();
  });
});

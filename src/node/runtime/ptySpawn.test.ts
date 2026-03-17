import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { resolvePathEnv } from "./ptySpawn";

describe("resolvePathEnv", () => {
  test("prepends mux's vendored bin dir to explicit PATH overrides", () => {
    const env: NodeJS.ProcessEnv = { MUX_VENDORED_BIN_DIR: "/tmp/mux/bin" };

    expect(resolvePathEnv(env, `/usr/bin${path.delimiter}/bin`)).toBe(
      `/tmp/mux/bin${path.delimiter}/usr/bin${path.delimiter}/bin`
    );
  });

  test("does not duplicate mux's vendored bin dir", () => {
    const env: NodeJS.ProcessEnv = { MUX_VENDORED_BIN_DIR: "/tmp/mux/bin" };
    const existingPath = `/tmp/mux/bin${path.delimiter}/usr/bin${path.delimiter}/bin`;

    expect(resolvePathEnv(env, existingPath)).toBe(existingPath);
  });
});

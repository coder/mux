import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { sanitizeMuxChildEnv } from "./childProcessEnv";
import { resolvePathEnv } from "./ptySpawn";

describe("resolvePathEnv", () => {
  test("strips mux vendored bin directories from explicit PATH overrides", () => {
    const env: NodeJS.ProcessEnv = { MUX_VENDORED_BIN_DIR: "/tmp/mux/bin" };

    expect(resolvePathEnv(env, `/tmp/mux/bin${path.delimiter}/usr/bin${path.delimiter}/bin`)).toBe(
      `/usr/bin${path.delimiter}/bin`
    );
  });

  test("falls back to env PATH when no override is provided", () => {
    const env: NodeJS.ProcessEnv = { PATH: `/custom/bin${path.delimiter}/usr/bin` };

    expect(resolvePathEnv(env)).toBe(`/custom/bin${path.delimiter}/usr/bin`);
  });
});

describe("sanitizeMuxChildEnv", () => {
  test("removes mux-managed browser session env vars from child processes", () => {
    const env = sanitizeMuxChildEnv({
      PATH: `/tmp/mux/bin${path.delimiter}/usr/bin`,
      AGENT_BROWSER_SESSION: "mux-session",
      AGENT_BROWSER_STREAM_PORT: "9222",
      MUX_VENDORED_BIN_DIR: "/tmp/mux/bin",
    });

    expect(env.AGENT_BROWSER_SESSION).toBeUndefined();
    expect(env.AGENT_BROWSER_STREAM_PORT).toBeUndefined();
    expect(env.MUX_VENDORED_BIN_DIR).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });
});

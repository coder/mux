import { describe, expect, it } from "bun:test";
import { isIncompatibleRuntimeConfig } from "@/common/utils/runtimeCompatibility";
import { createRuntime, IncompatibleRuntimeError } from "./runtimeFactory";
import type { RuntimeConfig } from "@/common/types/runtime";

describe("isIncompatibleRuntimeConfig", () => {
  it("returns false for undefined config", () => {
    expect(isIncompatibleRuntimeConfig(undefined)).toBe(false);
  });

  it("returns false for valid local config with srcBaseDir", () => {
    const config: RuntimeConfig = {
      type: "local",
      srcBaseDir: "~/.mux/src",
    };
    expect(isIncompatibleRuntimeConfig(config)).toBe(false);
  });

  it("returns false for valid SSH config", () => {
    const config: RuntimeConfig = {
      type: "ssh",
      host: "example.com",
      srcBaseDir: "/home/user/mux",
    };
    expect(isIncompatibleRuntimeConfig(config)).toBe(false);
  });

  it("returns true for local config without srcBaseDir (future project-dir mode)", () => {
    // Simulate a config from a future version that has type: "local" without srcBaseDir
    // This bypasses TypeScript checks to simulate runtime data from newer versions
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const config = { type: "local" } as RuntimeConfig;
    expect(isIncompatibleRuntimeConfig(config)).toBe(true);
  });

  it("returns true for local config with empty srcBaseDir", () => {
    // Simulate a malformed config - empty srcBaseDir shouldn't be valid
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const config = { type: "local", srcBaseDir: "" } as RuntimeConfig;
    expect(isIncompatibleRuntimeConfig(config)).toBe(true);
  });

  it("returns true for unknown runtime type (future types like worktree)", () => {
    // Simulate a config from a future version with new type

    const config = { type: "worktree", srcBaseDir: "~/.mux/src" } as unknown as RuntimeConfig;
    expect(isIncompatibleRuntimeConfig(config)).toBe(true);
  });
});

describe("createRuntime", () => {
  it("creates LocalRuntime for valid local config", () => {
    const config: RuntimeConfig = {
      type: "local",
      srcBaseDir: "/tmp/test-src",
    };
    const runtime = createRuntime(config);
    expect(runtime).toBeDefined();
  });

  it("throws IncompatibleRuntimeError for local config without srcBaseDir", () => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const config = { type: "local" } as RuntimeConfig;
    expect(() => createRuntime(config)).toThrow(IncompatibleRuntimeError);
    expect(() => createRuntime(config)).toThrow(/newer version of mux/);
  });

  it("throws IncompatibleRuntimeError for unknown runtime type", () => {
    const config = { type: "worktree", srcBaseDir: "~/.mux/src" } as unknown as RuntimeConfig;
    expect(() => createRuntime(config)).toThrow(IncompatibleRuntimeError);
    expect(() => createRuntime(config)).toThrow(/newer version of mux/);
  });
});

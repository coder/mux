import { describe, expect, it } from "bun:test";
import { isIncompatibleRuntimeConfig } from "@/common/utils/runtimeCompatibility";
import { createRuntime, IncompatibleRuntimeError } from "./runtimeFactory";
import type { RuntimeConfig } from "@/common/types/runtime";
import { LocalRuntime } from "./LocalRuntime";
import { WorktreeRuntime } from "./WorktreeRuntime";

describe("isIncompatibleRuntimeConfig", () => {
  it("returns false for undefined config", () => {
    expect(isIncompatibleRuntimeConfig(undefined)).toBe(false);
  });

  it("returns false for local config with srcBaseDir (legacy worktree)", () => {
    const config: RuntimeConfig = {
      type: "local",
      srcBaseDir: "~/.mux/src",
    };
    expect(isIncompatibleRuntimeConfig(config)).toBe(false);
  });

  it("returns false for local config without srcBaseDir (project-dir mode)", () => {
    // Local without srcBaseDir is now supported as project-dir mode
    const config: RuntimeConfig = { type: "local" };
    expect(isIncompatibleRuntimeConfig(config)).toBe(false);
  });

  it("returns false for worktree config", () => {
    const config: RuntimeConfig = {
      type: "worktree",
      srcBaseDir: "~/.mux/src",
    };
    expect(isIncompatibleRuntimeConfig(config)).toBe(false);
  });

  it("returns false for SSH config", () => {
    const config: RuntimeConfig = {
      type: "ssh",
      host: "example.com",
      srcBaseDir: "/home/user/mux",
    };
    expect(isIncompatibleRuntimeConfig(config)).toBe(false);
  });

  it("returns true for unknown runtime type from future versions", () => {
    // Simulate a config from a future version with new type
    const config = { type: "future-runtime" } as unknown as RuntimeConfig;
    expect(isIncompatibleRuntimeConfig(config)).toBe(true);
  });
});

describe("createRuntime", () => {
  it("creates WorktreeRuntime for local config with srcBaseDir (legacy)", () => {
    const config: RuntimeConfig = {
      type: "local",
      srcBaseDir: "/tmp/test-src",
    };
    const runtime = createRuntime(config);
    expect(runtime).toBeInstanceOf(WorktreeRuntime);
  });

  it("creates LocalRuntime for local config without srcBaseDir (project-dir)", () => {
    const config: RuntimeConfig = { type: "local" };
    const runtime = createRuntime(config, { projectPath: "/tmp/my-project" });
    expect(runtime).toBeInstanceOf(LocalRuntime);
  });

  it("creates WorktreeRuntime for explicit worktree config", () => {
    const config: RuntimeConfig = {
      type: "worktree",
      srcBaseDir: "/tmp/test-src",
    };
    const runtime = createRuntime(config);
    expect(runtime).toBeInstanceOf(WorktreeRuntime);
  });

  it("throws error for local project-dir without projectPath option", () => {
    const config: RuntimeConfig = { type: "local" };
    expect(() => createRuntime(config)).toThrow(/projectPath/);
  });

  it("throws IncompatibleRuntimeError for unknown runtime type", () => {
    const config = { type: "future-runtime" } as unknown as RuntimeConfig;
    expect(() => createRuntime(config)).toThrow(IncompatibleRuntimeError);
    expect(() => createRuntime(config)).toThrow(/newer version of mux/);
  });
});

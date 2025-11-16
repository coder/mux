import { describe, expect, it } from "bun:test";
import * as os from "os";
import * as path from "path";
import { LocalRuntime } from "./LocalRuntime";

describe("LocalRuntime constructor", () => {
  it("should expand tilde in srcBaseDir", () => {
    const runtime = new LocalRuntime("~/workspace");
    const workspacePath = runtime.getWorkspacePath("/home/user/project", "branch");

    // The workspace path should use the expanded home directory
    const expected = path.join(os.homedir(), "workspace", "project", "branch");
    expect(workspacePath).toBe(expected);
  });

  it("should handle absolute paths without expansion", () => {
    const runtime = new LocalRuntime("/absolute/path");
    const workspacePath = runtime.getWorkspacePath("/home/user/project", "branch");

    const expected = path.join("/absolute/path", "project", "branch");
    expect(workspacePath).toBe(expected);
  });

  it("should handle bare tilde", () => {
    const runtime = new LocalRuntime("~");
    const workspacePath = runtime.getWorkspacePath("/home/user/project", "branch");

    const expected = path.join(os.homedir(), "project", "branch");
    expect(workspacePath).toBe(expected);
  });
});

describe("LocalRuntime.resolvePath", () => {
  it("should expand tilde to home directory", async () => {
    const runtime = new LocalRuntime("/tmp");
    const resolved = await runtime.resolvePath("~");
    expect(resolved).toBe(os.homedir());
  });

  it("should expand tilde with path", async () => {
    const runtime = new LocalRuntime("/tmp");
    // Use a path that likely exists (or use /tmp if ~ doesn't have subdirs)
    const resolved = await runtime.resolvePath("~/..");
    const expected = path.dirname(os.homedir());
    expect(resolved).toBe(expected);
  });

  it("should resolve absolute paths", async () => {
    const runtime = new LocalRuntime("/tmp");
    const resolved = await runtime.resolvePath("/tmp");
    expect(resolved).toBe("/tmp");
  });

  it("should resolve non-existent paths without checking existence", async () => {
    const runtime = new LocalRuntime("/tmp");
    const resolved = await runtime.resolvePath("/this/path/does/not/exist/12345");
    // Should resolve to absolute path without checking if it exists
    expect(resolved).toBe("/this/path/does/not/exist/12345");
  });

  it("should resolve relative paths from cwd", async () => {
    const runtime = new LocalRuntime("/tmp");
    const resolved = await runtime.resolvePath(".");
    // Should resolve to absolute path
    expect(path.isAbsolute(resolved)).toBe(true);
  });
});

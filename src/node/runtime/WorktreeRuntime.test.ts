import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import { WorktreeRuntime } from "./WorktreeRuntime";

describe("WorktreeRuntime constructor", () => {
  it("should expand tilde in srcBaseDir", () => {
    const runtime = new WorktreeRuntime("~/workspace");
    const workspacePath = runtime.getWorkspacePath("/home/user/project", "branch");

    // The workspace path should use the expanded home directory
    const expected = path.join(os.homedir(), "workspace", "project", "branch");
    expect(workspacePath).toBe(expected);
  });

  it("should handle absolute paths without expansion", () => {
    const runtime = new WorktreeRuntime("/absolute/path");
    const workspacePath = runtime.getWorkspacePath("/home/user/project", "branch");

    const expected = path.join("/absolute/path", "project", "branch");
    expect(workspacePath).toBe(expected);
  });

  it("should handle bare tilde", () => {
    const runtime = new WorktreeRuntime("~");
    const workspacePath = runtime.getWorkspacePath("/home/user/project", "branch");

    const expected = path.join(os.homedir(), "project", "branch");
    expect(workspacePath).toBe(expected);
  });
});

describe("WorktreeRuntime.resolvePath", () => {
  it("should expand tilde to home directory", async () => {
    const runtime = new WorktreeRuntime("/tmp");
    const resolved = await runtime.resolvePath("~");
    expect(resolved).toBe(os.homedir());
  });

  it("should expand tilde with path", async () => {
    const runtime = new WorktreeRuntime("/tmp");
    // Use a path that likely exists (or use /tmp if ~ doesn't have subdirs)
    const resolved = await runtime.resolvePath("~/..");
    const expected = path.dirname(os.homedir());
    expect(resolved).toBe(expected);
  });

  it("should resolve absolute paths", async () => {
    const runtime = new WorktreeRuntime("/tmp");
    const resolved = await runtime.resolvePath("/tmp");
    expect(resolved).toBe("/tmp");
  });

  it("should resolve non-existent paths without checking existence", async () => {
    const runtime = new WorktreeRuntime("/tmp");
    const resolved = await runtime.resolvePath("/this/path/does/not/exist/12345");
    // Should resolve to absolute path without checking if it exists
    expect(resolved).toBe("/this/path/does/not/exist/12345");
  });

  it("should resolve relative paths from cwd", async () => {
    const runtime = new WorktreeRuntime("/tmp");
    const resolved = await runtime.resolvePath(".");
    // Should resolve to absolute path
    expect(path.isAbsolute(resolved)).toBe(true);
  });
});

describe("WorktreeRuntime.exec bashrc sourcing", () => {
  // Use a temp directory as fake HOME with .mux/bashrc inside
  const testHome = path.join(os.tmpdir(), `mux-bashrc-test-${Date.now()}`);
  const testMuxDir = path.join(testHome, ".mux");
  const testBashrcPath = path.join(testMuxDir, "bashrc");
  const testWorkDir = path.join(os.tmpdir(), "mux-bashrc-workdir");

  beforeEach(async () => {
    // Create test directories
    await fs.mkdir(testMuxDir, { recursive: true });
    await fs.mkdir(testWorkDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up test files
    await fs.rm(testHome, { recursive: true, force: true });
    await fs.rm(testWorkDir, { recursive: true, force: true });
  });

  it("should source ~/.mux/bashrc and set environment variables", async () => {
    // Create a test bashrc that sets a unique environment variable
    const testEnvValue = `test_value_${Date.now()}`;
    await fs.writeFile(testBashrcPath, `export MUX_TEST_BASHRC_VAR="${testEnvValue}"\n`);

    const runtime = new WorktreeRuntime("/tmp");
    // Pass HOME as environment variable so the child process uses our test home
    const stream = await runtime.exec("echo $MUX_TEST_BASHRC_VAR", {
      cwd: testWorkDir,
      timeout: 5,
      env: { HOME: testHome },
    });

    // Read stdout
    const reader = stream.stdout.getReader();
    const decoder = new TextDecoder();
    let output = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();

    await stream.exitCode;

    // Should have the value set by our bashrc
    expect(output.trim()).toBe(testEnvValue);
  });

  it("should work silently when ~/.mux/bashrc doesn't exist", async () => {
    // Don't create bashrc - just have empty .mux dir
    await fs.rm(testBashrcPath, { force: true });

    const runtime = new WorktreeRuntime("/tmp");
    const stream = await runtime.exec("echo hello", {
      cwd: testWorkDir,
      timeout: 5,
      env: { HOME: testHome },
    });

    // Read stdout
    const reader = stream.stdout.getReader();
    const decoder = new TextDecoder();
    let output = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();

    const exitCode = await stream.exitCode;

    // Command should succeed with expected output
    expect(exitCode).toBe(0);
    expect(output.trim()).toBe("hello");
  });
});

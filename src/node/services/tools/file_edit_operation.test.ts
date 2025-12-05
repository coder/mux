import { describe, test, expect, jest } from "@jest/globals";
import * as fs from "fs/promises";
import * as path from "path";
import { executeFileEditOperation } from "./file_edit_operation";
import type { Runtime } from "@/node/runtime/Runtime";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";

import { createTestToolConfig, getTestDeps, TestTempDir } from "./testHelpers";

const TEST_CWD = "/tmp";

function createConfig(runtime?: Runtime) {
  const config = createTestToolConfig(TEST_CWD);
  if (runtime) {
    config.runtime = runtime;
  }
  return config;
}

describe("executeFileEditOperation", () => {
  test("should return error when path validation fails", async () => {
    const result = await executeFileEditOperation({
      config: createConfig(),
      filePath: "../../etc/passwd",
      operation: () => ({ success: true, newContent: "", metadata: {} }),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("File operations are restricted to the workspace directory");
    }
  });

  test("should use runtime.normalizePath for path resolution, not Node's path.resolve", async () => {
    // This test verifies that executeFileEditOperation uses runtime.normalizePath()
    // instead of path.resolve() for resolving file paths.
    //
    // Why this matters: path.resolve() uses LOCAL filesystem semantics (Node.js path module),
    // which normalizes paths differently than the remote filesystem expects.
    // For example, path.resolve() on Windows uses backslashes, and path normalization
    // can behave differently across platforms.

    const normalizePathCalls: Array<{ targetPath: string; basePath: string }> = [];

    const mockRuntime = {
      stat: jest
        .fn<() => Promise<{ size: number; modifiedTime: Date; isDirectory: boolean }>>()
        .mockResolvedValue({
          size: 100,
          modifiedTime: new Date(),
          isDirectory: false,
        }),
      readFile: jest.fn<() => Promise<Uint8Array>>().mockResolvedValue(new Uint8Array()),
      writeFile: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      normalizePath: jest.fn<(targetPath: string, basePath: string) => string>(
        (targetPath: string, basePath: string) => {
          normalizePathCalls.push({ targetPath, basePath });
          // Mock SSH-style path normalization
          if (targetPath.startsWith("/")) return targetPath;
          return `${basePath}/${targetPath}`;
        }
      ),
    } as unknown as Runtime;

    const testFilePath = "relative/path/to/file.txt";
    const testCwd = "/remote/workspace/dir";

    await executeFileEditOperation({
      config: {
        cwd: testCwd,
        runtime: mockRuntime,
        runtimeTempDir: "/tmp",
        ...getTestDeps(),
      },
      filePath: testFilePath,
      operation: () => ({ success: true, newContent: "test", metadata: {} }),
    });

    // Verify that runtime.normalizePath() was called for path resolution
    const normalizeCallForFilePath = normalizePathCalls.find(
      (call) => call.targetPath === testFilePath
    );

    expect(normalizeCallForFilePath).toBeDefined();

    if (normalizeCallForFilePath) {
      expect(normalizeCallForFilePath.basePath).toBe(testCwd);
    }
  });
});

describe("executeFileEditOperation plan mode enforcement", () => {
  test("should block editing non-plan files when in plan mode", async () => {
    // This test verifies that when in plan mode with a planFilePath set,
    // attempting to edit any other file is blocked BEFORE trying to read/write
    const OTHER_FILE_PATH = "/home/user/project/src/main.ts";
    const PLAN_FILE_PATH = "/home/user/.mux/sessions/workspace-123/plan.md";
    const TEST_CWD = "/home/user/project";

    const readFileMock = jest.fn();
    const mockRuntime = {
      stat: jest
        .fn<() => Promise<{ size: number; modifiedTime: Date; isDirectory: boolean }>>()
        .mockResolvedValue({
          size: 100,
          modifiedTime: new Date(),
          isDirectory: false,
        }),
      readFile: readFileMock,
      writeFile: jest.fn(),
      normalizePath: jest.fn<(targetPath: string, _basePath: string) => string>(
        (targetPath: string, _basePath: string) => {
          // For absolute paths, return as-is
          if (targetPath.startsWith("/")) return targetPath;
          // For relative paths, join with base
          return `${_basePath}/${targetPath}`;
        }
      ),
    } as unknown as Runtime;

    const result = await executeFileEditOperation({
      config: {
        cwd: TEST_CWD,
        runtime: mockRuntime,
        runtimeTempDir: "/tmp",
        mode: "plan",
        planFilePath: PLAN_FILE_PATH,
      },
      filePath: OTHER_FILE_PATH,
      operation: () => ({ success: true, newContent: "console.log('test')", metadata: {} }),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("In plan mode, only the plan file can be edited");
      expect(result.error).toContain(OTHER_FILE_PATH);
    }

    // Verify readFile was never called - we should fail before reaching file IO
    expect(readFileMock).not.toHaveBeenCalled();
  });

  test("should allow editing the plan file when in plan mode (integration)", async () => {
    using tempDir = new TestTempDir("plan-mode-test");

    // Create the plan file in the temp directory
    const planPath = path.join(tempDir.path, "plan.md");
    await fs.writeFile(planPath, "# Original Plan\n");

    // CWD is separate from plan file location (simulates real setup)
    const workspaceCwd = path.join(tempDir.path, "workspace");
    await fs.mkdir(workspaceCwd);

    const result = await executeFileEditOperation({
      config: {
        cwd: workspaceCwd,
        runtime: new LocalRuntime(workspaceCwd, tempDir.path),
        runtimeTempDir: tempDir.path,
        mode: "plan",
        planFilePath: planPath,
      },
      filePath: planPath,
      operation: () => ({ success: true, newContent: "# Updated Plan\n", metadata: {} }),
    });

    expect(result.success).toBe(true);
    expect(await fs.readFile(planPath, "utf-8")).toBe("# Updated Plan\n");
  });

  test("should allow editing any file when in exec mode (integration)", async () => {
    using tempDir = new TestTempDir("exec-mode-test");

    const testFile = path.join(tempDir.path, "main.ts");
    await fs.writeFile(testFile, "const x = 1;\n");

    const result = await executeFileEditOperation({
      config: {
        cwd: tempDir.path,
        runtime: new LocalRuntime(tempDir.path, tempDir.path),
        runtimeTempDir: tempDir.path,
        mode: "exec",
        // No planFilePath in exec mode
      },
      filePath: testFile,
      operation: () => ({ success: true, newContent: "const x = 2;\n", metadata: {} }),
    });

    expect(result.success).toBe(true);
    expect(await fs.readFile(testFile, "utf-8")).toBe("const x = 2;\n");
  });

  test("should allow editing any file when mode is not set (integration)", async () => {
    using tempDir = new TestTempDir("no-mode-test");

    const testFile = path.join(tempDir.path, "main.ts");
    await fs.writeFile(testFile, "const x = 1;\n");

    const result = await executeFileEditOperation({
      config: {
        cwd: tempDir.path,
        runtime: new LocalRuntime(tempDir.path, tempDir.path),
        runtimeTempDir: tempDir.path,
        // mode is undefined
      },
      filePath: testFile,
      operation: () => ({ success: true, newContent: "const x = 2;\n", metadata: {} }),
    });

    expect(result.success).toBe(true);
    expect(await fs.readFile(testFile, "utf-8")).toBe("const x = 2;\n");
  });

  test("should handle relative path to plan file in plan mode", async () => {
    // When user provides a relative path that resolves to the plan file,
    // it should still be allowed
    const normalizePathCalls: string[] = [];

    const mockRuntime = {
      stat: jest.fn(),
      readFile: jest.fn(),
      writeFile: jest.fn(),
      normalizePath: jest.fn<(targetPath: string, basePath: string) => string>(
        (targetPath: string, basePath: string) => {
          normalizePathCalls.push(targetPath);
          // Simulate: "../.mux/sessions/ws/plan.md" resolves to "/home/user/.mux/sessions/ws/plan.md"
          if (targetPath === "../.mux/sessions/ws/plan.md") {
            return "/home/user/.mux/sessions/ws/plan.md";
          }
          if (targetPath === "/home/user/.mux/sessions/ws/plan.md") {
            return "/home/user/.mux/sessions/ws/plan.md";
          }
          if (targetPath.startsWith("/")) return targetPath;
          return `${basePath}/${targetPath}`;
        }
      ),
    } as unknown as Runtime;

    await executeFileEditOperation({
      config: {
        cwd: "/home/user/project",
        runtime: mockRuntime,
        runtimeTempDir: "/tmp",
        mode: "plan",
        planFilePath: "/home/user/.mux/sessions/ws/plan.md",
      },
      filePath: "../.mux/sessions/ws/plan.md", // Relative path to plan file
      operation: () => ({ success: true, newContent: "# Plan", metadata: {} }),
    });

    // This will fail at file read (because mock doesn't provide real stream),
    // but the key is that it passes the plan mode check and tries to read the file
    // So we check that normalizePath was called for both paths
    expect(normalizePathCalls).toContain("../.mux/sessions/ws/plan.md");
    expect(normalizePathCalls).toContain("/home/user/.mux/sessions/ws/plan.md");
  });
});

import { describe, test, expect, jest } from "@jest/globals";
import * as fs from "fs/promises";
import * as path from "path";
import { executeFileEditOperation } from "./file_edit_operation";
import type { Runtime } from "@/node/runtime/Runtime";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD } from "@/common/utils/tools/internalToolResultFields";
import {
  DOOM_LOOP_EDIT_THRESHOLD,
  StreamEditTracker,
} from "@/node/services/streamGuardrails/StreamEditTracker";

import { getTestDeps, TestTempDir } from "./testHelpers";

describe("executeFileEditOperation", () => {
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
      resolvePath: jest.fn<(targetPath: string) => Promise<string>>((targetPath: string) => {
        // For absolute paths, return as-is
        if (targetPath.startsWith("/")) return Promise.resolve(targetPath);
        // Return path as-is (mock doesn't need full resolution)
        return Promise.resolve(targetPath);
      }),
    } as unknown as Runtime;

    const result = await executeFileEditOperation({
      config: {
        cwd: TEST_CWD,
        runtime: mockRuntime,
        runtimeTempDir: "/tmp",
        planFileOnly: true,
        planFilePath: PLAN_FILE_PATH,
      },
      filePath: OTHER_FILE_PATH,
      operation: () => ({ success: true, newContent: "console.log('test')", metadata: {} }),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("In the plan agent, only the plan file can be edited");
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
        runtime: new LocalRuntime(workspaceCwd),
        runtimeTempDir: tempDir.path,
        planFileOnly: true,
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
        runtime: new LocalRuntime(tempDir.path),
        runtimeTempDir: tempDir.path,
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
        runtime: new LocalRuntime(tempDir.path),
        runtimeTempDir: tempDir.path,
        // mode is undefined
      },
      filePath: testFile,
      operation: () => ({ success: true, newContent: "const x = 2;\n", metadata: {} }),
    });

    expect(result.success).toBe(true);
    expect(await fs.readFile(testFile, "utf-8")).toBe("const x = 2;\n");
  });

  test("should block editing the plan file outside plan mode (integration)", async () => {
    using tempDir = new TestTempDir("exec-plan-readonly-test");

    const planPath = path.join(tempDir.path, "plan.md");
    await fs.writeFile(planPath, "# Plan\n");

    const workspaceCwd = path.join(tempDir.path, "workspace");
    await fs.mkdir(workspaceCwd);

    const result = await executeFileEditOperation({
      config: {
        cwd: workspaceCwd,
        runtime: new LocalRuntime(workspaceCwd),
        runtimeTempDir: tempDir.path,
        planFilePath: planPath,
      },
      filePath: planPath,
      operation: () => ({ success: true, newContent: "# Updated\n", metadata: {} }),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("read-only outside the plan agent");
    }

    // Verify file was not modified
    expect(await fs.readFile(planPath, "utf-8")).toBe("# Plan\n");
  });

  test("should require exact plan file path string in plan mode", async () => {
    // If an alternate path resolves to the plan file, we still require using the exact
    // planFilePath string provided in the plan-mode instructions.
    const resolvePathCalls: string[] = [];

    const mockRuntime = {
      stat: jest.fn(),
      readFile: jest.fn(),
      writeFile: jest.fn(),
      normalizePath: jest.fn<(targetPath: string, basePath: string) => string>(
        (targetPath: string, basePath: string) => {
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
      resolvePath: jest.fn<(targetPath: string) => Promise<string>>((targetPath: string) => {
        resolvePathCalls.push(targetPath);
        // Both paths resolve to the same absolute path
        if (targetPath === "../.mux/sessions/ws/plan.md") {
          return Promise.resolve("/home/user/.mux/sessions/ws/plan.md");
        }
        if (targetPath === "/home/user/.mux/sessions/ws/plan.md") {
          return Promise.resolve("/home/user/.mux/sessions/ws/plan.md");
        }
        if (targetPath.startsWith("/")) return Promise.resolve(targetPath);
        return Promise.resolve(targetPath);
      }),
    } as unknown as Runtime;

    const result = await executeFileEditOperation({
      config: {
        cwd: "/home/user/project",
        runtime: mockRuntime,
        runtimeTempDir: "/tmp",
        planFileOnly: true,
        planFilePath: "/home/user/.mux/sessions/ws/plan.md",
      },
      filePath: "../.mux/sessions/ws/plan.md", // Alternate path to plan file
      operation: () => ({ success: true, newContent: "# Plan", metadata: {} }),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("exact plan file path");
      expect(result.error).toContain("/home/user/.mux/sessions/ws/plan.md");
      expect(result.error).toContain("../.mux/sessions/ws/plan.md");
      expect(result.error).toContain("resolves to the plan file");
    }

    // We still resolve both paths to determine whether the attempted path is the plan file.
    expect(resolvePathCalls).toContain("../.mux/sessions/ws/plan.md");
    expect(resolvePathCalls).toContain("/home/user/.mux/sessions/ws/plan.md");
  });
});

describe("executeFileEditOperation doom-loop guard", () => {
  test("attaches a model-only notification when edit threshold is reached", async () => {
    using tempDir = new TestTempDir("doom-loop-guard-test");

    const filePath = path.join(tempDir.path, "main.ts");
    await fs.writeFile(filePath, "const x = 0;\n");

    const runtime = new LocalRuntime(tempDir.path);
    const editTracker = new StreamEditTracker();

    let thresholdResult: unknown;
    for (let i = 1; i <= DOOM_LOOP_EDIT_THRESHOLD; i += 1) {
      thresholdResult = await executeFileEditOperation({
        config: {
          cwd: tempDir.path,
          runtime,
          runtimeTempDir: tempDir.path,
          editTracker,
        },
        filePath,
        operation: () => ({ success: true, newContent: `const x = ${i};\n`, metadata: {} }),
      });
    }

    expect(thresholdResult).toBeDefined();
    const resultRecord = thresholdResult as Record<string, unknown>;

    expect(resultRecord.success).toBe(true);
    expect(Array.isArray(resultRecord[MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD])).toBe(true);

    const notifications = resultRecord[MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD] as string[];
    expect(notifications[0]).toContain("Potential doom loop");
    expect(notifications[0]).toContain(filePath);
  });

  test("nudges at most once per file for a stream", async () => {
    using tempDir = new TestTempDir("doom-loop-guard-once-test");

    const filePath = path.join(tempDir.path, "main.ts");
    await fs.writeFile(filePath, "const x = 0;\n");

    const runtime = new LocalRuntime(tempDir.path);
    const editTracker = new StreamEditTracker();

    for (let i = 1; i <= DOOM_LOOP_EDIT_THRESHOLD; i += 1) {
      await executeFileEditOperation({
        config: {
          cwd: tempDir.path,
          runtime,
          runtimeTempDir: tempDir.path,
          editTracker,
        },
        filePath,
        operation: () => ({ success: true, newContent: `const x = ${i};\n`, metadata: {} }),
      });
    }

    const postThresholdResult = await executeFileEditOperation({
      config: {
        cwd: tempDir.path,
        runtime,
        runtimeTempDir: tempDir.path,
        editTracker,
      },
      filePath,
      operation: () => ({
        success: true,
        newContent: `const x = ${DOOM_LOOP_EDIT_THRESHOLD + 1};\n`,
        metadata: {},
      }),
    });

    const resultRecord = postThresholdResult as unknown as Record<string, unknown>;
    expect(resultRecord.success).toBe(true);
    expect(resultRecord[MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD]).toBeUndefined();
  });
});

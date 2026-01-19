import { describe, expect, it } from "bun:test";
import * as os from "os";
import * as path from "path";
import { LocalBaseRuntime } from "./LocalBaseRuntime";
import type {
  WorkspaceCreationParams,
  WorkspaceCreationResult,
  WorkspaceInitParams,
  WorkspaceInitResult,
  WorkspaceForkParams,
  WorkspaceForkResult,
} from "./Runtime";

class TestLocalRuntime extends LocalBaseRuntime {
  getWorkspacePath(_projectPath: string, _workspaceName: string): string {
    return "/tmp/workspace";
  }

  createWorkspace(_params: WorkspaceCreationParams): Promise<WorkspaceCreationResult> {
    return Promise.resolve({ success: true, workspacePath: "/tmp/workspace" });
  }

  initWorkspace(_params: WorkspaceInitParams): Promise<WorkspaceInitResult> {
    return Promise.resolve({ success: true });
  }

  renameWorkspace(
    _projectPath: string,
    _oldName: string,
    _newName: string
  ): Promise<
    { success: true; oldPath: string; newPath: string } | { success: false; error: string }
  > {
    return Promise.resolve({ success: true, oldPath: "/tmp/workspace", newPath: "/tmp/workspace" });
  }

  deleteWorkspace(
    _projectPath: string,
    _workspaceName: string,
    _force: boolean
  ): Promise<{ success: true; deletedPath: string } | { success: false; error: string }> {
    return Promise.resolve({ success: true, deletedPath: "/tmp/workspace" });
  }

  forkWorkspace(_params: WorkspaceForkParams): Promise<WorkspaceForkResult> {
    return Promise.resolve({
      success: true,
      workspacePath: "/tmp/workspace",
      sourceBranch: "main",
    });
  }
}

describe("LocalBaseRuntime.resolvePath", () => {
  it("should expand tilde to home directory", async () => {
    const runtime = new TestLocalRuntime();
    const resolved = await runtime.resolvePath("~");
    expect(resolved).toBe(os.homedir());
  });

  it("should expand tilde with path", async () => {
    const runtime = new TestLocalRuntime();
    const resolved = await runtime.resolvePath("~/..");
    const expected = path.dirname(os.homedir());
    expect(resolved).toBe(expected);
  });

  it("should resolve absolute paths", async () => {
    const runtime = new TestLocalRuntime();
    const resolved = await runtime.resolvePath("/tmp");
    expect(resolved).toBe("/tmp");
  });

  it("should resolve non-existent paths without checking existence", async () => {
    const runtime = new TestLocalRuntime();
    const resolved = await runtime.resolvePath("/this/path/does/not/exist/12345");
    // Should resolve to absolute path without checking if it exists
    expect(resolved).toBe("/this/path/does/not/exist/12345");
  });

  it("should resolve relative paths from cwd", async () => {
    const runtime = new TestLocalRuntime();
    const resolved = await runtime.resolvePath(".");
    // Should resolve to absolute path
    expect(path.isAbsolute(resolved)).toBe(true);
  });
});

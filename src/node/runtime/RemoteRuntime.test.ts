import { describe, expect, it } from "bun:test";
import { RemoteRuntime, type SpawnResult } from "./RemoteRuntime";

class RecordingRemoteRuntime extends RemoteRuntime {
  spawnCount = 0;

  protected readonly commandPrefix = "Recording";

  protected getBasePath(): string {
    return "/workspace";
  }

  protected quoteForRemote(filePath: string): string {
    return `'${filePath}'`;
  }

  protected cdCommand(cwd: string): string {
    return `cd '${cwd}'`;
  }

  protected spawnRemoteProcess(): Promise<SpawnResult> {
    this.spawnCount += 1;
    throw new Error("spawn should not be called");
  }

  resolvePath(filePath: string): Promise<string> {
    return Promise.resolve(filePath);
  }

  getWorkspacePath(): string {
    return "/workspace";
  }

  createWorkspace() {
    return Promise.resolve({ success: false as const, error: "not implemented" });
  }

  initWorkspace() {
    return Promise.resolve({ success: true });
  }

  deleteWorkspace() {
    return Promise.resolve({ success: true as const, deletedPath: "/workspace" });
  }

  renameWorkspace() {
    return Promise.resolve({
      success: true as const,
      oldPath: "/workspace",
      newPath: "/workspace",
    });
  }

  forkWorkspace() {
    return Promise.resolve({ success: false as const, error: "not implemented" });
  }

  ensureReady() {
    return Promise.resolve({ ready: true as const });
  }
}

describe("RemoteRuntime.writeFile", () => {
  it("does not start a remote write command when aborted before the first write", async () => {
    const runtime = new RecordingRemoteRuntime();
    const writer = runtime.writeFile("/workspace/file.txt").getWriter();

    try {
      await writer.abort("cancelled");
      throw new Error("Expected writer abort to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("cancelled");
    }

    expect(runtime.spawnCount).toBe(0);
  });
});

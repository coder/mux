import { describe, expect, it } from "bun:test";
import { LEGACY_REMOTE_MUX_HOME } from "@/common/compat/legacyMux";
import { LocalRuntime } from "./LocalRuntime";
import { RemoteRuntime, type SpawnResult } from "./RemoteRuntime";
import { resolveGlobalRuntime, shouldUseHostGlobalXumFallback } from "./hostGlobalXumHome";

class StubRemoteRuntime extends RemoteRuntime {
  constructor(private readonly xumHome: string) {
    super();
  }

  protected readonly commandPrefix = "StubRemote";

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
    throw new Error("spawn should not be called");
  }

  override getXumHome(): string {
    return this.xumHome;
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
}

describe("hostGlobalXumHome", () => {
  const workspacePath = "/tmp/xum-host-global-home";

  it("falls back to the host local runtime only for SSH legacy ~/.mux", () => {
    const sshRuntime = new StubRemoteRuntime(LEGACY_REMOTE_MUX_HOME);
    expect(shouldUseHostGlobalXumFallback(sshRuntime)).toBe(true);
    expect(resolveGlobalRuntime(sshRuntime, workspacePath)).toBeInstanceOf(LocalRuntime);
  });

  it("keeps Docker /var/mux on the container runtime", () => {
    const dockerRuntime = new StubRemoteRuntime("/var/mux");
    expect(shouldUseHostGlobalXumFallback(dockerRuntime)).toBe(false);
    expect(resolveGlobalRuntime(dockerRuntime, workspacePath)).toBe(dockerRuntime);
  });

  it("keeps local canonical ~/.xum on the workspace runtime", () => {
    const localRuntime = new LocalRuntime(workspacePath);
    expect(localRuntime.getXumHome()).toBe("~/.xum");
    expect(shouldUseHostGlobalXumFallback(localRuntime)).toBe(false);
    expect(resolveGlobalRuntime(localRuntime, workspacePath)).toBe(localRuntime);
  });
});

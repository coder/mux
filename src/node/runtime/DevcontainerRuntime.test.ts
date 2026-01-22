import { describe, expect, it } from "bun:test";
import { DevcontainerRuntime } from "./DevcontainerRuntime";

interface RuntimeState {
  remoteHomeDir?: string;
  remoteUser?: string;
  remoteWorkspaceFolder?: string;
  currentWorkspacePath?: string;
}

function createRuntime(state: RuntimeState): DevcontainerRuntime {
  const runtime = new DevcontainerRuntime({
    srcBaseDir: "/tmp/mux",
    configPath: ".devcontainer/devcontainer.json",
  });
  const internal = runtime as unknown as RuntimeState;
  internal.remoteHomeDir = state.remoteHomeDir;
  internal.remoteUser = state.remoteUser;
  internal.remoteWorkspaceFolder = state.remoteWorkspaceFolder;
  internal.currentWorkspacePath = state.currentWorkspacePath;
  return runtime;
}

describe("DevcontainerRuntime.resolvePath", () => {
  it("resolves ~ to cached remoteHomeDir", async () => {
    const runtime = createRuntime({ remoteHomeDir: "/home/coder" });
    expect(await runtime.resolvePath("~")).toBe("/home/coder");
  });

  it("throws when home is unknown", async () => {
    const runtime = createRuntime({});
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun:test expect().rejects requires await
    await expect(runtime.resolvePath("~")).rejects.toThrow("container home directory unavailable");
  });

  it("resolves ~/path to cached remoteHomeDir", async () => {
    const runtime = createRuntime({ remoteHomeDir: "/opt/user" });
    expect(await runtime.resolvePath("~/.mux")).toBe("/opt/user/.mux");
  });

  it("falls back to /home/<user> without cached home", async () => {
    const runtime = createRuntime({ remoteUser: "node" });
    expect(await runtime.resolvePath("~")).toBe("/home/node");
  });

  it("falls back to /root for root user", async () => {
    const runtime = createRuntime({ remoteUser: "root" });
    expect(await runtime.resolvePath("~")).toBe("/root");
  });

  it("resolves relative paths against remoteWorkspaceFolder", async () => {
    const runtime = createRuntime({ remoteWorkspaceFolder: "/workspaces/demo" });
    expect(await runtime.resolvePath("./foo")).toBe("/workspaces/demo/foo");
    expect(await runtime.resolvePath("bar")).toBe("/workspaces/demo/bar");
  });

  it("resolves relative paths against / when no workspace set", async () => {
    const runtime = createRuntime({});
    expect(await runtime.resolvePath("foo")).toBe("/foo");
  });

  it("passes absolute paths through", async () => {
    const runtime = createRuntime({});
    expect(await runtime.resolvePath("/tmp/test")).toBe("/tmp/test");
  });
});

describe("DevcontainerRuntime.quoteForContainer", () => {
  function quoteForContainer(runtime: DevcontainerRuntime, filePath: string): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
    return (runtime as any).quoteForContainer(filePath);
  }

  it("uses $HOME expansion for tilde paths", () => {
    const runtime = createRuntime({});
    expect(quoteForContainer(runtime, "~/.mux")).toBe('"$HOME/.mux"');
  });
});

describe("DevcontainerRuntime.resolveContainerCwd", () => {
  // Access the private method for testing
  function resolveContainerCwd(
    runtime: DevcontainerRuntime,
    optionsCwd: string | undefined,
    workspaceFolder: string
  ): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
    return (runtime as any).resolveContainerCwd(optionsCwd, workspaceFolder);
  }

  it("uses POSIX absolute path as cwd", () => {
    const runtime = createRuntime({ remoteWorkspaceFolder: "/workspaces/project" });
    expect(resolveContainerCwd(runtime, "/tmp/test", "/host/workspace")).toBe("/tmp/test");
  });

  it("rejects Windows drive letter paths and falls back to workspace", () => {
    const runtime = createRuntime({ remoteWorkspaceFolder: "/workspaces/project" });
    expect(resolveContainerCwd(runtime, "C:\\Users\\dev", "/host/workspace")).toBe(
      "/workspaces/project"
    );
  });

  it("rejects paths with backslashes and falls back to workspace", () => {
    const runtime = createRuntime({ remoteWorkspaceFolder: "/workspaces/project" });
    expect(resolveContainerCwd(runtime, "some\\path", "/host/workspace")).toBe(
      "/workspaces/project"
    );
  });

  it("falls back to workspaceFolder when remoteWorkspaceFolder not set", () => {
    const runtime = createRuntime({});
    expect(resolveContainerCwd(runtime, "C:\\", "/host/workspace")).toBe("/host/workspace");
  });

  it("falls back when cwd is undefined", () => {
    const runtime = createRuntime({ remoteWorkspaceFolder: "/workspaces/project" });
    expect(resolveContainerCwd(runtime, undefined, "/host/workspace")).toBe("/workspaces/project");
  });
});

describe("DevcontainerRuntime.resolveHostPathForMounted", () => {
  function resolveHostPathForMounted(
    runtime: DevcontainerRuntime,
    filePath: string
  ): string | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
    return (runtime as any).resolveHostPathForMounted(filePath);
  }

  it("accepts Windows host paths under the workspace root", () => {
    const runtime = createRuntime({ currentWorkspacePath: "C:\\ws\\proj" });
    const filePath = "C:\\ws\\proj\\.mux\\mcp.local.jsonc";
    expect(resolveHostPathForMounted(runtime, filePath)).toBe(filePath);
  });
});
describe("DevcontainerRuntime.mapHostPathToContainer", () => {
  // Access the private method for testing
  function mapHostPathToContainer(runtime: DevcontainerRuntime, hostPath: string): string | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
    return (runtime as any).mapHostPathToContainer(hostPath);
  }

  it("maps host workspace root to container workspace", () => {
    const runtime = createRuntime({
      remoteWorkspaceFolder: "/workspaces/project",
      currentWorkspacePath: "/home/user/mux/project/branch",
    });
    expect(mapHostPathToContainer(runtime, "/home/user/mux/project/branch")).toBe(
      "/workspaces/project"
    );
  });

  it("maps host subpath to container subpath", () => {
    const runtime = createRuntime({
      remoteWorkspaceFolder: "/workspaces/project",
      currentWorkspacePath: "/home/user/mux/project/branch",
    });
    expect(mapHostPathToContainer(runtime, "/home/user/mux/project/branch/src/file.ts")).toBe(
      "/workspaces/project/src/file.ts"
    );
  });

  it("normalizes Windows backslashes to forward slashes", () => {
    const runtime = createRuntime({
      remoteWorkspaceFolder: "/workspaces/project",
      currentWorkspacePath: "C:\\Users\\dev\\mux\\project\\branch",
    });
    // Windows-style path with backslashes should map correctly
    expect(
      mapHostPathToContainer(runtime, "C:\\Users\\dev\\mux\\project\\branch\\src\\file.ts")
    ).toBe("/workspaces/project/src/file.ts");
  });

  it("returns null for paths outside workspace", () => {
    const runtime = createRuntime({
      remoteWorkspaceFolder: "/workspaces/project",
      currentWorkspacePath: "/home/user/mux/project/branch",
    });
    expect(mapHostPathToContainer(runtime, "/tmp/other")).toBeNull();
  });

  it("returns null when workspace not set", () => {
    const runtime = createRuntime({});
    expect(mapHostPathToContainer(runtime, "/some/path")).toBeNull();
  });
});

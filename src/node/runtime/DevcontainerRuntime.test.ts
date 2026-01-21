import { describe, expect, it } from "bun:test";
import { DevcontainerRuntime } from "./DevcontainerRuntime";

interface RuntimeState {
  remoteHomeDir?: string;
  remoteUser?: string;
  remoteWorkspaceFolder?: string;
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
  return runtime;
}

describe("DevcontainerRuntime.resolvePath", () => {
  it("resolves ~ to cached remoteHomeDir", async () => {
    const runtime = createRuntime({ remoteHomeDir: "/home/coder" });
    expect(await runtime.resolvePath("~")).toBe("/home/coder");
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

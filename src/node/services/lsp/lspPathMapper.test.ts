import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import { LspPathMapper } from "./lspPathMapper";

describe("LspPathMapper", () => {
  test("keeps local runtime paths unchanged", () => {
    const workspacePath = path.join(process.cwd(), "src");
    const mapper = new LspPathMapper({
      runtime: new LocalRuntime(workspacePath),
      workspacePath,
    });

    const runtimePath = mapper.toRuntimePath("browser/App.tsx");
    expect(runtimePath).toBe(path.resolve(workspacePath, "browser/App.tsx"));
    expect(mapper.toOutputPath(runtimePath)).toBe(runtimePath);
    expect(mapper.fromUri(mapper.toUri(runtimePath))).toBe(runtimePath);
  });

  test("maps devcontainer host paths to remote workspace paths", () => {
    const workspacePath = path.join("/Users", "mux", "repo");
    const runtime = Object.create(DevcontainerRuntime.prototype) as DevcontainerRuntime;
    runtime.getRemoteWorkspaceFolder = () => "/workspaces/repo";

    const mapper = new LspPathMapper({
      runtime,
      workspacePath,
    });

    const hostPath = path.join(workspacePath, "src", "main.ts");
    const runtimePath = mapper.toRuntimePath(hostPath);

    expect(runtimePath).toBe("/workspaces/repo/src/main.ts");
    expect(mapper.toOutputPath(runtimePath)).toBe(path.join(workspacePath, "src", "main.ts"));
    expect(mapper.isWithinWorkspace(runtimePath)).toBe(true);
  });
});

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, it } from "bun:test";

import type { MuxToolScope } from "@/common/types/toolScope";
import { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { TestTempDir } from "@/node/services/tools/testHelpers";

import { resolveSkillStorageContext } from "./skillStorageContext";

describe("resolveSkillStorageContext", () => {
  it("returns explicit global-only roots when mux scope is global", () => {
    using tempDir = new TestTempDir("skill-storage-context-global");
    const runtime = new LocalRuntime(tempDir.path);

    const context = resolveSkillStorageContext({
      runtime,
      workspacePath: tempDir.path,
      muxScope: {
        type: "global",
        muxHome: tempDir.path,
      },
    });

    expect(context.kind).toBe("global-local");
    expect(context.containment).toEqual({ kind: "none" });
    expect(context.roots).toEqual({
      projectRoot: "",
      globalRoot: path.join(tempDir.path, "skills"),
      universalRoot: "~/.agents/skills",
    });
  });

  it("falls back to runtime mux home when mux scope is omitted", () => {
    using tempDir = new TestTempDir("skill-storage-context-runtime-fallback");
    const runtimeMuxHome = path.join(tempDir.path, "mux-home");

    class MuxHomeRuntime extends LocalRuntime {
      override getMuxHome(): string {
        return runtimeMuxHome;
      }
    }

    const context = resolveSkillStorageContext({
      runtime: new MuxHomeRuntime(tempDir.path),
      workspacePath: tempDir.path,
    });

    expect(context.kind).toBe("global-local");
    expect(context.containment).toEqual({ kind: "none" });
    expect(context.roots).toEqual({
      projectRoot: "",
      globalRoot: path.join(runtimeMuxHome, "skills"),
      universalRoot: "~/.agents/skills",
    });
  });

  it("returns project-local context when project storage authority is host-local", () => {
    using tempDir = new TestTempDir("skill-storage-context-project-local");
    const runtime = new LocalRuntime(tempDir.path);

    const projectRoot = path.join(tempDir.path, "project");
    const muxScope: MuxToolScope = {
      type: "project",
      muxHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    };

    const context = resolveSkillStorageContext({
      runtime,
      workspacePath: "/remote/workspace",
      muxScope,
    });

    expect(context.kind).toBe("project-local");
    expect(context.containment).toEqual({
      kind: "local",
      root: projectRoot,
    });
    expect(context.roots).toEqual({
      projectRoot: path.join(projectRoot, ".mux", "skills"),
      projectUniversalRoot: path.join(projectRoot, ".agents", "skills"),
      globalRoot: path.join(tempDir.path, "skills"),
      universalRoot: "~/.agents/skills",
    });
  });

  it("swaps devcontainer project-local contexts to a host-local runtime", async () => {
    using tempDir = new TestTempDir("skill-storage-context-project-local-devcontainer");

    const projectRoot = path.join(tempDir.path, "project");
    const muxHome = path.join(tempDir.path, "mux-home");
    await fs.mkdir(path.join(muxHome, "skills"), { recursive: true });

    const runtime = new DevcontainerRuntime({
      srcBaseDir: path.join(tempDir.path, "src-base"),
      configPath: path.join(tempDir.path, ".devcontainer", "devcontainer.json"),
    });

    const context = resolveSkillStorageContext({
      runtime,
      workspacePath: "/remote/workspace",
      muxScope: {
        type: "project",
        muxHome,
        projectRoot,
        projectStorageAuthority: "host-local",
      },
    });

    expect(context.kind).toBe("project-local");
    expect(context.runtime).toBeInstanceOf(LocalRuntime);
    expect(context.runtime).not.toBe(runtime);
    expect(context.containment).toEqual({
      kind: "local",
      root: projectRoot,
    });
    expect(context.roots).toEqual({
      projectRoot: path.join(projectRoot, ".mux", "skills"),
      projectUniversalRoot: path.join(projectRoot, ".agents", "skills"),
      globalRoot: path.join(muxHome, "skills"),
      universalRoot: "~/.agents/skills",
    });

    const hostGlobalStat = await context.runtime.stat(path.join(muxHome, "skills"));
    expect(hostGlobalStat.isDirectory).toBe(true);
  });

  it("returns project-runtime context when project storage authority is runtime", () => {
    using tempDir = new TestTempDir("skill-storage-context-project-runtime");
    const runtime = new LocalRuntime(tempDir.path);

    const context = resolveSkillStorageContext({
      runtime,
      workspacePath: "/remote/workspace",
      muxScope: {
        type: "project",
        muxHome: tempDir.path,
        projectRoot: "/host/project",
        projectStorageAuthority: "runtime",
      },
    });

    expect(context.kind).toBe("project-runtime");
    expect(context.containment).toEqual({
      kind: "runtime",
      root: "/remote/workspace",
    });
    expect(context.roots).toBeUndefined();
  });
});

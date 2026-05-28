import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Config } from "@/node/config";
import { ProjectExtensionStateService } from "./projectExtensionStateService";
import {
  createExtensionRootsProvider,
  getFetchedGlobalExtensionRootPath,
  getUserGlobalExtensionRootPath,
} from "./extensionRoots";
import { getProjectExtensionActiveRootPath } from "./projectExtensionSourceSync";

let tempDir: string;

beforeEach(() => {
  tempDir = path.join(os.tmpdir(), `mux-extension-roots-${crypto.randomUUID()}`);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("getUserGlobalExtensionRootPath", () => {
  test("points local authoring at ~/.mux/extensions/local", () => {
    const config = new Config(tempDir);

    expect(getUserGlobalExtensionRootPath(config)).toBe(path.join(tempDir, "extensions", "local"));
  });

  test("enumerates an untrusted project-local root when only extensions.lock.json exists", async () => {
    const config = new Config(tempDir);
    const projectPath = path.join(tempDir, "project");
    await fs.mkdir(path.join(projectPath, ".mux"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, ".mux", "extensions.lock.json"),
      JSON.stringify({ schemaVersion: 1, extensions: {} })
    );
    const cfg = config.loadConfigOrDefault();
    cfg.projects.set(projectPath, { workspaces: [], trusted: false });
    await config.saveConfig(cfg);
    const provider = createExtensionRootsProvider({
      config,
      projectState: new ProjectExtensionStateService(path.join(tempDir, "project-state")),
    });

    const roots = await provider();

    expect(roots).toContainEqual({
      rootId: `project-local:${projectPath}`,
      kind: "project-local",
      path: path.join(projectPath, ".mux"),
      trusted: false,
    });
  });

  test("lock-only project roots point at an existing inspection path before trust", async () => {
    const config = new Config(tempDir);
    const projectPath = path.join(tempDir, "project");
    await fs.mkdir(path.join(projectPath, ".mux"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, ".mux", "extensions.lock.json"),
      JSON.stringify({ schemaVersion: 1, extensions: {} })
    );
    const cfg = config.loadConfigOrDefault();
    cfg.projects.set(projectPath, { workspaces: [], trusted: false });
    await config.saveConfig(cfg);
    const provider = createExtensionRootsProvider({
      config,
      projectState: new ProjectExtensionStateService(path.join(tempDir, "project-state")),
    });

    const roots = await provider();

    const projectRoot = roots.find((root) => root.rootId === `project-local:${projectPath}`);
    expect(projectRoot).toBeDefined();
    expect((await fs.stat(projectRoot!.path)).isDirectory()).toBe(true);
    let repoExtensionRootExists = true;
    try {
      await fs.access(path.join(projectPath, ".mux", "extensions"));
    } catch {
      repoExtensionRootExists = false;
    }
    expect(repoExtensionRootExists).toBe(false);

    expect(roots).toContainEqual({
      rootId: `project-local:${projectPath}`,
      kind: "project-local",
      path: path.join(projectPath, ".mux"),
      trusted: false,
    });
  });

  test("syncs project source locks after both project and extension root trust are set", async () => {
    const config = new Config(tempDir);
    const projectPath = path.join(tempDir, "project");
    await fs.mkdir(path.join(projectPath, ".mux"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, ".mux", "extensions.lock.json"),
      JSON.stringify({ schemaVersion: 1, extensions: {} })
    );
    const cfg = config.loadConfigOrDefault();
    cfg.projects.set(projectPath, { workspaces: [], trusted: true });
    await config.saveConfig(cfg);
    const projectState = new ProjectExtensionStateService(path.join(tempDir, "project-state"));
    await projectState.setRootTrusted(projectPath, true);
    const syncCalls: unknown[] = [];
    const provider = createExtensionRootsProvider({
      config,
      projectState,
      syncProjectLocks: (input) => {
        syncCalls.push(input);
        return Promise.resolve();
      },
    });

    await provider();

    expect(syncCalls).toEqual([
      {
        projectPath,
        muxRootDir: tempDir,
        trusted: true,
      },
    ]);
  });

  test("does not resync unchanged project source locks when the active view exists", async () => {
    const config = new Config(tempDir);
    const projectPath = path.join(tempDir, "project");
    const lockPath = path.join(projectPath, ".mux", "extensions.lock.json");
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify({ schemaVersion: 1, extensions: {} }));
    const cfg = config.loadConfigOrDefault();
    cfg.projects.set(projectPath, { workspaces: [], trusted: true });
    await config.saveConfig(cfg);
    const projectState = new ProjectExtensionStateService(path.join(tempDir, "project-state"));
    await projectState.setRootTrusted(projectPath, true);
    const syncCalls: unknown[] = [];
    const provider = createExtensionRootsProvider({
      config,
      projectState,
      syncProjectLocks: (input) => {
        syncCalls.push(input);
        return fs.mkdir(getProjectExtensionActiveRootPath(tempDir, projectPath), {
          recursive: true,
        });
      },
    });

    await provider();
    await provider();

    expect(syncCalls).toHaveLength(1);
  });

  test("resyncs unchanged project source locks when the active view is tampered", async () => {
    const config = new Config(tempDir);
    const projectPath = path.join(tempDir, "project");
    const lockPath = path.join(projectPath, ".mux", "extensions.lock.json");
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify({ schemaVersion: 1, extensions: {} }));
    const cfg = config.loadConfigOrDefault();
    cfg.projects.set(projectPath, { workspaces: [], trusted: true });
    await config.saveConfig(cfg);
    const projectState = new ProjectExtensionStateService(path.join(tempDir, "project-state"));
    await projectState.setRootTrusted(projectPath, true);
    const activeRootPath = getProjectExtensionActiveRootPath(tempDir, projectPath);
    const syncCalls: unknown[] = [];
    const provider = createExtensionRootsProvider({
      config,
      projectState,
      syncProjectLocks: (input) => {
        syncCalls.push(input);
        return fs.mkdir(activeRootPath, { recursive: true });
      },
    });

    await provider();
    await fs.mkdir(path.join(activeRootPath, "tampered-extension"), { recursive: true });
    await provider();

    expect(syncCalls).toHaveLength(2);
  });

  test("keeps project root inspectable when active source validation fails", async () => {
    const config = new Config(tempDir);
    const projectPath = path.join(tempDir, "project");
    await fs.mkdir(path.join(projectPath, ".mux"), { recursive: true });
    await fs.writeFile(path.join(projectPath, ".mux", "extensions.lock.json"), "not json");
    await fs.mkdir(getProjectExtensionActiveRootPath(tempDir, projectPath), { recursive: true });
    const cfg = config.loadConfigOrDefault();
    cfg.projects.set(projectPath, { workspaces: [], trusted: true });
    await config.saveConfig(cfg);
    const projectState = new ProjectExtensionStateService(path.join(tempDir, "project-state"));
    await projectState.setRootTrusted(projectPath, true);
    const provider = createExtensionRootsProvider({ config, projectState });

    const roots = await provider();

    expect(roots).toContainEqual({
      rootId: `project-local:${projectPath}`,
      kind: "project-local",
      path: path.join(projectPath, ".mux"),
      trusted: false,
    });
  });

  test("keeps project root inspectable but non-activating when trusted project source sync fails", async () => {
    const config = new Config(tempDir);
    const projectPath = path.join(tempDir, "project");
    await fs.mkdir(path.join(projectPath, ".mux"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, ".mux", "extensions.lock.json"),
      JSON.stringify({ schemaVersion: 1, extensions: {} })
    );
    const cfg = config.loadConfigOrDefault();
    cfg.projects.set(projectPath, { workspaces: [], trusted: true });
    await config.saveConfig(cfg);
    const projectState = new ProjectExtensionStateService(path.join(tempDir, "project-state"));
    await projectState.setRootTrusted(projectPath, true);
    const provider = createExtensionRootsProvider({
      config,
      projectState,
      syncProjectLocks: () => Promise.reject(new Error("sync failed")),
    });

    const roots = await provider();

    expect(roots).toContainEqual({
      rootId: `project-local:${projectPath}`,
      kind: "project-local",
      path: path.join(projectPath, ".mux"),
      trusted: false,
    });
  });

  test("does not discover stale lock-backed active views when trusted project source sync fails", async () => {
    const config = new Config(tempDir);
    const projectPath = path.join(tempDir, "project");
    await fs.mkdir(path.join(projectPath, ".mux"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, ".mux", "extensions.lock.json"),
      JSON.stringify({ schemaVersion: 1, extensions: {} })
    );
    const activeRootPath = getProjectExtensionActiveRootPath(tempDir, projectPath);
    await fs.mkdir(path.join(activeRootPath, "stale-review"), { recursive: true });
    await fs.writeFile(
      path.join(activeRootPath, "stale-review", "extension.ts"),
      "export const manifest = { name: 'stale-review', capabilities: { skills: true } };\n"
    );
    await fs.mkdir(path.join(projectPath, ".mux", "extensions"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, ".mux", "extensions", "extension.ts"),
      "export const manifest = { name: 'extensions', capabilities: { skills: true } };\n"
    );
    const cfg = config.loadConfigOrDefault();
    cfg.projects.set(projectPath, { workspaces: [], trusted: true });
    await config.saveConfig(cfg);
    const projectState = new ProjectExtensionStateService(path.join(tempDir, "project-state"));
    await projectState.setRootTrusted(projectPath, true);
    const provider = createExtensionRootsProvider({
      config,
      projectState,
      syncProjectLocks: () => Promise.reject(new Error("sync failed")),
    });

    const roots = await provider();

    expect(roots).toContainEqual({
      rootId: `project-local:${projectPath}`,
      kind: "project-local",
      path: path.join(projectPath, ".mux"),
      trusted: false,
    });
  });

  test("ignores stale project active views after the project lock is removed", async () => {
    const config = new Config(tempDir);
    const projectPath = path.join(tempDir, "project");
    const repoRootPath = path.join(projectPath, ".mux", "extensions");
    await fs.mkdir(path.join(repoRootPath, "current-review"), { recursive: true });
    await fs.writeFile(
      path.join(repoRootPath, "current-review", "extension.ts"),
      "export const manifest = { name: 'current-review', capabilities: { skills: true } };\n"
    );
    const activeRootPath = getProjectExtensionActiveRootPath(tempDir, projectPath);
    await fs.mkdir(path.join(activeRootPath, "stale-review"), { recursive: true });
    await fs.writeFile(
      path.join(activeRootPath, "stale-review", "extension.ts"),
      "export const manifest = { name: 'stale-review', capabilities: { skills: true } };\n"
    );
    const cfg = config.loadConfigOrDefault();
    cfg.projects.set(projectPath, { workspaces: [], trusted: true });
    await config.saveConfig(cfg);
    const projectState = new ProjectExtensionStateService(path.join(tempDir, "project-state"));
    await projectState.setRootTrusted(projectPath, true);
    const provider = createExtensionRootsProvider({ config, projectState });

    const roots = await provider();

    expect(roots).toContainEqual({
      rootId: `project-local:${projectPath}`,
      kind: "project-local",
      path: repoRootPath,
      trusted: true,
    });
  });

  test("enumerates fetched global active view alongside local authoring root", async () => {
    const config = new Config(tempDir);
    await fs.mkdir(getFetchedGlobalExtensionRootPath(config), { recursive: true });
    const provider = createExtensionRootsProvider({
      config,
      projectState: new ProjectExtensionStateService(path.join(tempDir, "project-state")),
    });

    const roots = await provider();

    expect(roots).toContainEqual({
      rootId: "user-global",
      kind: "user-global",
      path: path.join(tempDir, "extensions", "local"),
    });
    expect(roots).toContainEqual({
      rootId: "user-global-fetched",
      kind: "user-global",
      path: path.join(tempDir, "extensions", "global"),
    });
  });
});

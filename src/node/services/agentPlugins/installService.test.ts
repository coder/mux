/* eslint-disable @typescript-eslint/await-thenable -- bun:test types `await expect(...).rejects.toThrow()` as void */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Config } from "@/node/config";
import { execFileAsync } from "@/node/utils/disposableExec";
import { AgentPluginInstallService } from "./installService";
import {
  AGENT_PLUGIN_MCP_SCHEMA_ID_1_0_0,
  computePluginInstanceId,
  getPluginDataPath,
} from "./mcpConfig";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0 } from "./manifest";

/**
 * Lifecycle tests against a real local git "remote". Local-path remotes go
 * through the same clone/ls-remote plumbing as network URLs, so the full
 * preview → install → check → update → uninstall loop runs hermetically.
 */

async function git(cwd: string, ...args: string[]): Promise<string> {
  using proc = execFileAsync("git", ["-C", cwd, ...args]);
  return (await proc.result).stdout;
}

async function initRemote(dir: string): Promise<void> {
  using proc = execFileAsync("git", ["init", "--quiet", "-b", "main", dir]);
  await proc.result;
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "Test");
}

async function commitAll(dir: string, message: string): Promise<string> {
  await git(dir, "add", "-A");
  await git(dir, "commit", "--quiet", "-m", message);
  return (await git(dir, "rev-parse", "HEAD")).trim();
}

async function writePluginFixture(dir: string, opts?: { version?: string }): Promise<void> {
  await fsPromises.writeFile(
    path.join(dir, "plugin.json"),
    JSON.stringify({
      $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
      name: "demo-plugin",
      version: opts?.version ?? "1.0.0",
      description: "Demo plugin",
    })
  );
  await fsPromises.mkdir(path.join(dir, "skills", "greet"), { recursive: true });
  await fsPromises.writeFile(
    path.join(dir, "skills", "greet", "SKILL.md"),
    "---\nname: greet\ndescription: Greets people\n---\n\nSay hi.\n"
  );
  await fsPromises.writeFile(
    path.join(dir, "mcp.json"),
    JSON.stringify({
      $schema: AGENT_PLUGIN_MCP_SCHEMA_ID_1_0_0,
      mcpServers: {
        echo: { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/server.js"] },
      },
    })
  );
}

describe("AgentPluginInstallService", () => {
  let muxRoot: string;
  let remoteDir: string;
  let config: Config;
  let service: AgentPluginInstallService;
  let enabled = true;

  const pluginsDir = () => path.join(muxRoot, "plugins");
  const stagingDir = () => path.join(muxRoot, "plugin-staging");
  const registryFile = () => path.join(muxRoot, "plugins.json");
  const registry = async (): Promise<unknown[]> => {
    try {
      const raw = await fsPromises.readFile(registryFile(), "utf8");
      return (JSON.parse(raw) as { plugins: unknown[] }).plugins;
    } catch {
      return [];
    }
  };
  const pathExists = async (p: string) =>
    fsPromises.access(p).then(
      () => true,
      () => false
    );
  const stagingLeftovers = async () =>
    (await pathExists(stagingDir())) ? fsPromises.readdir(stagingDir()) : [];

  beforeEach(async () => {
    muxRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-plugin-test-"));
    remoteDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-plugin-remote-"));
    config = new Config(muxRoot);
    enabled = true;
    service = new AgentPluginInstallService(config, { isEnabled: () => enabled });
    await initRemote(remoteDir);
    await writePluginFixture(remoteDir);
    await commitAll(remoteDir, "init");
  });

  afterEach(async () => {
    await fsPromises.rm(muxRoot, { recursive: true, force: true });
    await fsPromises.rm(remoteDir, { recursive: true, force: true });
  });

  test("preview stages+validates without writing; install promotes and records the registry", async () => {
    const head = (await git(remoteDir, "rev-parse", "HEAD")).trim();

    const preview = await service.preview({ input: remoteDir });
    expect(preview.source).toEqual({
      type: "git",
      url: remoteDir,
      ref: "main",
      refType: "branch",
    });
    expect(preview.lockedSha).toBe(head);
    expect(preview.manifest).toMatchObject({ name: "demo-plugin", version: "1.0.0" });
    expect(preview.skills).toEqual([{ name: "greet", description: "Greets people" }]);
    expect(preview.mcpServers).toHaveLength(1);
    expect(preview.mcpServers[0].serverName).toBe("echo");
    expect(preview.mcpServers[0].transport).toBe("stdio");
    // Command line shows the FINAL install path, not the staging clone path.
    expect(preview.mcpServers[0].summary).toBe(
      `node ${path.join(pluginsDir(), "demo-plugin", "server.js")}`
    );

    // Cancelling after preview = nothing written anywhere.
    expect(await pathExists(path.join(pluginsDir(), "demo-plugin"))).toBe(false);
    expect(await registry()).toEqual([]);
    expect(await stagingLeftovers()).toEqual([]);

    const entry = await service.install({ source: preview.source, expectedSha: preview.lockedSha });
    expect(entry.name).toBe("demo-plugin");
    expect(entry.lockedSha).toBe(head);

    const installedDir = path.join(pluginsDir(), "demo-plugin");
    expect(await pathExists(path.join(installedDir, "plugin.json"))).toBe(true);
    // Plain content snapshot: provenance lives in the registry, not .git.
    expect(await pathExists(path.join(installedDir, ".git"))).toBe(false);
    expect(await registry()).toHaveLength(1);
    expect((await registry())[0]).toMatchObject({
      name: "demo-plugin",
      lockedSha: head,
      scope: "global",
    });
    expect(await stagingLeftovers()).toEqual([]);

    const items = await service.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      name: "demo-plugin",
      managed: true,
      present: true,
      skillCount: 1,
      mcpServerCount: 1,
      lockedSha: head,
    });
  });

  test("never overwrites: registry and directory collisions are clear errors", async () => {
    const preview = await service.preview({ input: remoteDir });
    await service.install({ source: preview.source, expectedSha: preview.lockedSha });

    // Managed entry with the same name.
    await expect(service.preview({ input: remoteDir })).rejects.toThrow(/already installed/);
    await expect(
      service.install({ source: preview.source, expectedSha: preview.lockedSha })
    ).rejects.toThrow(/already installed/);

    // Unmanaged directory at the target path (registry entry removed, dir kept).
    await fsPromises.rm(registryFile(), { force: true });
    await expect(service.preview({ input: remoteDir })).rejects.toThrow(/already exists/);
  });

  test("update: badge on branch movement, atomic swap, lockedSha bump, local edits discarded", async () => {
    const preview = await service.preview({ input: remoteDir });
    await service.install({ source: preview.source, expectedSha: preview.lockedSha });

    expect(await service.checkUpdates()).toEqual([{ name: "demo-plugin", status: "up-to-date" }]);

    await writePluginFixture(remoteDir, { version: "2.0.0" });
    const newHead = await commitAll(remoteDir, "v2");

    expect(await service.checkUpdates()).toEqual([
      { name: "demo-plugin", status: "update-available", remoteSha: newHead },
    ]);

    // Local edits to a managed dir are discarded on update (documented behavior).
    const installedDir = path.join(pluginsDir(), "demo-plugin");
    await fsPromises.writeFile(path.join(installedDir, "local-edit.txt"), "scratch");

    const updated = await service.update({ name: "demo-plugin" });
    expect(updated.lockedSha).toBe(newHead);
    expect(updated.updatedAt).toBeDefined();
    expect(updated.manifest?.version).toBe("2.0.0");
    expect(await pathExists(path.join(installedDir, "local-edit.txt"))).toBe(false);
    expect(((await registry())[0] as { lockedSha: string }).lockedSha).toBe(newHead);
    expect(await stagingLeftovers()).toEqual([]);
  });

  test("tag refs pin; a moved tag reports tag-moved; commit refs report pinned", async () => {
    const firstSha = (await git(remoteDir, "rev-parse", "HEAD")).trim();
    await git(remoteDir, "tag", "v1");

    const tagPreview = await service.preview({ input: remoteDir, ref: "v1" });
    expect(tagPreview.source.refType).toBe("tag");
    expect(tagPreview.lockedSha).toBe(firstSha);
    await service.install({ source: tagPreview.source, expectedSha: tagPreview.lockedSha });

    await writePluginFixture(remoteDir, { version: "2.0.0" });
    await commitAll(remoteDir, "v2");
    await git(remoteDir, "tag", "-f", "v1");

    const checks = await service.checkUpdates();
    expect(checks[0].status).toBe("tag-moved");

    await service.uninstall({ name: "demo-plugin", deletePluginData: false });
    expect(await registry()).toEqual([]);
    expect(await pathExists(path.join(pluginsDir(), "demo-plugin"))).toBe(false);

    // Full-SHA install pins hard: no update checks apply.
    const shaPreview = await service.preview({ input: remoteDir, ref: firstSha });
    expect(shaPreview.source.refType).toBe("commit");
    await service.install({ source: shaPreview.source, expectedSha: firstSha });
    expect(await service.checkUpdates()).toEqual([{ name: "demo-plugin", status: "pinned" }]);
    await expect(service.update({ name: "demo-plugin" })).rejects.toThrow(/pinned/);
  });

  test("uninstall preserves plugin-data by default and deletes it when asked", async () => {
    const preview = await service.preview({ input: remoteDir });
    await service.install({ source: preview.source, expectedSha: preview.lockedSha });

    const instanceId = computePluginInstanceId(path.join(pluginsDir(), "demo-plugin"));
    const dataPath = getPluginDataPath(muxRoot, instanceId);
    await fsPromises.mkdir(dataPath, { recursive: true });
    await fsPromises.writeFile(path.join(dataPath, "state.json"), "{}");

    await service.uninstall({ name: "demo-plugin", deletePluginData: false });
    expect(await pathExists(dataPath)).toBe(true);

    const preview2 = await service.preview({ input: remoteDir });
    await service.install({ source: preview2.source, expectedSha: preview2.lockedSha });
    await service.uninstall({ name: "demo-plugin", deletePluginData: true });
    expect(await pathExists(dataPath)).toBe(false);
  });

  test("failure paths leave no partial state", async () => {
    // Unreachable remote.
    await expect(service.preview({ input: "/nonexistent/repo/path" })).rejects.toThrow(
      /Could not reach/
    );

    // Repo that is not a plugin.
    const notPlugin = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-not-plugin-"));
    try {
      await initRemote(notPlugin);
      await fsPromises.writeFile(path.join(notPlugin, "README.md"), "hi");
      await commitAll(notPlugin, "init");
      await expect(service.preview({ input: notPlugin })).rejects.toThrow(/No plugin\.json/);

      // Claude Code collection → clear message naming the limitation.
      await fsPromises.mkdir(path.join(notPlugin, ".claude-plugin"), { recursive: true });
      await fsPromises.writeFile(path.join(notPlugin, ".claude-plugin", "plugin.json"), "{}");
      await commitAll(notPlugin, "claude");
      await expect(service.preview({ input: notPlugin })).rejects.toThrow(/Claude Code/);
    } finally {
      await fsPromises.rm(notPlugin, { recursive: true, force: true });
    }

    // Subpath installs are parsed but rejected in v1.
    await expect(service.preview({ input: remoteDir, subpath: "sub" })).rejects.toThrow(/v2/);

    // Unknown ref.
    await expect(service.preview({ input: remoteDir, ref: "does-not-exist" })).rejects.toThrow(
      /not found on the remote/
    );

    // Nothing was written by any of the failures above.
    expect(await pathExists(path.join(pluginsDir(), "demo-plugin"))).toBe(false);
    expect(await registry()).toEqual([]);
    expect(await stagingLeftovers()).toEqual([]);

    // Disabled experiment gates every method.
    enabled = false;
    await expect(service.preview({ input: remoteDir })).rejects.toThrow(/not enabled/);
    await expect(service.list()).rejects.toThrow(/not enabled/);
    enabled = true;

    // Remote moved between preview and install: the exact consented SHA is
    // installed (never the newer unreviewed tip). If the SHA became
    // unfetchable, install fails with "moved since the preview" instead.
    const preview = await service.preview({ input: remoteDir });
    await writePluginFixture(remoteDir, { version: "9.9.9" });
    await commitAll(remoteDir, "moved");
    const entry = await service.install({
      source: preview.source,
      expectedSha: preview.lockedSha,
    });
    expect(entry.lockedSha).toBe(preview.lockedSha);
    expect(entry.manifest?.version).toBe("1.0.0");
    const installedManifest = JSON.parse(
      await fsPromises.readFile(path.join(pluginsDir(), "demo-plugin", "plugin.json"), "utf8")
    ) as { version: string };
    expect(installedManifest.version).toBe("1.0.0");
  });

  test("registry survives config.json rewrites and drops traversal names on read", async () => {
    const preview = await service.preview({ input: remoteDir });
    await service.install({ source: preview.source, expectedSha: preview.lockedSha });

    // Registry is a standalone file: rebuilding config.json (what older
    // builds do on every save) cannot drop it.
    await config.editConfig((cfg) => {
      cfg.defaultModel = "openai:gpt-4o";
      return cfg;
    });
    expect(await registry()).toHaveLength(1);
    expect((await service.list())[0]).toMatchObject({ name: "demo-plugin", managed: true });

    // Malicious/corrupt entries with traversal names must never reach the
    // filesystem layer: uninstall of ".." would delete the entire mux root.
    const onDisk = JSON.parse(await fsPromises.readFile(registryFile(), "utf8")) as {
      plugins: unknown[];
    };
    const template = onDisk.plugins[0] as Record<string, unknown>;
    onDisk.plugins.push({ ...template, name: ".." }, { ...template, name: "a/../b" });
    await fsPromises.writeFile(registryFile(), JSON.stringify(onDisk));

    const items = await service.list();
    expect(items.map((item) => item.name)).toEqual(["demo-plugin"]);
    await expect(service.uninstall({ name: "..", deletePluginData: false })).rejects.toThrow(
      /not a managed plugin/
    );
  });

  test("install rolls back the promoted dir when the registry write fails", async () => {
    const preview = await service.preview({ input: remoteDir });

    // Occupy the registry path with a directory so the atomic write's rename fails.
    await fsPromises.mkdir(registryFile(), { recursive: true });
    await expect(
      service.install({ source: preview.source, expectedSha: preview.lockedSha })
    ).rejects.toThrow(/persist the plugin registry/);

    // No partial state: the promoted dir was rolled back.
    expect(await pathExists(path.join(pluginsDir(), "demo-plugin"))).toBe(false);
    expect(await stagingLeftovers()).toEqual([]);

    // Clearing the obstruction lets the same consented install succeed.
    await fsPromises.rmdir(registryFile());
    const entry = await service.install({ source: preview.source, expectedSha: preview.lockedSha });
    expect(entry.name).toBe("demo-plugin");
    expect(await registry()).toHaveLength(1);
  });

  test("falls back to a branch clone when the remote refuses direct SHA fetches", async () => {
    // GitHub-style servers can reject fetching unadvertised objects; simulate
    // by pointing the exact-SHA fetch at a file:// remote with SHA-in-want
    // disabled, so only the advertised branch tip is fetchable.
    await git(remoteDir, "config", "uploadpack.allowAnySHA1InWant", "false");
    await git(remoteDir, "config", "uploadpack.allowReachableSHA1InWant", "false");
    const fileUrl = `file://${remoteDir}`;

    const preview = await service.preview({ input: fileUrl });
    const entry = await service.install({ source: preview.source, expectedSha: preview.lockedSha });
    expect(entry.lockedSha).toBe(preview.lockedSha);
    expect(await pathExists(path.join(pluginsDir(), "demo-plugin", "plugin.json"))).toBe(true);
    expect(await stagingLeftovers()).toEqual([]);
  });

  test("list surfaces unmanaged plugin dirs read-only and missing managed installs", async () => {
    // Unmanaged: a directory dropped into the container by hand.
    const unmanagedDir = path.join(pluginsDir(), "handmade");
    await fsPromises.mkdir(unmanagedDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(unmanagedDir, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "handmade" })
    );

    // Missing managed install: registry entry without a directory.
    const preview = await service.preview({ input: remoteDir });
    await service.install({ source: preview.source, expectedSha: preview.lockedSha });
    await fsPromises.rm(path.join(pluginsDir(), "demo-plugin"), { recursive: true, force: true });

    const items = await service.list();
    expect(items).toHaveLength(2);
    const managed = items.find((item) => item.name === "demo-plugin");
    expect(managed).toMatchObject({ managed: true, present: false, version: "1.0.0" });
    const unmanaged = items.find((item) => item.name === "handmade");
    expect(unmanaged).toMatchObject({ managed: false, present: true });
  });
});

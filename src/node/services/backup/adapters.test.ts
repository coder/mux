import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Config } from "@/node/config";
import type { ProjectsConfig } from "@/common/types/project";
import type { SettingsBackupInput } from "@/common/orpc/schemas/backup";
import { execFileAsync } from "@/node/utils/disposableExec";
import { createBackupGitRepo, createBackupPayloadStore } from "./adapters";

async function git(args: string[]): Promise<string> {
  using process = execFileAsync("git", args);
  return (await process.result).stdout.trim();
}

class TestConfig extends Config {
  state: ProjectsConfig = { projects: new Map() };

  override loadConfigOrDefault(): ProjectsConfig {
    return this.state;
  }

  override editConfig(edit: (config: ProjectsConfig) => ProjectsConfig): Promise<void> {
    this.state = edit(this.state);
    return Promise.resolve();
  }
}

describe("backup adapters", () => {
  let tempDir: string;
  let muxRoot: string;
  let originPath: string;
  let cacheRoot: string;
  let settings: SettingsBackupInput;
  let config: TestConfig;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-backup-adapters-"));
    muxRoot = path.join(tempDir, "mux-root");
    originPath = path.join(tempDir, "origin.git");
    cacheRoot = path.join(tempDir, "cache");
    await fs.mkdir(muxRoot, { recursive: true });
    await git(["init", "--bare", "--initial-branch=main", originPath]);
    settings = { repoUrl: originPath, branch: "main", path: "mux" };
    config = new TestConfig(muxRoot);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeMuxFile(relativePath: string, content: string): Promise<void> {
    const absolutePath = path.join(muxRoot, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf-8");
  }

  it("exports, pushes, and reports a second push as unchanged", async () => {
    await writeMuxFile("AGENTS.md", "global instructions\n");
    await writeMuxFile("skills/demo/SKILL.md", "demo skill\n");
    const gitRepo = createBackupGitRepo({ cacheRoot });
    const payload = createBackupPayloadStore({ config });

    const repository = await gitRepo.prepare(settings);
    expect(repository.remoteCommit).toBeNull();

    await payload.exportTo({ repositoryRoot: repository.rootDir, managedPath: settings.path });
    const changes = await gitRepo.getPushChanges(repository, settings.path);
    expect(changes.map((change) => change.path)).toContain("mux/AGENTS.md");

    const pushed = await gitRepo.commitAndPush(repository, {
      managedPath: settings.path,
      message: "Back up Mux settings",
      expectedRemoteCommit: repository.remoteCommit,
    });
    expect(pushed.changed).toBe(true);
    expect(await git(["--git-dir", originPath, "rev-parse", "refs/heads/main"])).toBe(
      pushed.commit
    );

    const second = await gitRepo.prepare(settings);
    await payload.exportTo({ repositoryRoot: second.rootDir, managedPath: settings.path });
    const unchanged = await gitRepo.commitAndPush(second, {
      managedPath: settings.path,
      message: "Back up Mux settings",
      expectedRemoteCommit: second.remoteCommit,
    });
    expect(unchanged.changed).toBe(false);
    expect(unchanged.commit).toBe(pushed.commit);
    expect(await gitRepo.getPushChanges(second, settings.path)).toEqual([]);
  });

  it("reports no restore changes when the backup matches local state", async () => {
    await writeMuxFile("AGENTS.md", "unchanged\n");
    const gitRepo = createBackupGitRepo({ cacheRoot });
    const payload = createBackupPayloadStore({ config });

    const repository = await gitRepo.prepare(settings);
    await payload.exportTo({ repositoryRoot: repository.rootDir, managedPath: settings.path });

    const preview = await payload.previewRestore({
      repositoryRoot: repository.rootDir,
      managedPath: settings.path,
    });
    expect(preview.changes).toEqual([]);
  });

  it("does not report a value the backup redacted as a restore change", async () => {
    await writeMuxFile(
      "mcp.jsonc",
      `{
  "servers": {
    "api": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer local-secret" }
    }
  }
}
`
    );
    const gitRepo = createBackupGitRepo({ cacheRoot });
    const payload = createBackupPayloadStore({ config });

    const repository = await gitRepo.prepare(settings);
    await payload.exportTo({ repositoryRoot: repository.rootDir, managedPath: settings.path });

    const preview = await payload.previewRestore({
      repositoryRoot: repository.rootDir,
      managedPath: settings.path,
    });
    expect(preview.changes).toEqual([]);
  });

  it("reports preferences as changed only when the merge would change them", async () => {
    config.state = { projects: new Map(), userPreferences: { appearance: { theme: "dark" } } };
    const gitRepo = createBackupGitRepo({ cacheRoot });
    const payload = createBackupPayloadStore({ config });

    const repository = await gitRepo.prepare(settings);
    await payload.exportTo({ repositoryRoot: repository.rootDir, managedPath: settings.path });

    config.state = {
      projects: new Map(),
      userPreferences: { appearance: { theme: "dark", vimEnabled: true } },
    };
    const unchanged = await payload.previewRestore({
      repositoryRoot: repository.rootDir,
      managedPath: settings.path,
    });
    expect(unchanged.changes).toEqual([]);

    config.state = { projects: new Map(), userPreferences: { appearance: { theme: "light" } } };
    const changed = await payload.previewRestore({
      repositoryRoot: repository.rootDir,
      managedPath: settings.path,
    });
    expect(changed.changes).toEqual([{ status: "M", path: "preferences.json" }]);
  });

  it("refuses to write through a symlinked managed-path ancestor", async () => {
    const gitRepo = createBackupGitRepo({ cacheRoot });
    const payload = createBackupPayloadStore({ config });
    const repository = await gitRepo.prepare(settings);

    const outside = path.join(tempDir, "outside");
    await fs.mkdir(path.join(outside, "mux"), { recursive: true });
    await fs.writeFile(path.join(outside, "mux", "keep.txt"), "keep me\n", "utf-8");
    await fs.symlink(outside, path.join(repository.rootDir, "linked"));

    try {
      await payload.exportTo({ repositoryRoot: repository.rootDir, managedPath: "linked/mux" });
      throw new Error("Expected the symlinked ancestor to be rejected");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).toContain("symlink");
    }
    expect(await fs.readFile(path.join(outside, "mux", "keep.txt"), "utf-8")).toBe("keep me\n");
  });

  it("passes a configured token to the credential ladder", async () => {
    const tokens: Array<string | null> = [];
    const gitRepo = createBackupGitRepo({
      cacheRoot,
      getToken: () => {
        tokens.push("configured-token");
        return "configured-token";
      },
    });

    await gitRepo.validate(settings);

    expect(tokens).toEqual(["configured-token"]);
  });

  it("refuses to operate on a repository that was never prepared", async () => {
    const gitRepo = createBackupGitRepo({ cacheRoot });
    const repository = {
      rootDir: path.join(cacheRoot, "missing"),
      credential: "ssh",
      remoteCommit: null,
    } as const;
    try {
      await gitRepo.getPushChanges(repository, settings.path);
      throw new Error("Expected the unprepared repository to be rejected");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).toContain("was not prepared");
    }
  });

  it("previews restore changes against local files and keeps local-only files", async () => {
    await writeMuxFile("AGENTS.md", "backed up\n");
    await writeMuxFile("agents/shared.md", "shared agent\n");
    const gitRepo = createBackupGitRepo({ cacheRoot });
    const payload = createBackupPayloadStore({ config });

    const repository = await gitRepo.prepare(settings);
    await payload.exportTo({ repositoryRoot: repository.rootDir, managedPath: settings.path });

    await writeMuxFile("AGENTS.md", "locally edited\n");
    await fs.rm(path.join(muxRoot, "agents/shared.md"));
    await writeMuxFile("agents/local-only.md", "local only\n");

    const preview = await payload.previewRestore({
      repositoryRoot: repository.rootDir,
      managedPath: settings.path,
    });
    expect(preview.changes).toEqual([
      { status: "M", path: "AGENTS.md" },
      { status: "A", path: "agents/shared.md" },
    ]);
    expect(preview.localOnlyFiles).toEqual(["agents/local-only.md"]);
  });

  it("restores files and persists merged preferences through config", async () => {
    config.state = { projects: new Map(), userPreferences: { appearance: { theme: "dark" } } };
    await writeMuxFile("AGENTS.md", "backed up\n");
    const gitRepo = createBackupGitRepo({ cacheRoot });
    const payload = createBackupPayloadStore({ config });

    const repository = await gitRepo.prepare(settings);
    await payload.exportTo({ repositoryRoot: repository.rootDir, managedPath: settings.path });

    await writeMuxFile("AGENTS.md", "locally edited\n");
    await writeMuxFile("agents/local-only.md", "local only\n");
    config.state = { projects: new Map(), userPreferences: { appearance: { theme: "light" } } };

    const restored = await payload.restore({
      repositoryRoot: repository.rootDir,
      managedPath: settings.path,
    });

    expect(await fs.readFile(path.join(muxRoot, "AGENTS.md"), "utf-8")).toBe("backed up\n");
    expect(restored.changedFiles).toEqual(["AGENTS.md"]);
    expect(restored.localOnlyFiles).toEqual(["agents/local-only.md"]);
    expect(config.state.userPreferences?.appearance?.theme).toBe("dark");
    expect(await fs.readFile(path.join(muxRoot, "agents/local-only.md"), "utf-8")).toBe(
      "local only\n"
    );
  });

  it("writes a safety snapshot of the current local files", async () => {
    await writeMuxFile("AGENTS.md", "before restore\n");
    const payload = createBackupPayloadStore({ config });
    const snapshotRoot = path.join(tempDir, "snapshot");

    await payload.writeSafetySnapshot(snapshotRoot);

    expect(await fs.readFile(path.join(snapshotRoot, "AGENTS.md"), "utf-8")).toBe(
      "before restore\n"
    );
    expect(await fs.readFile(path.join(snapshotRoot, "manifest.json"), "utf-8")).toContain(
      "AGENTS.md"
    );
  });

  it("reports a renamed managed file by its destination path", async () => {
    await writeMuxFile("agents/first.md", "agent\n");
    const gitRepo = createBackupGitRepo({ cacheRoot });
    const payload = createBackupPayloadStore({ config });

    const repository = await gitRepo.prepare(settings);
    await payload.exportTo({ repositoryRoot: repository.rootDir, managedPath: settings.path });
    await gitRepo.commitAndPush(repository, {
      managedPath: settings.path,
      message: "Back up Mux settings",
      expectedRemoteCommit: repository.remoteCommit,
    });

    await fs.rename(path.join(muxRoot, "agents/first.md"), path.join(muxRoot, "agents/second.md"));
    const next = await gitRepo.prepare(settings);
    await payload.exportTo({ repositoryRoot: next.rootDir, managedPath: settings.path });

    const changes = await gitRepo.getPushChanges(next, settings.path);
    expect(changes.map((change) => change.path)).toContain("mux/agents/second.md");
    expect(changes.every((change) => !change.path.includes(" -> "))).toBe(true);
  });
});

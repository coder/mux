import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileAsync } from "@/node/utils/disposableExec";
import { BackupRepoCache, BackupNonFastForwardError, BackupOriginMismatchError } from "./gitRepo";

async function git(args: string[]): Promise<string> {
  using process = execFileAsync("git", args);
  return (await process.result).stdout.trim();
}

async function writeManagedFile(
  repo: BackupRepoCache,
  name: string,
  content: string
): Promise<void> {
  const filePath = path.join(repo.cachePath, "mux", name);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

describe("BackupRepoCache", () => {
  let tempDir: string;
  let originPath: string;
  let cacheRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-backup-git-"));
    originPath = path.join(tempDir, "origin.git");
    cacheRoot = path.join(tempDir, "cache");
    await git(["init", "--bare", "--initial-branch=main", originPath]);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function createRepo(): BackupRepoCache {
    return new BackupRepoCache({ repoUrl: originPath, branch: "main", cacheRoot });
  }

  it("bootstraps an empty repo, commits the managed path, and pushes", async () => {
    const repo = createRepo();
    expect((await repo.lsRemote()).branchCommit).toBeNull();

    await repo.ensureCache();
    expect(await repo.fetch()).toBeNull();
    expect(await repo.resetHardToRemote()).toBeNull();
    await writeManagedFile(repo, "AGENTS.md", "instructions\n");
    expect(await repo.porcelainStatus("mux")).toContain("mux/AGENTS.md");

    const commit = await repo.stageAndCommit("mux", "Back up settings");
    if (commit === null) throw new Error("Expected the bootstrap commit");
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await repo.push()).toBe(commit);
    expect(await git(["--git-dir", originPath, "rev-parse", "refs/heads/main"])).toBe(commit);
  });

  it("reuses the cache and rejects an origin mismatch", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    await git([
      "-C",
      repo.cachePath,
      "remote",
      "set-url",
      "origin",
      path.join(tempDir, "other.git"),
    ]);

    try {
      await repo.ensureCache();
      throw new Error("Expected origin mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(BackupOriginMismatchError);
    }
  });

  it("reports cache status", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();
    await writeManagedFile(repo, "AGENTS.md", "first\n");
    const commit = await repo.stageAndCommit("mux", "Initial backup");
    if (commit === null) throw new Error("Expected the initial commit");

    await writeManagedFile(repo, "AGENTS.md", "second\n");
    expect(await repo.porcelainStatus("mux")).toContain("mux/AGENTS.md");
  });

  it("rejects a push when the remote branch moved after reset", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();
    await writeManagedFile(repo, "AGENTS.md", "initial\n");
    const initialCommit = await repo.stageAndCommit("mux", "Initial backup");
    if (initialCommit === null) throw new Error("Expected the initial commit");
    await repo.push();

    await repo.fetch();
    await repo.resetHardToRemote();
    await writeManagedFile(repo, "AGENTS.md", "local update\n");
    const localCommit = await repo.stageAndCommit("mux", "Local update");
    if (localCommit === null) throw new Error("Expected the local update commit");

    const otherPath = path.join(tempDir, "other");
    await git(["clone", originPath, otherPath]);
    await fs.writeFile(path.join(otherPath, "remote.txt"), "remote update\n", "utf-8");
    await git(["-C", otherPath, "add", "remote.txt"]);
    await git([
      "-C",
      otherPath,
      "-c",
      "user.name=Other",
      "-c",
      "user.email=other@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Remote update",
    ]);
    await git(["-C", otherPath, "push", "origin", "main"]);

    try {
      await repo.push();
      throw new Error("Expected non-fast-forward rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(BackupNonFastForwardError);
    }
  });
});

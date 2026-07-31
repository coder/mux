import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileAsync } from "@/node/utils/disposableExec";
import { BackupRepoCache, BackupNonFastForwardError, BackupOriginMismatchError } from "./gitRepo";

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

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
    return new BackupRepoCache({
      repoUrl: originPath,
      branch: "main",
      cacheRoot,
      managedPath: "mux",
    });
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

  it("materializes only the managed path and preserves the rest of the branch", async () => {
    // Nothing outside the managed path may reach the filesystem, because a name this
    // platform cannot create (say `linux/CON` on Windows) would fail the checkout before Mux
    // reads its own directory. A scoped commit must still leave that file in the tree.
    const seed = path.join(tempDir, "seed");
    await fs.mkdir(path.join(seed, "outside"), { recursive: true });
    await fs.writeFile(path.join(seed, "outside", "keep.txt"), "outside\n", "utf-8");
    await fs.mkdir(path.join(seed, "mux", "skills", "demo"), { recursive: true });
    await fs.writeFile(path.join(seed, "mux", "skills", "demo", "SKILL.md"), "skill\n", "utf-8");
    await git(["-C", seed, "init", "-q"]);
    await git(["-C", seed, "add", "-A"]);
    await git([
      "-C",
      seed,
      "-c",
      "user.email=t@e",
      "-c",
      "user.name=T",
      "commit",
      "-q",
      "-m",
      "outside content",
    ]);
    await git(["-C", seed, "push", "-q", originPath, "HEAD:refs/heads/main"]);

    const repo = createRepo();
    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();

    expect(await pathExists(path.join(repo.cachePath, "outside"))).toBe(false);
    // A restore reads nested payload files out of this checkout, so the pattern must reach
    // below the managed directory rather than only its direct children.
    expect(await pathExists(path.join(repo.cachePath, "mux/skills/demo/SKILL.md"))).toBe(true);
    await writeManagedFile(repo, "AGENTS.md", "instructions\n");
    const commit = await repo.stageAndCommit("mux", "Back up settings");
    if (commit === null) throw new Error("Expected a commit");
    await repo.push();

    const tracked = await git(["--git-dir", originPath, "ls-tree", "-r", "--name-only", "main"]);
    expect(tracked.split("\n")).toContain("outside/keep.txt");
    expect(tracked.split("\n")).toContain("mux/AGENTS.md");
  });

  it("materializes the managed path when the configured value has a trailing separator", async () => {
    const seed = path.join(tempDir, "slash-seed");
    await fs.mkdir(path.join(seed, "mux"), { recursive: true });
    await fs.writeFile(path.join(seed, "mux", "AGENTS.md"), "managed\n", "utf-8");
    await git(["-C", seed, "init", "-q"]);
    await git(["-C", seed, "add", "-A"]);
    await git([
      "-C",
      seed,
      "-c",
      "user.email=t@e",
      "-c",
      "user.name=T",
      "commit",
      "-q",
      "-m",
      "managed content",
    ]);
    await git(["-C", seed, "push", "-q", originPath, "HEAD:refs/heads/main"]);

    // The settings default is `mux/`, and an unnormalized `/mux//*` sparse pattern selects
    // nothing, so the backup reads as absent and a push lands outside the sparse definition.
    const repo = new BackupRepoCache({
      repoUrl: originPath,
      branch: "main",
      cacheRoot,
      managedPath: "mux/",
    });
    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();

    expect(await pathExists(path.join(repo.cachePath, "mux/AGENTS.md"))).toBe(true);

    await fs.writeFile(path.join(repo.cachePath, "mux", "AGENTS.md"), "updated\n", "utf-8");
    expect(await repo.porcelainStatus("mux/")).toContain("mux/AGENTS.md");
    const commit = await repo.stageAndCommit("mux/", "Back up settings");
    if (commit === null) throw new Error("Expected a commit");
    await repo.push();
    expect(await git(["--git-dir", originPath, "show", "main:mux/AGENTS.md"])).toBe("updated");
  });

  it("treats a managed path containing glob characters literally", async () => {
    const seed = path.join(tempDir, "glob-seed");
    await fs.mkdir(path.join(seed, "mux[1]"), { recursive: true });
    await fs.writeFile(path.join(seed, "mux[1]", "AGENTS.md"), "managed\n", "utf-8");
    await fs.mkdir(path.join(seed, "mux1"), { recursive: true });
    await fs.writeFile(path.join(seed, "mux1", "other.txt"), "sibling\n", "utf-8");
    await git(["-C", seed, "init", "-q"]);
    await git(["-C", seed, "add", "-A"]);
    await git([
      "-C",
      seed,
      "-c",
      "user.email=t@e",
      "-c",
      "user.name=T",
      "commit",
      "-q",
      "-m",
      "glob siblings",
    ]);
    await git(["-C", seed, "push", "-q", originPath, "HEAD:refs/heads/main"]);

    const repo = new BackupRepoCache({
      repoUrl: originPath,
      branch: "main",
      cacheRoot,
      managedPath: "mux[1]",
    });
    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();

    expect(await pathExists(path.join(repo.cachePath, "mux[1]/AGENTS.md"))).toBe(true);
    expect(await pathExists(path.join(repo.cachePath, "mux1"))).toBe(false);

    const stray = path.join(repo.cachePath, "mux1", "stray.txt");
    await fs.mkdir(path.dirname(stray), { recursive: true });
    await fs.writeFile(stray, "untracked\n", "utf-8");
    await repo.cleanManagedPath("mux[1]");
    expect(await pathExists(stray)).toBe(true);

    await fs.writeFile(path.join(repo.cachePath, "mux[1]", "AGENTS.md"), "updated\n", "utf-8");
    const commit = await repo.stageAndCommit("mux[1]", "Back up settings");
    if (commit === null) throw new Error("Expected a commit");
    await repo.push();
    expect(await git(["--git-dir", originPath, "show", `main:mux[1]/AGENTS.md`])).toBe("updated");
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

  it("refuses managed paths that are not a real subdirectory", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();

    for (const unsafe of [".", "./", "..", "mux/../..", "/mux", "mux\\..\\.."]) {
      try {
        await repo.cleanManagedPath(unsafe);
        throw new Error(`Expected '${unsafe}' to be rejected`);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        expect(error.message).toContain("safe relative path");
      }
    }
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

  it("rejects a push when the remote branch disappears after the drift check", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();
    await writeManagedFile(repo, "AGENTS.md", "initial\n");
    if ((await repo.stageAndCommit("mux", "Initial backup")) === null) {
      throw new Error("Expected the initial commit");
    }
    await repo.push();

    await repo.fetch();
    await repo.resetHardToRemote();
    await writeManagedFile(repo, "AGENTS.md", "local update\n");
    if ((await repo.stageAndCommit("mux", "Local update")) === null) {
      throw new Error("Expected the local update commit");
    }

    // Deleting the branch only after the drift check passes leaves the exact window the
    // lease closes: an ordinary push would recreate the branch with the deleted history.
    const originalAssert = repo.assertRemoteUnchanged.bind(repo);
    repo.assertRemoteUnchanged = async () => {
      await originalAssert();
      await git(["-C", originPath, "update-ref", "-d", "refs/heads/main"]);
    };

    try {
      await repo.push();
      throw new Error("Expected the lease to reject the push");
    } catch (error) {
      expect(error).toBeInstanceOf(BackupNonFastForwardError);
    }
    expect(await git(["-C", originPath, "for-each-ref", "refs/heads/main"])).toBe("");
  });
});

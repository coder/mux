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

async function findHardLinkedFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await findHardLinkedFiles(entryPath)));
    } else if (entry.isFile() && (await fs.lstat(entryPath)).nlink > 1) {
      found.push(entryPath);
    }
  }
  return found;
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

  it("uses filtered transport for a local repository", async () => {
    const seed = path.join(tempDir, "local-clone-seed");
    await git(["clone", originPath, seed]);
    await fs.mkdir(path.join(seed, "mux"), { recursive: true });
    await fs.writeFile(path.join(seed, "mux", "AGENTS.md"), "managed\n", "utf-8");
    await fs.writeFile(path.join(seed, "unrelated.txt"), "outside managed path\n", "utf-8");
    await git(["-C", seed, "add", "-A"]);
    await git(["-C", seed, "-c", "user.email=t@e", "-c", "user.name=T", "commit", "-m", "seed"]);
    await git(["-C", seed, "push", "origin", "HEAD:main"]);

    const repo = createRepo();
    await repo.ensureCache();

    expect(await findHardLinkedFiles(path.join(repo.cachePath, ".git"))).toEqual([]);
    const localObjects = async () =>
      await git(["-C", repo.cachePath, "cat-file", "--batch-all-objects", "--batch-check"]);
    expect(await localObjects()).not.toContain(" blob ");

    await fs.writeFile(path.join(seed, "mux", "second.md"), "second managed blob\n", "utf-8");
    await fs.writeFile(path.join(seed, "unrelated-2.txt"), "second unrelated blob\n", "utf-8");
    await git(["-C", seed, "add", "-A"]);
    await git(["-C", seed, "-c", "user.email=t@e", "-c", "user.name=T", "commit", "-m", "next"]);
    await git(["-C", seed, "push", "origin", "HEAD:main"]);
    const pushedCommit = await git(["-C", seed, "rev-parse", "HEAD"]);

    expect(await repo.fetch()).toBe(pushedCommit);
    expect(await findHardLinkedFiles(path.join(repo.cachePath, ".git"))).toEqual([]);
    expect(await localObjects()).not.toContain(" blob ");
  });

  it("recovers malformed cache config without losing SHA-256 object format", async () => {
    const shaOrigin = path.join(tempDir, "sha256-origin.git");
    await git(["init", "--bare", "--object-format=sha256", "--initial-branch=main", shaOrigin]);
    const seed = path.join(tempDir, "sha256-seed");
    await git(["clone", shaOrigin, seed]);
    await fs.mkdir(path.join(seed, "mux"), { recursive: true });
    await fs.writeFile(path.join(seed, "mux", "AGENTS.md"), "sha256 managed\n", "utf-8");
    await git(["-C", seed, "add", "-A"]);
    await git(["-C", seed, "-c", "user.email=t@e", "-c", "user.name=T", "commit", "-m", "seed"]);
    await git(["-C", seed, "push", "origin", "HEAD:main"]);

    const repo = new BackupRepoCache({
      repoUrl: shaOrigin,
      branch: "main",
      cacheRoot,
      managedPath: "mux",
    });
    await repo.ensureCache();
    await fs.writeFile(path.join(repo.cachePath, ".git", "config"), "[core\n", "utf-8");

    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();

    expect(await git(["-C", repo.cachePath, "config", "--get", "extensions.objectformat"])).toBe(
      "sha256"
    );
    expect(await fs.readFile(path.join(repo.cachePath, "mux", "AGENTS.md"), "utf-8")).toBe(
      "sha256 managed\n"
    );
  });

  it("materializes a blob-filtered clone through the credential ladder", async () => {
    const seedPath = path.join(tempDir, "seed");
    await git(["clone", originPath, seedPath]);
    await fs.mkdir(path.join(seedPath, "mux"), { recursive: true });
    await fs.writeFile(path.join(seedPath, "mux", "note.md"), "managed content\n", "utf-8");
    await git(["-C", seedPath, "add", "."]);
    await git([
      "-C",
      seedPath,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-m",
      "seed",
    ]);
    await git(["-C", seedPath, "push", "origin", "HEAD:main"]);

    const repo = new BackupRepoCache({
      repoUrl: `file://${originPath}`,
      branch: "main",
      cacheRoot,
      managedPath: "mux",
    });
    await repo.ensureCache();
    await repo.fetch();
    // The clone really is blob-filtered, so the checkout below must lazy-fetch.
    const objects = await git([
      "-C",
      repo.cachePath,
      "cat-file",
      "--batch-all-objects",
      "--batch-check",
    ]);
    expect(objects).not.toContain(" blob ");

    // A fresh instance has recorded no credential yet, so the getter proves the
    // materializing checkout ran through the ladder rather than as a bare local command.
    const reader = new BackupRepoCache({
      repoUrl: `file://${originPath}`,
      branch: "main",
      cacheRoot,
      managedPath: "mux",
    });
    expect(await reader.resetHardToRemote()).not.toBeNull();
    expect(reader.credential).toBe("ambient");
    const restored = await fs.readFile(path.join(reader.cachePath, "mux", "note.md"), "utf-8");
    expect(restored).toBe("managed content\n");
  });

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

  it("does not report a server-side push denial as remote drift", async () => {
    // A protected branch or policy hook. Telling the user the backup changed would send them to
    // re-read a backup that is not stale, and the push would be refused again.
    const hook = path.join(originPath, "hooks", "pre-receive");
    await fs.writeFile(hook, "#!/bin/sh\necho 'policy: review required' >&2\nexit 1\n", "utf-8");
    await fs.chmod(hook, 0o755);
    const repo = createRepo();
    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();
    await writeManagedFile(repo, "AGENTS.md", "instructions\n");
    const commit = await repo.stageAndCommit("mux", "Back up settings");
    if (commit === null) throw new Error("Expected a commit");

    const rejected = await repo.push().then(
      () => null,
      (error: unknown) => error
    );

    expect(rejected).not.toBeInstanceOf(BackupNonFastForwardError);
    expect((rejected as Error | null)?.message).toContain("pre-receive hook declined");
  });

  it("keeps payload bytes verbatim when git is asked to convert line endings", async () => {
    const seed = path.join(tempDir, "crlf-seed");
    await fs.mkdir(path.join(seed, "mux"), { recursive: true });
    await fs.writeFile(path.join(seed, "mux", "AGENTS.md"), "line one\nline two\n", "utf-8");
    // The backup repository asking for conversion itself, which outranks any config setting.
    await fs.writeFile(path.join(seed, ".gitattributes"), "* text=auto eol=crlf\n", "utf-8");
    await git(["-C", seed, "init", "-q"]);
    await git(["-C", seed, "-c", "core.autocrlf=false", "add", "-A"]);
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
      "ask for crlf",
    ]);
    await git(["-C", seed, "push", "-q", originPath, "HEAD:refs/heads/main"]);

    // core.autocrlf=true is an ordinary Windows setting. The manifest records a SHA-256 per
    // file and a restore writes what it reads, so any conversion here corrupts both.
    const globalConfig = path.join(tempDir, "converting-gitconfig");
    await fs.writeFile(globalConfig, "[core]\n\tautocrlf = true\n", "utf-8");
    const repo = new BackupRepoCache({
      repoUrl: originPath,
      branch: "main",
      cacheRoot,
      managedPath: "mux",
      env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig },
    });
    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();

    expect(await fs.readFile(path.join(repo.cachePath, "mux/AGENTS.md"), "utf-8")).toBe(
      "line one\nline two\n"
    );
  });

  it("keeps payload bytes verbatim when the repository asks for ident expansion", async () => {
    const seed = path.join(tempDir, "ident-seed");
    await fs.mkdir(path.join(seed, "mux"), { recursive: true });
    // $Id$ is what the ident attribute expands at checkout; the manifest hash covers the
    // unexpanded bytes, so expansion makes every later Preview/Restore reject the backup.
    await fs.writeFile(path.join(seed, "mux", "AGENTS.md"), "ident line: $Id$\n", "utf-8");
    await fs.writeFile(path.join(seed, ".gitattributes"), "mux/** ident\n", "utf-8");
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
      "ask for ident",
    ]);
    await git(["-C", seed, "push", "-q", originPath, "HEAD:refs/heads/main"]);

    const repo = createRepo();
    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();

    expect(await fs.readFile(path.join(repo.cachePath, "mux/AGENTS.md"), "utf-8")).toBe(
      "ident line: $Id$\n"
    );
  });

  it("rejects a cache whose config redirects the working tree", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    // With this key in place, `clean -fdx -- mux` would delete `mux/` beneath the redirected
    // worktree instead of inside the cache.
    const outside = path.join(tempDir, "outside-worktree");
    await fs.mkdir(path.join(outside, "mux"), { recursive: true });
    await fs.writeFile(path.join(outside, "mux", "victim.txt"), "keep\n", "utf-8");
    await git(["-C", repo.cachePath, "config", "core.worktree", outside]);

    const failure = await repo.ensureCache().then(
      () => null,
      (error: unknown) => error
    );

    expect((failure as Error | null)?.message).toContain("core.worktree");
    expect(await fs.readFile(path.join(outside, "mux", "victim.txt"), "utf-8")).toBe("keep\n");
  });

  it("rejects a cache whose config is a symlink and leaves the target unwritten", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    const configPath = path.join(repo.cachePath, ".git", "config");
    const target = path.join(tempDir, "victim-config");
    const targetContent = "[core]\n\tbare = false\n";
    await fs.writeFile(target, targetContent, "utf-8");
    await fs.rm(configPath);
    await fs.symlink(target, configPath);

    const failure = await repo.ensureCache().then(
      () => null,
      (error: unknown) => error
    );

    expect((failure as Error | null)?.message).toContain("symlink");
    expect(await fs.readFile(target, "utf-8")).toBe(targetContent);
  });

  it("drops a cache-local pushInsteadOf rewrite so the push reaches the configured repository", async () => {
    const evil = path.join(tempDir, "evil.git");
    await git(["init", "--bare", "--initial-branch=main", evil]);
    const repo = createRepo();
    await repo.ensureCache();
    // Cache-local config is not the user's own git configuration: this rewrite redirects the
    // push while the stored `remote.origin.url` still reads as the configured repository.
    await git(["-C", repo.cachePath, "config", `url.${evil}.pushInsteadOf`, originPath]);

    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();
    await writeManagedFile(repo, "AGENTS.md", "instructions\n");
    const commit = await repo.stageAndCommit("mux", "Back up settings");
    if (commit === null) throw new Error("Expected a commit");
    await repo.push();

    expect(await git(["--git-dir", originPath, "rev-parse", "refs/heads/main"])).toBe(commit);
    const evilRefs = await git(["--git-dir", evil, "show-ref"]).then(
      (refs) => refs,
      () => "none"
    );
    expect(evilRefs).toBe("none");
  });

  it("does not run hooks planted in the cache", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    const marker = path.join(tempDir, "hook-ran");
    const hookPath = path.join(repo.cachePath, ".git", "hooks", "pre-commit");
    await fs.mkdir(path.dirname(hookPath), { recursive: true });
    await fs.writeFile(hookPath, `#!/bin/sh\ntouch '${marker}'\n`, "utf-8");
    await fs.chmod(hookPath, 0o755);

    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();
    // Post-sanitize tamper: the rebuilt config pins hooksPath off too, so drop that pin to
    // prove the per-invocation option protects commands after the config is altered again.
    await git(["-C", repo.cachePath, "config", "--unset", "core.hookspath"]);
    await writeManagedFile(repo, "AGENTS.md", "instructions\n");
    expect(await repo.stageAndCommit("mux", "Back up settings")).not.toBeNull();

    expect(await pathExists(marker)).toBe(false);
  });

  it("ignores replace refs when materializing the backup", async () => {
    const seed = path.join(tempDir, "replace-seed");
    await fs.mkdir(path.join(seed, "mux"), { recursive: true });
    await fs.writeFile(path.join(seed, "mux", "note.md"), "original\n", "utf-8");
    await git(["-C", seed, "init", "-q"]);
    await git(["-C", seed, "add", "-A"]);
    await git(["-C", seed, "-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "-m", "s"]);
    await git(["-C", seed, "push", "-q", originPath, "HEAD:refs/heads/main"]);

    const repo = createRepo();
    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();

    // A replace ref substitutes another object's bytes at read time without changing any
    // commit hash, so a tampered cache could hand later reads different content than the
    // commit everything else verified.
    const original = await git([
      "-C",
      repo.cachePath,
      "rev-parse",
      "refs/remotes/origin/main:mux/note.md",
    ]);
    const evilFile = path.join(tempDir, "evil-content");
    await fs.writeFile(evilFile, "evil\n", "utf-8");
    const evil = await git(["-C", repo.cachePath, "hash-object", "-w", evilFile]);
    await git(["-C", repo.cachePath, "update-ref", `refs/replace/${original}`, evil]);
    await fs.rm(path.join(repo.cachePath, "mux", "note.md"));

    await repo.resetHardToRemote();

    expect(await fs.readFile(path.join(repo.cachePath, "mux", "note.md"), "utf-8")).toBe(
      "original\n"
    );
  });

  it("removes worktree-scoped config left behind in the cache", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    const outside = path.join(tempDir, "outside-worktree");
    await fs.mkdir(path.join(outside, "mux"), { recursive: true });
    await fs.writeFile(path.join(outside, "mux", "victim.txt"), "keep\n", "utf-8");
    // `git sparse-checkout set` used to enable this extension, and the worktree-scoped file
    // it activates is trusted by git like the main config, including for `core.worktree`.
    await git(["-C", repo.cachePath, "config", "extensions.worktreeConfig", "true"]);
    await git(["-C", repo.cachePath, "config", "--worktree", "core.worktree", outside]);

    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();
    await repo.cleanManagedPath("mux");

    expect(await pathExists(path.join(repo.cachePath, ".git", "config.worktree"))).toBe(false);
    expect(await fs.readFile(path.join(outside, "mux", "victim.txt"), "utf-8")).toBe("keep\n");
  });

  it("ignores inherited GIT_DIR and GIT_WORK_TREE instead of operating on their repository", async () => {
    const seed = path.join(tempDir, "env-seed");
    await fs.mkdir(path.join(seed, "mux"), { recursive: true });
    await fs.writeFile(path.join(seed, "mux", "AGENTS.md"), "managed\n", "utf-8");
    await git(["-C", seed, "init", "-q"]);
    await git(["-C", seed, "add", "-A"]);
    await git(["-C", seed, "-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "-m", "s"]);
    await git(["-C", seed, "push", "-q", originPath, "HEAD:refs/heads/main"]);

    // Mux may be launched from a git hook or alias, where these are exported. Git reads them
    // ahead of `-C`, so without stripping, checkout materializes under the outside worktree
    // and `clean -fdx -- mux` deletes the victim file there.
    const outside = path.join(tempDir, "outside-repo");
    await git(["init", "-q", outside]);
    await fs.mkdir(path.join(outside, "mux"), { recursive: true });
    await fs.writeFile(path.join(outside, "mux", "victim.txt"), "keep\n", "utf-8");
    const repo = new BackupRepoCache({
      repoUrl: originPath,
      branch: "main",
      cacheRoot,
      managedPath: "mux",
      env: {
        ...process.env,
        GIT_DIR: path.join(outside, ".git"),
        GIT_WORK_TREE: outside,
      },
    });

    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();
    await repo.cleanManagedPath("mux");

    expect(await fs.readFile(path.join(repo.cachePath, "mux/AGENTS.md"), "utf-8")).toBe(
      "managed\n"
    );
    expect(await fs.readFile(path.join(outside, "mux", "victim.txt"), "utf-8")).toBe("keep\n");
  });

  it("ignores environment-supplied git config instead of letting it redirect the push", async () => {
    const evil = path.join(tempDir, "env-evil.git");
    await git(["init", "--bare", "--initial-branch=main", evil]);
    // Command-scope config arrives through the environment (git -c exports it to hooks), so
    // the cache config rebuild cannot remove it: only stripping the variables can.
    const repo = new BackupRepoCache({
      repoUrl: originPath,
      branch: "main",
      cacheRoot,
      managedPath: "mux",
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.${evil}.pushInsteadOf`,
        GIT_CONFIG_VALUE_0: originPath,
        GIT_CONFIG_PARAMETERS: `'url.${evil}.pushInsteadOf'='${originPath}'`,
      },
    });

    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();
    await writeManagedFile(repo, "AGENTS.md", "instructions\n");
    const commit = await repo.stageAndCommit("mux", "Back up settings");
    if (commit === null) throw new Error("Expected a commit");
    await repo.push();

    expect(await git(["--git-dir", originPath, "rev-parse", "refs/heads/main"])).toBe(commit);
    const evilRefs = await git(["--git-dir", evil, "show-ref"]).then(
      (refs) => refs,
      () => "none"
    );
    expect(evilRefs).toBe("none");
  });

  it("preserves valid platform flags and drops malformed values", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    const configPath = path.join(repo.cachePath, ".git", "config");
    const retained = [
      ["core.filemode", "false"],
      ["core.logallrefupdates", "true"],
      ["core.ignorecase", "false"],
      ["core.precomposeunicode", "true"],
      ["core.symlinks", "false"],
      ["extensions.partialclone", "origin"],
    ] as const;
    for (const [key, value] of retained) {
      await git(["config", "--file", configPath, key, value]);
    }

    await repo.ensureCache();
    for (const [key, value] of retained) {
      expect(await git(["config", "--file", configPath, "--get", key])).toBe(value);
    }

    for (const [key] of retained) {
      await git(["config", "--file", configPath, key, "garbage"]);
    }
    await git(["config", "--file", configPath, "extensions.objectformat", "garbage"]);
    await git(["config", "--file", configPath, "core.repositoryformatversion", "garbage"]);

    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();

    expect(await repo.porcelainStatus("mux")).toBe("");
    expect(
      await git(["config", "--file", configPath, "--get", "core.repositoryformatversion"])
    ).toBe("1");
    expect(await fs.readFile(configPath, "utf-8")).not.toContain("garbage");
  });

  it("repairs a cache whose config was left claiming the repository is bare", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    // An interrupted tool or stray edit; preserved, it fails every worktree command with
    // "this operation must be run in a work tree" until the cache is deleted by hand.
    await git(["-C", repo.cachePath, "config", "core.bare", "true"]);

    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();

    expect(await repo.porcelainStatus("mux")).toBe("");
  });

  it("rejects a cache with symlinked git metadata and leaves the target unwritten", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();
    // A fetch writes the fetched ref record through this link, truncating whatever it names.
    const victim = path.join(tempDir, "victim-fetch-head");
    await fs.writeFile(victim, "victim content\n", "utf-8");
    await fs.rm(path.join(repo.cachePath, ".git", "FETCH_HEAD"), { force: true });
    await fs.symlink(victim, path.join(repo.cachePath, ".git", "FETCH_HEAD"));

    const failure = await repo
      .ensureCache()
      .then(() => repo.fetch())
      .then(
        () => null,
        (error: unknown) => error
      );

    expect((failure as Error | null)?.message).toContain("symlink");
    expect(await fs.readFile(victim, "utf-8")).toBe("victim content\n");
  });

  it("severs hard-linked git metadata before fetch overwrites its outside alias", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();
    await writeManagedFile(repo, "AGENTS.md", "instructions\n");
    if ((await repo.stageAndCommit("mux", "Back up settings")) === null) {
      throw new Error("Expected a commit");
    }
    await repo.push();
    await repo.fetch();

    const victim = path.join(tempDir, "victim-hard-link");
    await fs.writeFile(victim, "victim content\n", "utf-8");
    const fetchHead = path.join(repo.cachePath, ".git", "FETCH_HEAD");
    await fs.rm(fetchHead, { force: true });
    await fs.link(victim, fetchHead);

    await repo.ensureCache();
    await repo.fetch();

    expect(await fs.readFile(victim, "utf-8")).toBe("victim content\n");
    expect((await fs.lstat(fetchHead)).nlink).toBe(1);
  });

  it("migrates hard-linked objects left by older local clones", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();
    await writeManagedFile(repo, "AGENTS.md", "instructions\n");
    const commit = await repo.stageAndCommit("mux", "Back up settings");
    if (commit === null) throw new Error("Expected a commit");
    await repo.push();

    const objectPath = path.join(
      repo.cachePath,
      ".git",
      "objects",
      commit.slice(0, 2),
      commit.slice(2)
    );
    const outsideAlias = path.join(tempDir, "legacy-object-alias");
    await fs.link(objectPath, outsideAlias);
    const objectBytes = await fs.readFile(outsideAlias);

    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();

    expect(await fs.readFile(outsideAlias)).toEqual(objectBytes);
    expect((await fs.lstat(objectPath)).nlink).toBe(1);
  });

  it("rejects symlinked git metadata below the top level of .git", async () => {
    const repo = createRepo();
    await repo.ensureCache();
    // Reflogs are appended to on every ref update, through a symlink like any other
    // metadata file, so the rule has to hold for the whole tree rather than only the
    // filenames at the top.
    const victim = path.join(tempDir, "victim-reflog");
    await fs.writeFile(victim, "victim content\n", "utf-8");
    const reflog = path.join(repo.cachePath, ".git", "logs", "HEAD");
    await fs.mkdir(path.dirname(reflog), { recursive: true });
    await fs.rm(reflog, { force: true });
    await fs.symlink(victim, reflog);

    const failure = await repo.ensureCache().then(
      () => null,
      (error: unknown) => error
    );

    expect((failure as Error | null)?.message).toContain("symlink");
    expect(await fs.readFile(victim, "utf-8")).toBe("victim content\n");
  });

  it("keeps the cache tree traversable by its owner alone", async () => {
    // The tree holds exported payload bytes and unredacted restore snapshots, written with
    // modes that assume nobody else can traverse this far.
    const repo = createRepo();
    const previousUmask = process.umask(0o022);
    try {
      await repo.ensureCache();
    } finally {
      process.umask(previousUmask);
    }

    expect((await fs.stat(cacheRoot)).mode & 0o077).toBe(0);
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

  it("anchors relative local repository paths to the cache root's parent", async () => {
    const seed = path.join(tempDir, "relative-origin-seed");
    await git(["clone", originPath, seed]);
    await fs.mkdir(path.join(seed, "mux"), { recursive: true });
    await fs.writeFile(path.join(seed, "mux", "AGENTS.md"), "managed\n", "utf-8");
    await git(["-C", seed, "add", "-A"]);
    await git(["-C", seed, "-c", "user.email=t@e", "-c", "user.name=T", "commit", "-m", "seed"]);
    await git(["-C", seed, "push", "origin", "HEAD:main"]);

    const stableRoot = path.join(tempDir, "mux-root");
    const relativeOrigin = path.relative(stableRoot, originPath);
    const repo = new BackupRepoCache({
      repoUrl: relativeOrigin,
      branch: "main",
      cacheRoot: path.join(stableRoot, "backup-cache"),
      managedPath: "mux",
    });

    await repo.ensureCache();
    await repo.fetch();
    await repo.resetHardToRemote();

    const storedOrigin = await git(["-C", repo.cachePath, "config", "--get", "remote.origin.url"]);
    expect(path.isAbsolute(storedOrigin)).toBe(true);
    expect(await fs.realpath(storedOrigin)).toBe(await fs.realpath(originPath));

    for (const compatibleOrigin of [relativeOrigin, originPath]) {
      await git(["-C", repo.cachePath, "remote", "set-url", "origin", compatibleOrigin]);
      await repo.ensureCache();
      expect(await git(["-C", repo.cachePath, "config", "--get", "remote.origin.url"])).toBe(
        storedOrigin
      );
    }

    const other = path.join(tempDir, "relative-other.git");
    await git(["init", "--bare", other]);
    await git(["-C", repo.cachePath, "remote", "set-url", "origin", other]);
    const failure = await repo.ensureCache().then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(BackupOriginMismatchError);
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

  it("refuses a cache whose .git is a gitfile pointing at another repository", async () => {
    const outside = path.join(tempDir, "outside");
    await git(["init", outside]);
    await git(["-C", outside, "config", "core.autocrlf", "input"]);

    const repo = createRepo();
    await fs.mkdir(repo.cachePath, { recursive: true });
    // Not a symlink: a plain file `.git` redirects every `git -C` command the same way.
    await fs.writeFile(
      path.join(repo.cachePath, ".git"),
      `gitdir: ${path.join(outside, ".git")}\n`,
      "utf-8"
    );

    try {
      await repo.ensureCache();
      throw new Error("Expected the gitfile cache to be rejected");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).toContain("not a directory");
    }
    // The outside repository's config must not have taken the cache's writes.
    expect(await git(["-C", outside, "config", "--get", "core.autocrlf"])).toBe("input");
  });

  it("refuses a cache whose .git carries a commondir indirection", async () => {
    const outside = path.join(tempDir, "outside");
    await git(["init", outside]);
    await git(["-C", outside, "config", "core.autocrlf", "input"]);

    const repo = createRepo();
    await repo.ensureCache();
    await fs.writeFile(
      path.join(repo.cachePath, ".git", "commondir"),
      `${path.join(outside, ".git")}\n`,
      "utf-8"
    );

    try {
      await repo.ensureCache();
      throw new Error("Expected the commondir cache to be rejected");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).toContain("redirects to another repository");
    }
    expect(await git(["-C", outside, "config", "--get", "core.autocrlf"])).toBe("input");
  });

  it("accepts a cache whose url the user's insteadOf rules rewrite", async () => {
    const repo = createRepo();
    await repo.ensureCache();

    // A user-level rewrite: `remote get-url` reports the rewritten spelling while the
    // stored value stays what Mux wrote, so an effective-url comparison rejected every
    // operation for this user.
    const globalConfig = path.join(tempDir, "gitconfig");
    await fs.writeFile(
      globalConfig,
      `[url "file://${originPath}"]\n\tinsteadOf = ${originPath}\n`,
      "utf-8"
    );
    const rewritten = new BackupRepoCache({
      repoUrl: originPath,
      branch: "main",
      cacheRoot,
      managedPath: "mux",
      env: { GIT_CONFIG_GLOBAL: globalConfig },
    });

    await rewritten.ensureCache();
    await rewritten.fetch();
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

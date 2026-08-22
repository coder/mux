import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";
import { DisposableTempDir } from "@/node/services/tempDir";
import { resolveProjectDir } from "./trust";

const BUN_EXECUTABLE = process.execPath;
const TRUST_ENTRY = path.join(import.meta.dir, "trust.ts");
const INDEX_ENTRY = path.join(import.meta.dir, "index.ts");

describe("xum trust CLI", () => {
  test("normalizes implicit cwd to git root but preserves explicit --dir", async () => {
    using tmp = new DisposableTempDir("trust-cli-dir");
    const repo = path.join(tmp.path, "repo");
    const nested = path.join(repo, "packages", "app");
    await fs.mkdir(nested, { recursive: true });
    await Bun.$`git init`.cwd(repo).quiet();

    expect(await resolveProjectDir({ cwd: nested })).toBe(await fs.realpath(repo));
    expect(await resolveProjectDir({ cwd: tmp.path, explicitDir: nested })).toBe(nested);
  });

  test("grants and revokes project trust headlessly", async () => {
    using tmp = new DisposableTempDir("trust-cli-cycle");
    const repo = path.join(tmp.path, "repo");
    const xumRoot = path.join(tmp.path, "xum-root");
    await fs.mkdir(repo, { recursive: true });
    await fs.mkdir(xumRoot, { recursive: true });
    const env = { ...process.env, XUM_ROOT: xumRoot };

    // Grant trust for a project that was never added to Xum (no desktop/server
    // involved). Route through index.ts to cover top-level subcommand dispatch;
    // no experiment flag is required for trust.
    const trustResult = await Bun.$`${BUN_EXECUTABLE} ${INDEX_ENTRY} trust --dir ${repo} --json`
      .env(env)
      .quiet();
    expect(trustResult.exitCode).toBe(0);
    expect(JSON.parse(trustResult.stdout.toString())).toEqual({
      projectPath: repo,
      trusted: true,
    });

    const revokeResult = await Bun.$`${BUN_EXECUTABLE} ${TRUST_ENTRY} --revoke --dir ${repo} --json`
      .env(env)
      .quiet();
    expect(revokeResult.exitCode).toBe(0);
    expect(JSON.parse(revokeResult.stdout.toString())).toEqual({
      projectPath: repo,
      trusted: false,
    });
  }, 15_000);

  test("revoke from a worktree also clears a direct trust entry for the worktree path", async () => {
    using tmp = new DisposableTempDir("trust-cli-worktree-revoke");
    const base = await fs.realpath(tmp.path);
    const repo = path.join(base, "repo");
    const xumRoot = path.join(base, "xum-root");
    const worktree = path.join(base, "worktree");
    await fs.mkdir(repo, { recursive: true });
    await fs.mkdir(xumRoot, { recursive: true });
    await Bun.$`git init`.cwd(repo).quiet();
    await Bun.$`git config user.email dogfood@example.com`.cwd(repo).quiet();
    await Bun.$`git config user.name Dogfood`.cwd(repo).quiet();
    await fs.writeFile(path.join(repo, "README.md"), "hello\n", "utf-8");
    await Bun.$`git add README.md`.cwd(repo).quiet();
    await Bun.$`git commit -m init`.cwd(repo).quiet();
    await Bun.$`git worktree add ${worktree} -b feature`.cwd(repo).quiet();

    // Older/manual configs (or a worktree added as its own project) can hold a
    // direct trusted entry for the worktree path alongside the main repo entry.
    // Revoke must clear both; the direct entry alone would keep the checkout
    // trusted via resolveProjectTrusted's exact-path lookup.
    await fs.writeFile(
      path.join(xumRoot, "config.json"),
      JSON.stringify({
        projects: [
          [repo, { workspaces: [], trusted: true }],
          [worktree, { workspaces: [], trusted: true }],
        ],
      }),
      "utf-8"
    );
    const env = { ...process.env, XUM_ROOT: xumRoot };

    const revokeResult =
      await Bun.$`${BUN_EXECUTABLE} ${TRUST_ENTRY} --revoke --dir ${worktree} --json`
        .env(env)
        .quiet();
    expect(revokeResult.exitCode).toBe(0);

    const config = JSON.parse(await fs.readFile(path.join(xumRoot, "config.json"), "utf-8")) as {
      projects: Array<[string, { trusted?: boolean }]>;
    };
    const trustByPath = new Map(config.projects.map(([p, c]) => [p, c.trusted]));
    expect(trustByPath.get(repo)).toBe(false);
    expect(trustByPath.get(worktree)).toBe(false);
  }, 15_000);

  test("fails loudly when the trust change cannot be persisted", async () => {
    using tmp = new DisposableTempDir("trust-cli-unwritable");
    const repo = path.join(tmp.path, "repo");
    await fs.mkdir(repo, { recursive: true });
    // XUM_ROOT pointing at a regular file makes config.json unwritable;
    // Config.saveConfig swallows the write error, so only the post-write
    // verification can surface the failure.
    const xumRootFile = path.join(tmp.path, "xum-root-file");
    await fs.writeFile(xumRootFile, "not a directory\n", "utf-8");

    const result = await Bun.$`${BUN_EXECUTABLE} ${TRUST_ENTRY} --dir ${repo} --json`
      .env({ ...process.env, XUM_ROOT: xumRootFile })
      .nothrow()
      .quiet();

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Failed to persist trust change");
    expect(result.stdout.toString()).toBe("");
  }, 15_000);

  test("trust from a linked worktree records trust for the main repository", async () => {
    using tmp = new DisposableTempDir("trust-cli-worktree");
    // realpath: git reports physical paths (macOS /var -> /private/var) and the trust
    // entry written to config must match what trust resolution compares against.
    const base = await fs.realpath(tmp.path);
    const repo = path.join(base, "repo");
    const xumRoot = path.join(base, "xum-root");
    const worktree = path.join(base, "worktree");
    await fs.mkdir(repo, { recursive: true });
    await fs.mkdir(xumRoot, { recursive: true });
    await Bun.$`git init`.cwd(repo).quiet();
    await Bun.$`git config user.email dogfood@example.com`.cwd(repo).quiet();
    await Bun.$`git config user.name Dogfood`.cwd(repo).quiet();
    await fs.writeFile(path.join(repo, "README.md"), "hello\n", "utf-8");
    await Bun.$`git add README.md`.cwd(repo).quiet();
    await Bun.$`git commit -m init`.cwd(repo).quiet();
    await Bun.$`git worktree add ${worktree} -b feature`.cwd(repo).quiet();

    const trustResult = await Bun.$`${BUN_EXECUTABLE} ${TRUST_ENTRY} --dir ${worktree} --json`
      .env({ ...process.env, XUM_ROOT: xumRoot })
      .quiet();
    expect(trustResult.exitCode).toBe(0);
    // Trust must land on the main repository path, not the ephemeral worktree path.
    expect(JSON.parse(trustResult.stdout.toString())).toEqual({
      projectPath: repo,
      trusted: true,
    });
  }, 15_000);
});

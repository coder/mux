import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { discoverGitRoots } from "./gitRootDiscovery";

const tempDirsToClean: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirsToClean.push(dirPath);
  return dirPath;
}

function initGitRepo(repoPath: string): void {
  execSync("git init", { cwd: repoPath, stdio: "ignore" });
}

function sortPaths(paths: readonly string[]): string[] {
  return [...paths].sort((left, right) => left.localeCompare(right));
}

afterEach(async () => {
  await Promise.all(
    tempDirsToClean.splice(0).map((dirPath) => fs.rm(dirPath, { recursive: true, force: true }))
  );
});

describe("discoverGitRoots", () => {
  test("returns workspace path for single-project workspaces", async () => {
    const workspacePath = await createTempDir("mux-git-root-discovery-single-");
    initGitRepo(workspacePath);

    expect(await discoverGitRoots(workspacePath)).toEqual([workspacePath]);
  });

  test("returns child directories for multi-project workspaces", async () => {
    const workspacePath = await createTempDir("mux-git-root-discovery-multi-");
    const projectAPath = path.join(workspacePath, "project-a");
    const projectBPath = path.join(workspacePath, "project-b");

    await fs.mkdir(projectAPath, { recursive: true });
    await fs.mkdir(projectBPath, { recursive: true });
    initGitRepo(projectAPath);
    initGitRepo(projectBPath);

    const roots = await discoverGitRoots(workspacePath);

    expect(sortPaths(roots)).toEqual(sortPaths([projectAPath, projectBPath]));
    expect(roots).not.toContain(workspacePath);
  });

  test("follows symlinked child directories", async () => {
    const workspacePath = await createTempDir("mux-git-root-discovery-symlink-container-");
    const projectARealPath = await createTempDir("mux-git-root-discovery-symlink-real-a-");
    const projectBRealPath = await createTempDir("mux-git-root-discovery-symlink-real-b-");

    initGitRepo(projectARealPath);
    initGitRepo(projectBRealPath);

    const projectASymlinkPath = path.join(workspacePath, "project-a");
    const projectBSymlinkPath = path.join(workspacePath, "project-b");
    const symlinkType = process.platform === "win32" ? "junction" : "dir";

    await fs.symlink(projectARealPath, projectASymlinkPath, symlinkType);
    await fs.symlink(projectBRealPath, projectBSymlinkPath, symlinkType);

    const roots = await discoverGitRoots(workspacePath);

    expect(sortPaths(roots)).toEqual(sortPaths([projectASymlinkPath, projectBSymlinkPath]));
  });

  test("returns empty array for non-git workspaces", async () => {
    const workspacePath = await createTempDir("mux-git-root-discovery-empty-");

    expect(await discoverGitRoots(workspacePath)).toEqual([]);
  });

  test("ignores non-directory children", async () => {
    const workspacePath = await createTempDir("mux-git-root-discovery-ignore-files-");
    const projectPath = path.join(workspacePath, "project-a");

    await fs.writeFile(path.join(workspacePath, "README.md"), "hello\n");
    await fs.mkdir(projectPath, { recursive: true });
    initGitRepo(projectPath);

    expect(await discoverGitRoots(workspacePath)).toEqual([projectPath]);
  });
});

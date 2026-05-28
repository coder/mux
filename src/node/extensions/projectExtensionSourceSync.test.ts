import { execFile } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { ProjectExtensionSourceLockSchema } from "@/common/extensions/sourceLocks";
import { installGitExtensionSource } from "./gitExtensionSourceInstaller";
import {
  getProjectExtensionActiveRootPath,
  syncProjectExtensionLockSources,
} from "./projectExtensionSourceSync";

const execFileAsync = promisify(execFile);

let tempDir: string;

async function git(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd });
  return stdout.trim();
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

async function createGitExtensionRepo(): Promise<{
  repoPath: string;
  resolvedSha: string;
  contentHash: string;
}> {
  const repoPath = path.join(tempDir, "repo");
  await fs.mkdir(repoPath, { recursive: true });
  await git(["init", "--initial-branch", "main"], repoPath);
  await git(["config", "commit.gpgsign", "false"], repoPath);
  await git(["config", "user.email", "mux@example.com"], repoPath);
  await git(["config", "user.name", "Mux Test"], repoPath);
  await writeFile(
    path.join(repoPath, "extensions", "review", "extension.ts"),
    `
      export const manifest = {
        name: "acme-review",
        capabilities: { skills: true },
      };
      export function activate(ctx) {
        ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
      }
    `
  );
  await writeFile(
    path.join(repoPath, "extensions", "review", "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Review helper\n---\n# Review\n"
  );
  await git(["add", "."], repoPath);
  await git(["commit", "-m", "add extension"], repoPath);
  const resolvedSha = await git(["rev-parse", "HEAD"], repoPath);
  const installed = await installGitExtensionSource({
    coordinate: `${repoPath}//extensions/review@${resolvedSha}`,
    muxRootDir: path.join(tempDir, "bootstrap-mux"),
    now: 123,
  });
  return { repoPath, resolvedSha, contentHash: installed.contentHash };
}

async function hashDirectory(rootPath: string): Promise<string> {
  const hash = createHash("sha256");
  for (const filePath of await listFiles(rootPath)) {
    const relativePath = path.relative(rootPath, filePath).split(path.sep).join("/");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await fs.readFile(filePath));
    hash.update("\0");
  }
  return `sha256:${hash.digest("base64url")}`;
}

async function listFiles(rootPath: string): Promise<string[]> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-project-extension-sync-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("syncProjectExtensionLockSources", () => {
  test("does not parse or materialize project source locks before trust", async () => {
    const muxRootDir = path.join(tempDir, "mux-home");
    const projectPath = path.join(tempDir, "project");
    await writeFile(path.join(projectPath, ".mux", "extensions.lock.json"), "not valid json");

    const result = await syncProjectExtensionLockSources({
      projectPath,
      muxRootDir,
      trusted: false,
      now: 123,
    });

    expect(result).toEqual({ synced: [] });
    expect(await pathExists(path.join(muxRootDir, "extensions", "store"))).toBe(false);
    expect(await pathExists(getProjectExtensionActiveRootPath(muxRootDir, projectPath))).toBe(
      false
    );
  });

  test("syncs trusted project git locks into the project active view", async () => {
    const muxRootDir = path.join(tempDir, "mux-home");
    const projectPath = path.join(tempDir, "project");
    const { repoPath, resolvedSha, contentHash } = await createGitExtensionRepo();
    const lock = ProjectExtensionSourceLockSchema.parse({
      schemaVersion: 1,
      extensions: {
        "acme-review": {
          source: {
            type: "git",
            url: repoPath,
            ref: "main",
            resolvedSha,
            subdir: "extensions/review",
            contentHash,
          },
        },
      },
    });
    await writeFile(
      path.join(projectPath, ".mux", "extensions.lock.json"),
      `${JSON.stringify(lock, null, 2)}\n`
    );

    const result = await syncProjectExtensionLockSources({
      projectPath,
      muxRootDir,
      trusted: true,
      now: 123,
    });

    expect(result.synced).toEqual([
      {
        extensionName: "acme-review",
        contentHash,
        activePath: path.join(
          getProjectExtensionActiveRootPath(muxRootDir, projectPath),
          "acme-review"
        ),
      },
    ]);
    const entrypointStat = await fs.stat(
      path.join(
        getProjectExtensionActiveRootPath(muxRootDir, projectPath),
        "acme-review",
        "extension.ts"
      )
    );
    expect(entrypointStat.isFile()).toBe(true);
  });

  test("materializes trusted vendored project locks into the project active view", async () => {
    const muxRootDir = path.join(tempDir, "mux-home");
    const projectPath = path.join(tempDir, "project");
    const vendoredPath = path.join(projectPath, ".mux", "extensions", "acme-review");
    await writeFile(
      path.join(vendoredPath, "extension.ts"),
      `
        export const manifest = {
          name: "acme-review",
          capabilities: { skills: true },
        };
        export function activate(ctx) {
          ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
        }
      `
    );
    await writeFile(
      path.join(vendoredPath, "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Vendored review helper\n---\n# Review\n"
    );
    const contentHash = await hashDirectory(vendoredPath);
    const lock = ProjectExtensionSourceLockSchema.parse({
      schemaVersion: 1,
      extensions: {
        "acme-review": {
          source: {
            type: "vendored",
            path: ".mux/extensions/acme-review",
            contentHash,
          },
        },
      },
    });
    await writeFile(
      path.join(projectPath, ".mux", "extensions.lock.json"),
      `${JSON.stringify(lock, null, 2)}\n`
    );

    const result = await syncProjectExtensionLockSources({
      projectPath,
      muxRootDir,
      trusted: true,
      now: 123,
    });

    const activePath = path.join(
      getProjectExtensionActiveRootPath(muxRootDir, projectPath),
      "acme-review"
    );
    expect(result.synced).toEqual([{ extensionName: "acme-review", contentHash, activePath }]);
    const entrypointStat = await fs.stat(path.join(activePath, "extension.ts"));
    expect(entrypointStat.isFile()).toBe(true);
  });

  test("does not rewrite unchanged vendored active views", async () => {
    const muxRootDir = path.join(tempDir, "mux-home");
    const projectPath = path.join(tempDir, "project");
    const vendoredPath = path.join(projectPath, ".mux", "extensions", "acme-review");
    await writeFile(
      path.join(vendoredPath, "extension.ts"),
      "export const manifest = { name: 'acme-review', capabilities: { skills: true } };\n"
    );
    await writeFile(
      path.join(vendoredPath, "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review helper\n---\n# Review\n"
    );
    const contentHash = await hashDirectory(vendoredPath);
    await writeFile(
      path.join(projectPath, ".mux", "extensions.lock.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          extensions: {
            "acme-review": {
              source: {
                type: "vendored",
                path: ".mux/extensions/acme-review",
                contentHash,
              },
            },
          },
        },
        null,
        2
      )}\n`
    );
    await syncProjectExtensionLockSources({ projectPath, muxRootDir, trusted: true });
    const activePath = path.join(
      getProjectExtensionActiveRootPath(muxRootDir, projectPath),
      "acme-review"
    );
    const originalRm = fs.rm;
    const rmSpy = spyOn(fs, "rm");
    rmSpy.mockImplementation(((
      target: Parameters<typeof fs.rm>[0],
      options?: Parameters<typeof fs.rm>[1]
    ) => originalRm(target, options)) as typeof fs.rm);

    try {
      await syncProjectExtensionLockSources({ projectPath, muxRootDir, trusted: true });
      expect(rmSpy.mock.calls.some(([target]) => String(target) === activePath)).toBe(false);
    } finally {
      rmSpy.mockRestore();
    }
  });

  test("rebuilds project active roots that are not directories", async () => {
    const muxRootDir = path.join(tempDir, "mux-home");
    const projectPath = path.join(tempDir, "project");
    const vendoredPath = path.join(projectPath, ".mux", "extensions", "acme-review");
    await writeFile(
      path.join(vendoredPath, "extension.ts"),
      "export const manifest = { name: 'acme-review', capabilities: { skills: true } };\n"
    );
    const contentHash = await hashDirectory(vendoredPath);
    await writeFile(
      path.join(projectPath, ".mux", "extensions.lock.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          extensions: {
            "acme-review": {
              source: {
                type: "vendored",
                path: ".mux/extensions/acme-review",
                contentHash,
              },
            },
          },
        },
        null,
        2
      )}\n`
    );
    const activeRootPath = getProjectExtensionActiveRootPath(muxRootDir, projectPath);
    await writeFile(activeRootPath, "not a directory");

    await syncProjectExtensionLockSources({ projectPath, muxRootDir, trusted: true });

    expect((await fs.stat(activeRootPath)).isDirectory()).toBe(true);
    expect(await pathExists(path.join(activeRootPath, "acme-review", "extension.ts"))).toBe(true);
  });

  test("rebuilds vendored active views that are not hashable directories", async () => {
    const muxRootDir = path.join(tempDir, "mux-home");
    const projectPath = path.join(tempDir, "project");
    const vendoredPath = path.join(projectPath, ".mux", "extensions", "acme-review");
    await writeFile(
      path.join(vendoredPath, "extension.ts"),
      "export const manifest = { name: 'acme-review', capabilities: { skills: true } };\n"
    );
    const contentHash = await hashDirectory(vendoredPath);
    await writeFile(
      path.join(projectPath, ".mux", "extensions.lock.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          extensions: {
            "acme-review": {
              source: {
                type: "vendored",
                path: ".mux/extensions/acme-review",
                contentHash,
              },
            },
          },
        },
        null,
        2
      )}\n`
    );
    const activePath = path.join(
      getProjectExtensionActiveRootPath(muxRootDir, projectPath),
      "acme-review"
    );
    await writeFile(activePath, "not a directory");

    await syncProjectExtensionLockSources({ projectPath, muxRootDir, trusted: true });

    expect((await fs.stat(activePath)).isDirectory()).toBe(true);
    expect(await pathExists(path.join(activePath, "extension.ts"))).toBe(true);
  });

  test("rejects vendored project locks when the source path changes after containment", async () => {
    const muxRootDir = path.join(tempDir, "mux-home");
    const projectPath = path.join(tempDir, "project");
    const vendoredPath = path.join(projectPath, ".mux", "extensions", "acme-review");
    const outsidePath = path.join(tempDir, "outside-extension");
    await writeFile(
      path.join(vendoredPath, "extension.ts"),
      "export const manifest = { name: 'acme-review', capabilities: { skills: true } };\n"
    );
    await writeFile(
      path.join(outsidePath, "extension.ts"),
      "export const manifest = { name: 'acme-review', capabilities: { skills: true } };\n"
    );
    await writeFile(path.join(outsidePath, "secret.txt"), "outside secret");
    const contentHash = await hashDirectory(outsidePath);
    const lock = ProjectExtensionSourceLockSchema.parse({
      schemaVersion: 1,
      extensions: {
        "acme-review": {
          source: {
            type: "vendored",
            path: ".mux/extensions/acme-review",
            contentHash,
          },
        },
      },
    });
    await writeFile(
      path.join(projectPath, ".mux", "extensions.lock.json"),
      `${JSON.stringify(lock, null, 2)}\n`
    );

    const originalStat = fs.stat;
    const statSpy = spyOn(fs, "stat");
    let swapped = false;
    statSpy.mockImplementation((async (target: Parameters<typeof fs.stat>[0]) => {
      const result = await originalStat(target);
      if (!swapped && String(target) === vendoredPath) {
        swapped = true;
        await fs.rm(vendoredPath, { recursive: true, force: true });
        await fs.symlink(outsidePath, vendoredPath, "dir");
      }
      return result;
    }) as unknown as typeof fs.stat);

    try {
      let error: unknown;
      try {
        await syncProjectExtensionLockSources({ projectPath, muxRootDir, trusted: true });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(Error);
      expect(error instanceof Error ? error.message : "").toMatch(/changed|outside/);
      const activePath = path.join(
        getProjectExtensionActiveRootPath(muxRootDir, projectPath),
        "acme-review"
      );
      expect(await pathExists(path.join(activePath, "secret.txt"))).toBe(false);
    } finally {
      statSpy.mockRestore();
    }
  });

  test("rejects vendored project locks when the source path changes before copy", async () => {
    const muxRootDir = path.join(tempDir, "mux-home");
    const projectPath = path.join(tempDir, "project");
    const vendoredPath = path.join(projectPath, ".mux", "extensions", "acme-review");
    const outsidePath = path.join(tempDir, "outside-extension");
    await writeFile(
      path.join(vendoredPath, "extension.ts"),
      "export const manifest = { name: 'acme-review', capabilities: { skills: true } };\n"
    );
    await writeFile(
      path.join(outsidePath, "extension.ts"),
      "export const manifest = { name: 'acme-review', capabilities: { skills: true } };\n"
    );
    await writeFile(path.join(outsidePath, "secret.txt"), "outside secret");
    const contentHash = await hashDirectory(vendoredPath);
    const lock = ProjectExtensionSourceLockSchema.parse({
      schemaVersion: 1,
      extensions: {
        "acme-review": {
          source: {
            type: "vendored",
            path: ".mux/extensions/acme-review",
            contentHash,
          },
        },
      },
    });
    await writeFile(
      path.join(projectPath, ".mux", "extensions.lock.json"),
      `${JSON.stringify(lock, null, 2)}\n`
    );
    const activePath = path.join(
      getProjectExtensionActiveRootPath(muxRootDir, projectPath),
      "acme-review"
    );

    const originalRm = fs.rm;
    const rmSpy = spyOn(fs, "rm");
    let swapped = false;
    rmSpy.mockImplementation((async (
      target: Parameters<typeof fs.rm>[0],
      options?: Parameters<typeof fs.rm>[1]
    ) => {
      const result = await originalRm(target, options);
      if (!swapped && String(target) === activePath) {
        swapped = true;
        await originalRm(vendoredPath, { recursive: true, force: true });
        await fs.symlink(outsidePath, vendoredPath, "dir");
      }
      return result;
    }) as unknown as typeof fs.rm);

    try {
      let error: unknown;
      try {
        await syncProjectExtensionLockSources({ projectPath, muxRootDir, trusted: true });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(Error);
      expect(error instanceof Error ? error.message : "").toMatch(/changed|outside/);
      expect(await pathExists(path.join(activePath, "secret.txt"))).toBe(false);
    } finally {
      rmSpy.mockRestore();
    }
  });

  test("removes active view entries that are no longer declared by the project lock", async () => {
    const muxRootDir = path.join(tempDir, "mux-home");
    const projectPath = path.join(tempDir, "project");
    const staleActivePath = path.join(
      getProjectExtensionActiveRootPath(muxRootDir, projectPath),
      "stale-review"
    );
    await writeFile(
      path.join(staleActivePath, "extension.ts"),
      "export const manifest = { name: 'stale-review', capabilities: { skills: true } };\n"
    );
    await writeFile(
      path.join(projectPath, ".mux", "extensions.lock.json"),
      `${JSON.stringify({ schemaVersion: 1, extensions: {} }, null, 2)}\n`
    );

    await syncProjectExtensionLockSources({ projectPath, muxRootDir, trusted: true });

    expect(await pathExists(staleActivePath)).toBe(false);
  });
});

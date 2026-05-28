import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { GlobalExtensionSourceLockSchema } from "@/common/extensions/sourceLocks";

import { installGitExtensionSource, normalizeGitUrl } from "./gitExtensionSourceInstaller";

const execFileAsync = promisify(execFile);

let tempDir: string;

async function git(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "gpg.format=", "-c", "user.signingkey=", ...args],
    { cwd }
  );
  return stdout.trim();
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-git-extension-install-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("normalizeGitUrl", () => {
  test("does not append .git twice for GitHub shorthand", () => {
    expect(normalizeGitUrl("github.com/acme/review")).toBe("https://github.com/acme/review.git");
    expect(normalizeGitUrl("github.com/acme/review.git")).toBe(
      "https://github.com/acme/review.git"
    );
  });
});

describe("installGitExtensionSource", () => {
  test("installs a git subdir source into store/global views and writes the global lock", async () => {
    const repoPath = path.join(tempDir, "repo");
    const muxRoot = path.join(tempDir, "mux-home");
    await fs.mkdir(repoPath, { recursive: true });
    await git(["init", "--initial-branch", "main"], repoPath);
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

    const result = await installGitExtensionSource({
      coordinate: `${repoPath}//extensions/review@main`,
      muxRootDir: muxRoot,
      now: 123,
    });

    expect(result.extensionName).toBe("acme-review");
    expect(result.resolvedSha).toBe(resolvedSha);
    expect(result.contentHash.startsWith("sha256:")).toBe(true);
    const [storeEntrypoint, activeEntrypoint] = await Promise.all([
      fs.stat(path.join(result.storePath, "extension.ts")),
      fs.stat(path.join(result.activePath, "extension.ts")),
    ]);
    expect(storeEntrypoint.isFile()).toBe(true);
    expect(activeEntrypoint.isFile()).toBe(true);

    const lock = GlobalExtensionSourceLockSchema.parse(
      JSON.parse(await fs.readFile(path.join(muxRoot, "extensions", "lock.json"), "utf-8"))
    );
    expect(lock).toEqual({
      schemaVersion: 1,
      extensions: {
        "acme-review": {
          source: {
            type: "git",
            url: repoPath,
            ref: "main",
            resolvedSha,
            subdir: "extensions/review",
            contentHash: result.contentHash,
          },
        },
      },
    });
  });

  test("repairs a corrupted content-addressed store entry before materializing the active view", async () => {
    const repoPath = path.join(tempDir, "repo");
    const muxRoot = path.join(tempDir, "mux-home");
    await fs.mkdir(repoPath, { recursive: true });
    await git(["init", "--initial-branch", "main"], repoPath);
    await git(["config", "user.email", "mux@example.com"], repoPath);
    await git(["config", "user.name", "Mux Test"], repoPath);
    await writeFile(
      path.join(repoPath, "extension.ts"),
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
      path.join(repoPath, "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review helper\n---\n# Review\n"
    );
    await git(["add", "."], repoPath);
    await git(["commit", "-m", "add extension"], repoPath);

    const first = await installGitExtensionSource({
      coordinate: `${repoPath}@main`,
      muxRootDir: muxRoot,
      now: 123,
    });
    await fs.writeFile(
      path.join(first.storePath, "extension.ts"),
      "export const manifest = { name: 'corrupted-store', capabilities: { skills: true } };\n"
    );

    const second = await installGitExtensionSource({
      coordinate: `${repoPath}@main`,
      muxRootDir: muxRoot,
      now: 123,
    });

    expect(second.storePath).toBe(first.storePath);
    const [storedEntrypoint, activeEntrypoint] = await Promise.all([
      fs.readFile(path.join(second.storePath, "extension.ts"), "utf-8"),
      fs.readFile(path.join(second.activePath, "extension.ts"), "utf-8"),
    ]);
    expect(storedEntrypoint).toContain("ctx.skills.register");
    expect(activeEntrypoint).toBe(storedEntrypoint);
  });

  test("rejects git sources whose extension.ts is a symlink", async () => {
    const repoPath = path.join(tempDir, "repo");
    const outsidePath = path.join(tempDir, "outside-extension.ts");
    const muxRoot = path.join(tempDir, "mux-home");
    await fs.mkdir(repoPath, { recursive: true });
    await git(["init", "--initial-branch", "main"], repoPath);
    await git(["config", "user.email", "mux@example.com"], repoPath);
    await git(["config", "user.name", "Mux Test"], repoPath);
    await writeFile(
      outsidePath,
      `
        export const manifest = {
          name: "acme-review",
          capabilities: { skills: true },
        };
      `
    );
    await fs.symlink(outsidePath, path.join(repoPath, "extension.ts"));
    await git(["add", "."], repoPath);
    await git(["commit", "-m", "add symlinked extension"], repoPath);

    let error: unknown;
    try {
      await installGitExtensionSource({
        coordinate: `${repoPath}@main`,
        muxRootDir: muxRoot,
        now: 123,
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : "").toContain("extension.ts");
    let activeViewExists = true;
    try {
      await fs.access(path.join(muxRoot, "extensions", "global", "acme-review"));
    } catch {
      activeViewExists = false;
    }
    expect(activeViewExists).toBe(false);
  });

  test("clones dash-prefixed relative repository coordinates with an option delimiter", async () => {
    const repoName = `-mux-extension-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const repoPath = path.join(os.tmpdir(), repoName);
    const muxRoot = path.join(tempDir, "mux-home");
    try {
      await fs.mkdir(repoPath, { recursive: true });
      await git(["init", "--initial-branch", "main"], repoPath);
      await git(["config", "commit.gpgsign", "false"], repoPath);
      await git(["config", "user.email", "mux@example.com"], repoPath);
      await git(["config", "user.name", "Mux Test"], repoPath);
      await writeFile(
        path.join(repoPath, "extension.ts"),
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
        path.join(repoPath, "skills", "review", "SKILL.md"),
        "---\nname: review\ndescription: Review helper\n---\n# Review\n"
      );
      await git(["add", "."], repoPath);
      await git(["commit", "-m", "add extension"], repoPath);

      const result = await installGitExtensionSource({
        coordinate: `${repoName}@main`,
        muxRootDir: muxRoot,
        now: 123,
      });

      expect(result.extensionName).toBe("acme-review");
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  test("rejects Windows absolute git subdirs before cloning", async () => {
    let error: unknown;
    try {
      await installGitExtensionSource({
        coordinate: "https://example.invalid/acme/review.git//C:\\Users\\alice\\review@main",
        muxRootDir: path.join(tempDir, "mux-home"),
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : "").toContain("contained relative path");
  });
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Config } from "@/node/config";
import type { SettingsBackupInput } from "@/common/orpc/schemas/backup";
import { execFileAsync } from "@/node/utils/disposableExec";
import { createBackupGitRepo, createBackupPayloadStore } from "./adapters";
import { BackupService } from "./backupService";
import { REDACTED_BACKUP_VALUE } from "./payload";

const SECRET_FILES = [
  "providers.jsonc",
  "secrets.json",
  "mcp-oauth.json",
  "server.lock",
  "serverAuthSessions.json",
];
const DECOY = "DECOY_SECRET_MUST_NOT_LEAK";

async function git(args: string[]): Promise<string> {
  using process = execFileAsync("git", args);
  return (await process.result).stdout.trim();
}

/**
 * Exercises the service against a real bare repository and a real MUX_ROOT, so the
 * secret-exclusion invariant is asserted on bytes that actually reached a remote.
 */
describe("BackupService against a real repository", () => {
  let tempDir: string;
  let muxRoot: string;
  let originPath: string;
  let config: Config;
  let service: BackupService;
  let settings: SettingsBackupInput;

  async function writeMuxFile(relativePath: string, content: string): Promise<void> {
    const absolutePath = path.join(muxRoot, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf-8");
  }

  function createService(): BackupService {
    return new BackupService(config, {
      gitRepo: createBackupGitRepo({ cacheRoot: path.join(muxRoot, "backup-cache") }),
      payload: createBackupPayloadStore({ config }),
    });
  }

  async function cloneOrigin(name: string): Promise<string> {
    const target = path.join(tempDir, name);
    await git(["clone", "--quiet", originPath, target]);
    return target;
  }

  async function listFiles(root: string): Promise<string[]> {
    const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
      .filter((file) => !file.startsWith(".git/"))
      .sort();
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-backup-e2e-"));
    muxRoot = path.join(tempDir, "mux-root");
    originPath = path.join(tempDir, "origin.git");
    await fs.mkdir(muxRoot, { recursive: true });
    await git(["init", "--bare", "--initial-branch=main", originPath]);
    settings = { repoUrl: originPath, branch: "main", path: "mux" };
    config = new Config(muxRoot);
    service = createService();

    await writeMuxFile("AGENTS.md", "global instructions\n");
    await writeMuxFile("agents/reviewer.md", "reviewer agent\n");
    await writeMuxFile("skills/demo/SKILL.md", "demo skill\n");
    await writeMuxFile("memory/global/note.md", "remembered fact\n");
    await writeMuxFile(
      "mcp.jsonc",
      `{
  // Comments must survive a backup round trip.
  "servers": {
    "literal": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer abc123" }
    },
    "referenced": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": { "secret": "MCP_TOKEN" } }
    }
  }
}
`
    );
    for (const secretFile of SECRET_FILES) {
      await writeMuxFile(secretFile, `${DECOY}\n`);
    }
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("pushes the portable payload and leaks no secret file", async () => {
    const pushed = await service.push(settings);
    expect(pushed.success).toBe(true);

    const clone = await cloneOrigin("verify");
    const files = await listFiles(clone);
    expect(files).toEqual([
      "mux/AGENTS.md",
      "mux/agents/reviewer.md",
      "mux/manifest.json",
      "mux/mcp.jsonc",
      "mux/memory/global/note.md",
      "mux/preferences.json",
      "mux/skills/demo/SKILL.md",
    ]);

    const contents = await Promise.all(
      files.map((file) => fs.readFile(path.join(clone, file), "utf-8"))
    );
    expect(contents.join("\n")).not.toContain(DECOY);
    for (const secretFile of SECRET_FILES) {
      expect(files.some((file) => path.posix.basename(file) === secretFile)).toBe(false);
    }
  });

  it("redacts a literal MCP header but keeps an environment reference", async () => {
    const pushed = await service.push(settings);
    if (!pushed.success) throw new Error(pushed.error.message);
    expect(pushed.data.redactions.length).toBeGreaterThan(0);

    const clone = await cloneOrigin("verify");
    const mcp = await fs.readFile(path.join(clone, "mux/mcp.jsonc"), "utf-8");
    expect(mcp).not.toContain("Bearer abc123");
    expect(mcp).toContain(REDACTED_BACKUP_VALUE);
    expect(mcp).toContain('"secret": "MCP_TOKEN"');
    expect(mcp).toContain("// Comments must survive a backup round trip.");
  });

  it("does not create a second commit when nothing changed", async () => {
    const first = await service.push(settings);
    if (!first.success) throw new Error(first.error.message);
    const commitsAfterFirst = await git(["--git-dir", originPath, "rev-list", "--count", "main"]);

    const second = await service.push(settings);
    if (!second.success) throw new Error(second.error.message);
    expect(second.data.changed).toBe(false);
    expect(await git(["--git-dir", originPath, "rev-list", "--count", "main"])).toBe(
      commitsAfterFirst
    );
  });

  it("blocks a push when a backed-up file contains a token, and proceeds once allowed", async () => {
    await writeMuxFile("AGENTS.md", "token ghp_123456789012345678901234567890123456\n");

    const blocked = await service.push(settings);
    expect(blocked.success).toBe(false);
    if (blocked.success) throw new Error("Expected the secret scan to block the push");
    expect(blocked.error.code).toBe("SECRET_DETECTED");
    expect(blocked.error.files).toContain("AGENTS.md");
    expect(await git(["--git-dir", originPath, "rev-list", "--count", "--all"])).toBe("0");

    const allowed = await service.push(settings, { allowSecrets: true });
    expect(allowed.success).toBe(true);
  });

  it("restores files, keeps local-only files, and records the restored commit", async () => {
    const pushed = await service.push(settings);
    if (!pushed.success) throw new Error(pushed.error.message);

    await writeMuxFile("AGENTS.md", "locally edited\n");
    await writeMuxFile("agents/local-only.md", "local only\n");

    const restored = await service.restore(settings);
    if (!restored.success) throw new Error(restored.error.message);
    expect(restored.data.changedFiles).toEqual(["AGENTS.md"]);
    expect(restored.data.localOnlyFiles).toEqual(["agents/local-only.md"]);
    expect(await fs.readFile(path.join(muxRoot, "AGENTS.md"), "utf-8")).toBe(
      "global instructions\n"
    );
    expect(await fs.readFile(path.join(muxRoot, "agents/local-only.md"), "utf-8")).toBe(
      "local only\n"
    );

    expect(await fs.readFile(path.join(restored.data.snapshotPath, "AGENTS.md"), "utf-8")).toBe(
      "locally edited\n"
    );
    expect(service.getSettings()?.lastRestoredCommit).toBe(pushed.data.commit);
  });

  it("reports an empty repository as reachable and bootstraps its first commit", async () => {
    const validated = await service.validate(settings);
    if (!validated.success) throw new Error(validated.error.message);
    expect(validated.data.empty).toBe(true);

    const pushed = await service.push(settings);
    expect(pushed.success).toBe(true);
    expect(await git(["--git-dir", originPath, "rev-parse", "refs/heads/main"])).toMatch(
      /^[0-9a-f]{40}$/
    );
  });

  it("previews an empty repository without erroring and refuses to restore from it", async () => {
    const preview = await service.preview(settings);
    if (!preview.success) throw new Error(preview.error.message);
    expect(preview.data.restoreChanges).toEqual([]);
    expect(preview.data.pushChanges.length).toBeGreaterThan(0);

    const restored = await service.restore(settings);
    expect(restored.success).toBe(false);
    if (restored.success) throw new Error("Expected an empty repository to block restore");
    expect(restored.error.code).toBe("INVALID_BACKUP");
    expect(restored.error.message).not.toContain("ENOENT");
  });

  it("refuses to restore when the branch has commits but no backup payload", async () => {
    const clone = path.join(tempDir, "seed");
    await git(["clone", "--quiet", originPath, clone]);
    await fs.writeFile(path.join(clone, "README.md"), "unrelated repository\n", "utf-8");
    await git(["-C", clone, "add", "README.md"]);
    await git([
      "-C",
      clone,
      "-c",
      "user.email=uat@example.com",
      "-c",
      "user.name=UAT",
      "commit",
      "--quiet",
      "-m",
      "unrelated",
    ]);
    await git(["-C", clone, "push", "--quiet", "origin", "HEAD:refs/heads/main"]);

    const restored = await service.restore(settings);
    expect(restored.success).toBe(false);
    if (restored.success) throw new Error("Expected a missing payload to block restore");
    expect(restored.error.code).toBe("INVALID_BACKUP");
    expect(restored.error.message).not.toContain("ENOENT");
  });

  it("rejects a managed path that targets the git directory", async () => {
    const saved = await service.saveSettings({ ...settings, path: ".git" });
    expect(saved.success).toBe(false);
  });

  it("surfaces an unreachable remote as an expected error", async () => {
    const missing = { ...settings, repoUrl: path.join(tempDir, "does-not-exist.git") };
    const validated = await service.validate(missing);
    expect(validated.success).toBe(false);
  });
});

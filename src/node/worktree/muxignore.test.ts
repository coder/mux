import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as os from "os";
import * as path from "path";
import * as fsPromises from "fs/promises";
import { execSync } from "node:child_process";
import { parseMuxignorePatterns, syncMuxignoreFiles } from "./muxignore";

describe("parseMuxignorePatterns", () => {
  it("extracts negation patterns and strips the ! prefix", () => {
    const content = "# comment\n!.env\n!config/secrets.json\n";
    expect(parseMuxignorePatterns(content)).toEqual([".env", "config/secrets.json"]);
  });

  it("ignores blank lines, comments, and plain patterns", () => {
    const content = "# sync env\n\nnode_modules\n!.env.local\n  \n";
    expect(parseMuxignorePatterns(content)).toEqual([".env.local"]);
  });

  it("returns empty array for empty or comment-only content", () => {
    expect(parseMuxignorePatterns("")).toEqual([]);
    expect(parseMuxignorePatterns("# nothing here\n")).toEqual([]);
  });

  it("handles lone ! without crashing", () => {
    expect(parseMuxignorePatterns("!\n!.env")).toEqual([".env"]);
  });

  it("preserves negative patterns produced by double-bang entries", () => {
    const content = "!.env*\n!!.env.example\n";
    expect(parseMuxignorePatterns(content)).toEqual([".env*", "!.env.example"]);
  });
});

describe("syncMuxignoreFiles", () => {
  let tmpDir: string;
  let projectPath: string;
  let worktreePath: string;

  beforeEach(async () => {
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "muxignore-test-"));
    projectPath = path.join(tmpDir, "project");
    worktreePath = path.join(tmpDir, "worktree");

    // Set up a minimal git repo with a gitignored .env file
    execSync(
      [
        `mkdir -p ${projectPath}`,
        `cd ${projectPath}`,
        "git init -b main",
        "git config user.email test@test.com",
        "git config user.name Test",
        'echo ".env" > .gitignore',
        'echo "SECRET=abc" > .env',
        "git add .gitignore",
        'git commit -m "init"',
      ].join(" && ")
    );

    // Create worktree directory (simulating where git worktree add would place it)
    await fsPromises.mkdir(worktreePath, { recursive: true });
  });

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it("copies gitignored files matched by .muxignore patterns", async () => {
    // Write .muxignore with !.env pattern
    await fsPromises.writeFile(path.join(projectPath, ".muxignore"), "!.env\n");

    await syncMuxignoreFiles(projectPath, worktreePath);

    const copied = await fsPromises.readFile(path.join(worktreePath, ".env"), "utf-8");
    expect(copied).toBe("SECRET=abc\n");
  });

  it("supports root-anchored include patterns", async () => {
    await fsPromises.writeFile(path.join(projectPath, ".muxignore"), "!/.env\n");

    await syncMuxignoreFiles(projectPath, worktreePath);

    const copied = await fsPromises.readFile(path.join(worktreePath, ".env"), "utf-8");
    expect(copied).toBe("SECRET=abc\n");
  });

  it("matches basename patterns recursively across subdirectories", async () => {
    execSync(
      [`cd ${projectPath}`, "mkdir -p packages/api", 'echo "NESTED=true" > packages/api/.env'].join(
        " && "
      )
    );
    await fsPromises.writeFile(path.join(projectPath, ".muxignore"), "!.env\n");

    await syncMuxignoreFiles(projectPath, worktreePath);

    const nested = await fsPromises.readFile(path.join(worktreePath, "packages/api/.env"), "utf-8");
    expect(nested).toBe("NESTED=true\n");
  });

  it("does nothing when .muxignore is missing", async () => {
    // No .muxignore — should silently return
    await syncMuxignoreFiles(projectPath, worktreePath);

    const files = await fsPromises.readdir(worktreePath);
    expect(files).toEqual([]);
  });

  it("does not overwrite existing files in worktree", async () => {
    await fsPromises.writeFile(path.join(projectPath, ".muxignore"), "!.env\n");
    // Pre-populate .env in worktree with different content
    await fsPromises.writeFile(path.join(worktreePath, ".env"), "EXISTING=true\n");

    await syncMuxignoreFiles(projectPath, worktreePath);

    const content = await fsPromises.readFile(path.join(worktreePath, ".env"), "utf-8");
    expect(content).toBe("EXISTING=true\n");
  });

  it("copies files in nested directories", async () => {
    // Add a nested gitignored file
    execSync(
      [
        `cd ${projectPath}`,
        'echo "config/" >> .gitignore',
        "mkdir -p config",
        'echo "key=val" > config/secrets.json',
      ].join(" && ")
    );
    await fsPromises.writeFile(
      path.join(projectPath, ".muxignore"),
      "!.env\n!config/secrets.json\n"
    );

    await syncMuxignoreFiles(projectPath, worktreePath);

    const envContent = await fsPromises.readFile(path.join(worktreePath, ".env"), "utf-8");
    expect(envContent).toBe("SECRET=abc\n");

    const secretContent = await fsPromises.readFile(
      path.join(worktreePath, "config/secrets.json"),
      "utf-8"
    );
    expect(secretContent).toBe("key=val\n");
  });

  it("supports directory patterns for syncing ignored folders", async () => {
    execSync(
      [
        `cd ${projectPath}`,
        'echo "config/" >> .gitignore',
        "mkdir -p config/nested packages/api/config",
        'echo "top=true" > config/secrets.json',
        'echo "nested=true" > config/nested/inner.env',
        'echo "deep=true" > packages/api/config/local.env',
      ].join(" && ")
    );
    await fsPromises.writeFile(path.join(projectPath, ".muxignore"), "!config/\n");

    await syncMuxignoreFiles(projectPath, worktreePath);

    const topLevel = await fsPromises.readFile(
      path.join(worktreePath, "config/secrets.json"),
      "utf-8"
    );
    expect(topLevel).toBe("top=true\n");

    const nested = await fsPromises.readFile(
      path.join(worktreePath, "config/nested/inner.env"),
      "utf-8"
    );
    expect(nested).toBe("nested=true\n");

    const nestedConfigDir = await fsPromises.readFile(
      path.join(worktreePath, "packages/api/config/local.env"),
      "utf-8"
    );
    expect(nestedConfigDir).toBe("deep=true\n");
  });

  it("respects negative patterns produced by double-bang exclusions", async () => {
    execSync(
      [
        `cd ${projectPath}`,
        'echo ".env*" >> .gitignore',
        'echo "EXAMPLE=true" > .env.example',
      ].join(" && ")
    );
    await fsPromises.writeFile(path.join(projectPath, ".muxignore"), "!.env*\n!!.env.example\n");

    await syncMuxignoreFiles(projectPath, worktreePath);

    const envContent = await fsPromises.readFile(path.join(worktreePath, ".env"), "utf-8");
    expect(envContent).toBe("SECRET=abc\n");

    let envExampleExists = true;
    try {
      await fsPromises.access(path.join(worktreePath, ".env.example"));
    } catch {
      envExampleExists = false;
    }
    expect(envExampleExists).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs/promises";
import { chmodSync, statSync } from "fs";
import path from "path";
import os from "os";
import { ensurePrivateDir, ensurePrivateDirSync } from "./fs";

describe("ensurePrivateDir", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-fs-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should create directory with mode 0o700", async () => {
    const dir = path.join(tmpDir, "private");
    await ensurePrivateDir(dir);
    const stat = await fs.stat(dir);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("should tighten permissions on pre-existing directories", async () => {
    const dir = path.join(tmpDir, "existing");
    await fs.mkdir(dir);
    await fs.chmod(dir, 0o755);

    await ensurePrivateDir(dir);

    const stat = await fs.stat(dir);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("should be idempotent (no error on second call)", async () => {
    const dir = path.join(tmpDir, "twice");
    await ensurePrivateDir(dir);
    await ensurePrivateDir(dir); // should not throw
  });

  it("should create nested directories", async () => {
    const dir = path.join(tmpDir, "a/b/c");
    await ensurePrivateDir(dir);
    const stat = await fs.stat(dir);
    expect(stat.mode & 0o777).toBe(0o700);
  });
});

describe("ensurePrivateDirSync", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-fs-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should create directory with mode 0o700", () => {
    const dir = path.join(tmpDir, "private-sync");
    ensurePrivateDirSync(dir);
    const stat = statSync(dir);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("should tighten permissions on pre-existing directories", () => {
    const dir = path.join(tmpDir, "existing-sync");
    ensurePrivateDirSync(dir);
    chmodSync(dir, 0o755);

    ensurePrivateDirSync(dir);

    const stat = statSync(dir);
    expect(stat.mode & 0o777).toBe(0o700);
  });
});

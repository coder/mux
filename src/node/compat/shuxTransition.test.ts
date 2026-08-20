import { promises as fs } from "node:fs";
import * as os from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { getElectronAppIdentity } from "@/common/compat/electronAppIdentity";
import { getShuxHomeLegacyFallbackMarkerPath } from "@/common/compat/legacyMux";
import { getShuxHome } from "@/common/constants/paths";
import { sanitizeShuxChildEnv } from "@/node/runtime/childProcessEnv";
import {
  ensureShuxDirectoryTransition,
  initializeShuxHomeTransition,
  initializeShuxUserDataTransition,
} from "./shuxTransition";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(join(os.tmpdir(), "shux-transition-test-"));
  tempDirs.push(dir);
  return dir;
}

function withHomeDir<T>(homeDir: string, run: () => T): T {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousShuxRoot = process.env.SHUX_ROOT;
  const previousMuxRoot = process.env.MUX_ROOT;
  const previousNodeEnv = process.env.NODE_ENV;
  const homedirSpy = spyOn(os, "homedir");
  homedirSpy.mockReturnValue(homeDir);
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  delete process.env.SHUX_ROOT;
  delete process.env.MUX_ROOT;
  delete process.env.NODE_ENV;

  try {
    return run();
  } finally {
    homedirSpy.mockRestore();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
    if (previousShuxRoot === undefined) {
      delete process.env.SHUX_ROOT;
    } else {
      process.env.SHUX_ROOT = previousShuxRoot;
    }
    if (previousMuxRoot === undefined) {
      delete process.env.MUX_ROOT;
    } else {
      process.env.MUX_ROOT = previousMuxRoot;
    }
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  }
}

async function expectMissingPath(path: string): Promise<void> {
  try {
    await fs.lstat(path);
  } catch {
    return;
  }
  throw new Error(`expected ${path} to be missing`);
}

async function listQuarantineBackups(dir: string, baseName: string): Promise<string[]> {
  const names = await fs.readdir(dir);
  return names
    .filter((name) => name.startsWith(`${baseName}.obstructed-`))
    .map((name) => join(dir, name))
    .sort();
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("initializeShuxHomeTransition", () => {
  test("creates canonical storage and downgrade-compatible aliases for a fresh install", async () => {
    const homeDir = await createTempDir();

    const result = await initializeShuxHomeTransition({ homeDir, env: {}, platform: "linux" });

    const canonicalPath = join(homeDir, ".shux");
    expect(result).toMatchObject({
      canonicalPath,
      activePath: canonicalPath,
      status: "canonical",
      issues: [],
    });
    expect((await fs.lstat(canonicalPath)).isDirectory()).toBe(true);
    expect(await fs.realpath(join(homeDir, ".mux"))).toBe(await fs.realpath(canonicalPath));
    expect(await fs.realpath(join(homeDir, ".cmux"))).toBe(await fs.realpath(canonicalPath));
  });

  test("second startup is a no-op once aliases already point at canonical storage", async () => {
    const homeDir = await createTempDir();

    const first = await initializeShuxHomeTransition({ homeDir, env: {}, platform: "linux" });
    await fs.writeFile(join(first.canonicalPath, "config.json"), "kept", "utf8");

    const second = await initializeShuxHomeTransition({ homeDir, env: {}, platform: "linux" });

    expect(second).toMatchObject({
      canonicalPath: first.canonicalPath,
      activePath: first.canonicalPath,
      status: "canonical",
      issues: [],
    });
    expect(await fs.readFile(join(first.canonicalPath, "config.json"), "utf8")).toBe("kept");
    expect(await fs.realpath(join(homeDir, ".mux"))).toBe(await fs.realpath(first.canonicalPath));
    expect(await fs.realpath(join(homeDir, ".cmux"))).toBe(await fs.realpath(first.canonicalPath));
  });

  test("moves existing mux data and keeps upgrade and downgrade writes on one directory", async () => {
    const homeDir = await createTempDir();
    const legacyPath = join(homeDir, ".mux");
    await fs.mkdir(legacyPath);
    await fs.writeFile(join(legacyPath, "config.json"), "legacy", "utf8");

    const result = await initializeShuxHomeTransition({ homeDir, env: {}, platform: "linux" });
    const canonicalPath = join(homeDir, ".shux");

    expect(result.status).toBe("migrated");
    expect(await fs.readFile(join(canonicalPath, "config.json"), "utf8")).toBe("legacy");
    expect(await fs.realpath(legacyPath)).toBe(await fs.realpath(canonicalPath));

    await fs.writeFile(join(canonicalPath, "from-shux"), "new", "utf8");
    expect(await fs.readFile(join(legacyPath, "from-shux"), "utf8")).toBe("new");

    await fs.writeFile(join(legacyPath, "from-mux"), "old", "utf8");
    expect(await fs.readFile(join(canonicalPath, "from-mux"), "utf8")).toBe("old");
  });

  test("moves a cmux-only tree and still creates the mux alias", async () => {
    const homeDir = await createTempDir();
    const cmuxPath = join(homeDir, ".cmux");
    await fs.mkdir(cmuxPath);
    await fs.writeFile(join(cmuxPath, "config.json"), "cmux", "utf8");

    const result = await initializeShuxHomeTransition({ homeDir, env: {}, platform: "linux" });
    const canonicalPath = join(homeDir, ".shux");

    expect(result.status).toBe("migrated");
    expect(await fs.readFile(join(canonicalPath, "config.json"), "utf8")).toBe("cmux");
    expect(await fs.realpath(join(homeDir, ".mux"))).toBe(await fs.realpath(canonicalPath));
    expect(await fs.realpath(cmuxPath)).toBe(await fs.realpath(canonicalPath));
  });

  test("rolls a just-migrated tree back when the primary alias cannot be created", async () => {
    const homeDir = await createTempDir();
    const legacyPath = join(homeDir, ".mux");
    await fs.mkdir(legacyPath);
    await fs.writeFile(join(legacyPath, "config.json"), "legacy", "utf8");

    const symlink = spyOn(fs, "symlink").mockImplementation(() => {
      throw new Error("EPERM: alias blocked");
    });

    try {
      const result = await initializeShuxHomeTransition({ homeDir, env: {}, platform: "linux" });

      expect(result.status).toBe("legacy-fallback");
      expect(result.activePath).toBe(legacyPath);
      expect(await fs.readFile(join(legacyPath, "config.json"), "utf8")).toBe("legacy");
      expect((await fs.lstat(legacyPath)).isDirectory()).toBe(true);
      await expectMissingPath(join(homeDir, ".shux"));
    } finally {
      symlink.mockRestore();
    }
  });

  test("does not treat a broken alias or file as a migratable directory", async () => {
    const homeDir = await createTempDir();
    await fs.symlink(join(homeDir, "missing-target"), join(homeDir, ".mux"));
    await fs.writeFile(join(homeDir, ".cmux"), "not-a-directory", "utf8");

    const result = await initializeShuxHomeTransition({ homeDir, env: {}, platform: "linux" });
    const canonicalPath = join(homeDir, ".shux");

    expect(result.status).toBe("conflict");
    expect((await fs.lstat(canonicalPath)).isDirectory()).toBe(true);
    expect((await fs.lstat(join(homeDir, ".mux"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(join(homeDir, ".cmux"))).isFile()).toBe(true);
    expect(await fs.readdir(canonicalPath)).toEqual([]);
  });

  test("transitions development storage without repointing production cmux", async () => {
    const homeDir = await createTempDir();
    const legacyDevPath = join(homeDir, ".mux-dev");
    const productionCmuxPath = join(homeDir, ".cmux");
    await fs.mkdir(legacyDevPath);
    await fs.mkdir(productionCmuxPath);

    const result = await initializeShuxHomeTransition({
      homeDir,
      env: { NODE_ENV: "development" },
      platform: "linux",
    });

    expect(result.canonicalPath).toBe(join(homeDir, ".shux-dev"));
    expect(await fs.realpath(legacyDevPath)).toBe(await fs.realpath(result.canonicalPath));
    expect((await fs.lstat(productionCmuxPath)).isDirectory()).toBe(true);
  });

  test("does not move explicit roots and mirrors SHUX_ROOT to MUX_ROOT", async () => {
    const homeDir = await createTempDir();
    const explicitRoot = join(homeDir, "custom");
    const leftoverMux = join(homeDir, ".mux");
    await fs.mkdir(leftoverMux);
    await fs.writeFile(join(leftoverMux, "config.json"), "untouched", "utf8");
    const env: Record<string, string | undefined> = { SHUX_ROOT: explicitRoot };

    const result = await initializeShuxHomeTransition({ homeDir, env, platform: "linux" });

    expect(result).toEqual({
      canonicalPath: explicitRoot,
      activePath: explicitRoot,
      status: "canonical",
      issues: [],
    });
    expect(env.MUX_ROOT).toBe(explicitRoot);
    // Explicit roots skip default-home moves, mkdirs, aliases, and leftover markers.
    expect(await fs.readFile(join(leftoverMux, "config.json"), "utf8")).toBe("untouched");
    expect((await fs.lstat(leftoverMux)).isDirectory()).toBe(true);
    await expectMissingPath(join(homeDir, ".shux"));
    await expectMissingPath(explicitRoot);
    await expectMissingPath(getShuxHomeLegacyFallbackMarkerPath(homeDir));
  });

  test("leaves independent canonical and legacy directories untouched", async () => {
    const homeDir = await createTempDir();
    const canonicalPath = join(homeDir, ".shux");
    const legacyPath = join(homeDir, ".mux");
    await fs.mkdir(canonicalPath);
    await fs.mkdir(legacyPath);
    await fs.writeFile(join(canonicalPath, "canonical"), "new", "utf8");
    await fs.writeFile(join(legacyPath, "legacy"), "old", "utf8");

    const result = await initializeShuxHomeTransition({ homeDir, env: {}, platform: "linux" });

    expect(result.status).toBe("conflict");
    expect(result.issues).toHaveLength(1);
    expect(await fs.readFile(join(canonicalPath, "canonical"), "utf8")).toBe("new");
    expect(await fs.readFile(join(legacyPath, "legacy"), "utf8")).toBe("old");
    expect((await fs.lstat(legacyPath)).isDirectory()).toBe(true);
  });

  test("prefers a healthy legacy tree when canonical storage is a regular file", async () => {
    const homeDir = await createTempDir();
    const canonicalPath = join(homeDir, ".shux");
    const legacyPath = join(homeDir, ".mux");
    await fs.writeFile(canonicalPath, "not-a-directory", "utf8");
    await fs.mkdir(legacyPath);
    await fs.writeFile(join(legacyPath, "config.json"), "legacy", "utf8");

    const result = await initializeShuxHomeTransition({ homeDir, env: {}, platform: "linux" });

    expect(result.status).toBe("legacy-fallback");
    expect(result.activePath).toBe(legacyPath);
    expect(result.canonicalPath).toBe(canonicalPath);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.some((issue) => issue.includes(canonicalPath))).toBe(true);
    expect((await fs.lstat(canonicalPath)).isFile()).toBe(true);
    expect(await fs.readFile(canonicalPath, "utf8")).toBe("not-a-directory");
    expect(await fs.readFile(join(legacyPath, "config.json"), "utf8")).toBe("legacy");
    expect((await fs.lstat(legacyPath)).isDirectory()).toBe(true);
    await expectMissingPath(join(homeDir, ".cmux"));
    withHomeDir(homeDir, () => {
      expect(getShuxHome()).toBe(legacyPath);
    });
  });

  test("prefers a healthy legacy tree when canonical storage is a broken symlink", async () => {
    const homeDir = await createTempDir();
    const canonicalPath = join(homeDir, ".shux");
    const legacyPath = join(homeDir, ".mux");
    await fs.symlink(join(homeDir, "missing-target"), canonicalPath);
    await fs.mkdir(legacyPath);
    await fs.writeFile(join(legacyPath, "config.json"), "legacy", "utf8");

    const result = await initializeShuxHomeTransition({ homeDir, env: {}, platform: "linux" });

    expect(result.status).toBe("legacy-fallback");
    expect(result.activePath).toBe(legacyPath);
    expect(result.canonicalPath).toBe(canonicalPath);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.some((issue) => issue.includes(canonicalPath))).toBe(true);
    expect((await fs.lstat(canonicalPath)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(join(legacyPath, "config.json"), "utf8")).toBe("legacy");
    expect((await fs.lstat(legacyPath)).isDirectory()).toBe(true);
    await expectMissingPath(join(homeDir, ".cmux"));
    withHomeDir(homeDir, () => {
      expect(getShuxHome()).toBe(legacyPath);
    });
  });

  test("quarantines obstructing files and recovers a persistent canonical home", async () => {
    const homeDir = await createTempDir();
    const canonicalPath = join(homeDir, ".shux");
    const muxPath = join(homeDir, ".mux");
    const cmuxPath = join(homeDir, ".cmux");
    await fs.writeFile(canonicalPath, "canonical-bytes", "utf8");
    await fs.writeFile(muxPath, "mux-bytes", "utf8");
    await fs.writeFile(cmuxPath, "cmux-bytes", "utf8");

    const first = await initializeShuxHomeTransition({ homeDir, env: {}, platform: "linux" });

    expect(first.status).toBe("canonical");
    expect(first.activePath).toBe(canonicalPath);
    expect((await fs.stat(first.activePath)).isDirectory()).toBe(true);
    expect(
      first.issues.some(
        (issue) => issue.includes("Moved unusable") && issue.includes(canonicalPath)
      )
    ).toBe(true);
    expect(await fs.realpath(muxPath)).toBe(await fs.realpath(canonicalPath));
    expect(await fs.realpath(cmuxPath)).toBe(await fs.realpath(canonicalPath));

    const canonicalBackups = await listQuarantineBackups(homeDir, ".shux");
    const muxBackups = await listQuarantineBackups(homeDir, ".mux");
    const cmuxBackups = await listQuarantineBackups(homeDir, ".cmux");
    expect(canonicalBackups).toHaveLength(1);
    expect(muxBackups).toHaveLength(1);
    expect(cmuxBackups).toHaveLength(1);
    expect(await fs.readFile(canonicalBackups[0], "utf8")).toBe("canonical-bytes");
    expect(await fs.readFile(muxBackups[0], "utf8")).toBe("mux-bytes");
    expect(await fs.readFile(cmuxBackups[0], "utf8")).toBe("cmux-bytes");
    withHomeDir(homeDir, () => {
      expect(getShuxHome()).toBe(canonicalPath);
    });

    const second = await initializeShuxHomeTransition({ homeDir, env: {}, platform: "linux" });
    expect(second.activePath).toBe(first.activePath);
    expect((await fs.stat(second.activePath)).isDirectory()).toBe(true);
    expect(await listQuarantineBackups(homeDir, ".shux")).toEqual(canonicalBackups);
    expect(await fs.readFile(canonicalBackups[0], "utf8")).toBe("canonical-bytes");
    expect(await fs.readFile(muxBackups[0], "utf8")).toBe("mux-bytes");
    expect(await fs.readFile(cmuxBackups[0], "utf8")).toBe("cmux-bytes");
    withHomeDir(homeDir, () => {
      expect(getShuxHome()).toBe(first.activePath);
    });
  });

  test("quarantines broken aliases and recovers a persistent canonical home", async () => {
    const homeDir = await createTempDir();
    const canonicalPath = join(homeDir, ".shux");
    const muxPath = join(homeDir, ".mux");
    const cmuxPath = join(homeDir, ".cmux");
    const missingCanonical = join(homeDir, "missing-canonical");
    const missingMux = join(homeDir, "missing-mux");
    const missingCmux = join(homeDir, "missing-cmux");
    await fs.symlink(missingCanonical, canonicalPath);
    await fs.symlink(missingMux, muxPath);
    await fs.symlink(missingCmux, cmuxPath);

    const first = await initializeShuxHomeTransition({ homeDir, env: {}, platform: "linux" });

    expect(first.status).toBe("canonical");
    expect(first.activePath).toBe(canonicalPath);
    expect((await fs.stat(first.activePath)).isDirectory()).toBe(true);
    expect(await fs.realpath(muxPath)).toBe(await fs.realpath(canonicalPath));
    expect(await fs.realpath(cmuxPath)).toBe(await fs.realpath(canonicalPath));

    const canonicalBackups = await listQuarantineBackups(homeDir, ".shux");
    const muxBackups = await listQuarantineBackups(homeDir, ".mux");
    const cmuxBackups = await listQuarantineBackups(homeDir, ".cmux");
    expect(canonicalBackups).toHaveLength(1);
    expect((await fs.lstat(canonicalBackups[0])).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(canonicalBackups[0])).toBe(missingCanonical);
    expect(await fs.readlink(muxBackups[0])).toBe(missingMux);
    expect(await fs.readlink(cmuxBackups[0])).toBe(missingCmux);
    withHomeDir(homeDir, () => {
      expect(getShuxHome()).toBe(canonicalPath);
    });

    const second = await initializeShuxHomeTransition({ homeDir, env: {}, platform: "linux" });
    expect(second.activePath).toBe(first.activePath);
    expect((await fs.stat(second.activePath)).isDirectory()).toBe(true);
    expect(await listQuarantineBackups(homeDir, ".shux")).toEqual(canonicalBackups);
    expect(await fs.readlink(canonicalBackups[0])).toBe(missingCanonical);
    withHomeDir(homeDir, () => {
      expect(getShuxHome()).toBe(first.activePath);
    });
  });

  test("does not activate an unhealthy canonical path when no healthy legacy tree exists", async () => {
    const homeDir = await createTempDir();
    const canonicalPath = join(homeDir, ".shux");
    const fallbackPath = join(homeDir, ".mux");
    await fs.writeFile(canonicalPath, "not-a-directory", "utf8");

    const result = await initializeShuxHomeTransition({ homeDir, env: {}, platform: "linux" });

    expect(result.status).toBe("legacy-fallback");
    expect(result.activePath).toBe(fallbackPath);
    expect(result.canonicalPath).toBe(canonicalPath);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.some((issue) => issue.includes(canonicalPath))).toBe(true);
    expect((await fs.lstat(canonicalPath)).isFile()).toBe(true);
    expect(await fs.readFile(canonicalPath, "utf8")).toBe("not-a-directory");
    expect((await fs.lstat(fallbackPath)).isDirectory()).toBe(true);
    withHomeDir(homeDir, () => {
      expect(getShuxHome()).toBe(fallbackPath);
    });
  });

  test("falls back to the populated leftover when empty canonical cannot be removed", async () => {
    const homeDir = await createTempDir();
    const canonicalPath = join(homeDir, ".shux");
    const legacyPath = join(homeDir, ".mux");
    await fs.mkdir(canonicalPath);
    await fs.mkdir(legacyPath);
    await fs.writeFile(join(legacyPath, "config.json"), "legacy", "utf8");
    const env: Record<string, string | undefined> = {};
    const rmdir = spyOn(fs, "rmdir").mockImplementation(() => {
      throw new Error("EBUSY: directory locked");
    });

    try {
      const result = await initializeShuxHomeTransition({ homeDir, env, platform: "linux" });

      expect(result.status).toBe("legacy-fallback");
      expect(result.activePath).toBe(legacyPath);
      expect(result.canonicalPath).toBe(canonicalPath);
      expect(result.issues.some((issue) => issue.includes(canonicalPath))).toBe(true);
      expect(await fs.readFile(join(legacyPath, "config.json"), "utf8")).toBe("legacy");
      expect((await fs.lstat(canonicalPath)).isDirectory()).toBe(true);
      expect(await fs.readdir(canonicalPath)).toEqual([]);
      expect(env.SHUX_ROOT).toBe(legacyPath);
      expect(env.MUX_ROOT).toBe(legacyPath);
      expect(sanitizeShuxChildEnv(env).SHUX_ROOT).toBe(legacyPath);
      expect(await fs.readFile(getShuxHomeLegacyFallbackMarkerPath(homeDir), "utf8")).toBe(
        ".mux\n"
      );
      withHomeDir(homeDir, () => {
        expect(getShuxHome()).toBe(legacyPath);
      });
    } finally {
      rmdir.mockRestore();
    }
  });

  test("falls back to the populated leftover when rename into the empty canonical fails", async () => {
    const homeDir = await createTempDir();
    const canonicalPath = join(homeDir, ".shux");
    const legacyPath = join(homeDir, ".mux");
    await fs.mkdir(canonicalPath);
    await fs.mkdir(legacyPath);
    await fs.writeFile(join(legacyPath, "config.json"), "legacy", "utf8");
    const env: Record<string, string | undefined> = {};
    const originalRename = fs.rename.bind(fs);
    const rename = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (
        resolve(String(from)) === resolve(legacyPath) &&
        resolve(String(to)) === resolve(canonicalPath)
      ) {
        throw new Error("EPERM: rename blocked");
      }
      return await originalRename(from, to);
    });

    try {
      const result = await initializeShuxHomeTransition({ homeDir, env, platform: "linux" });

      expect(result.status).toBe("legacy-fallback");
      expect(result.activePath).toBe(legacyPath);
      expect(result.canonicalPath).toBe(canonicalPath);
      expect(await fs.readFile(join(legacyPath, "config.json"), "utf8")).toBe("legacy");
      expect((await fs.lstat(canonicalPath)).isDirectory()).toBe(true);
      expect(await fs.readdir(canonicalPath)).toEqual([]);
      expect(env.SHUX_ROOT).toBe(legacyPath);
      expect(env.MUX_ROOT).toBe(legacyPath);
      expect(await fs.readFile(getShuxHomeLegacyFallbackMarkerPath(homeDir), "utf8")).toBe(
        ".mux\n"
      );
      withHomeDir(homeDir, () => {
        expect(getShuxHome()).toBe(legacyPath);
      });
    } finally {
      rename.mockRestore();
    }
  });

  test("retries empty-canonical adoption on the next startup without a persisted ROOT pin", async () => {
    const homeDir = await createTempDir();
    const canonicalPath = join(homeDir, ".shux");
    const legacyPath = join(homeDir, ".mux");
    await fs.mkdir(canonicalPath);
    await fs.mkdir(legacyPath);
    await fs.writeFile(join(legacyPath, "config.json"), "legacy", "utf8");
    const firstEnv: Record<string, string | undefined> = {};
    const rmdir = spyOn(fs, "rmdir").mockImplementation(() => {
      throw new Error("EBUSY: directory locked");
    });

    try {
      const first = await initializeShuxHomeTransition({
        homeDir,
        env: firstEnv,
        platform: "linux",
      });
      expect(first.status).toBe("legacy-fallback");
      expect(firstEnv.SHUX_ROOT).toBe(legacyPath);
      expect(await fs.readFile(getShuxHomeLegacyFallbackMarkerPath(homeDir), "utf8")).toBe(
        ".mux\n"
      );
    } finally {
      rmdir.mockRestore();
    }

    const restartedEnv: Record<string, string | undefined> = {};
    const second = await initializeShuxHomeTransition({
      homeDir,
      env: restartedEnv,
      platform: "linux",
    });

    expect(second.status).toBe("migrated");
    expect(second.activePath).toBe(canonicalPath);
    expect(restartedEnv.SHUX_ROOT).toBeUndefined();
    expect(restartedEnv.MUX_ROOT).toBeUndefined();
    expect(await fs.readFile(join(canonicalPath, "config.json"), "utf8")).toBe("legacy");
    expect(await fs.realpath(legacyPath)).toBe(await fs.realpath(canonicalPath));
    await expectMissingPath(getShuxHomeLegacyFallbackMarkerPath(homeDir));
    withHomeDir(homeDir, () => {
      expect(getShuxHome()).toBe(canonicalPath);
    });
  });

  test("stale leftover marker cannot override a populated independent canonical tree", async () => {
    const homeDir = await createTempDir();
    const canonicalPath = join(homeDir, ".shux");
    const legacyPath = join(homeDir, ".mux");
    await fs.mkdir(canonicalPath);
    await fs.mkdir(legacyPath);
    await fs.writeFile(join(canonicalPath, "canonical"), "new", "utf8");
    await fs.writeFile(join(legacyPath, "legacy"), "old", "utf8");
    await fs.writeFile(getShuxHomeLegacyFallbackMarkerPath(homeDir), ".mux\n", "utf8");

    withHomeDir(homeDir, () => {
      expect(getShuxHome()).toBe(canonicalPath);
    });

    const result = await initializeShuxHomeTransition({ homeDir, env: {}, platform: "linux" });

    expect(result.status).toBe("conflict");
    expect(result.activePath).toBe(canonicalPath);
    expect(await fs.readFile(join(canonicalPath, "canonical"), "utf8")).toBe("new");
    expect(await fs.readFile(join(legacyPath, "legacy"), "utf8")).toBe("old");
    await expectMissingPath(getShuxHomeLegacyFallbackMarkerPath(homeDir));
    withHomeDir(homeDir, () => {
      expect(getShuxHome()).toBe(canonicalPath);
    });
  });

  test("keeps production leftover markers isolated from development homes", async () => {
    const homeDir = await createTempDir();
    const prodCanonical = join(homeDir, ".shux");
    const prodLegacy = join(homeDir, ".mux");
    const devCanonical = join(homeDir, ".shux-dev");
    const devLegacy = join(homeDir, ".mux-dev");
    await fs.mkdir(prodCanonical);
    await fs.mkdir(prodLegacy);
    await fs.mkdir(devCanonical);
    await fs.mkdir(devLegacy);
    await fs.writeFile(join(prodLegacy, "config.json"), "prod", "utf8");
    await fs.writeFile(join(devLegacy, "config.json"), "dev", "utf8");
    const rmdir = spyOn(fs, "rmdir").mockImplementation(() => {
      throw new Error("EBUSY: directory locked");
    });

    try {
      const prod = await initializeShuxHomeTransition({ homeDir, env: {}, platform: "linux" });
      const dev = await initializeShuxHomeTransition({
        homeDir,
        env: { NODE_ENV: "development" },
        platform: "linux",
      });

      expect(prod.status).toBe("legacy-fallback");
      expect(dev.status).toBe("legacy-fallback");
      expect(await fs.readFile(getShuxHomeLegacyFallbackMarkerPath(homeDir), "utf8")).toBe(
        ".mux\n"
      );
      expect(await fs.readFile(getShuxHomeLegacyFallbackMarkerPath(homeDir, "-dev"), "utf8")).toBe(
        ".mux-dev\n"
      );
      withHomeDir(homeDir, () => {
        expect(getShuxHome()).toBe(prodLegacy);
        process.env.NODE_ENV = "development";
        expect(getShuxHome()).toBe(devLegacy);
      });
    } finally {
      rmdir.mockRestore();
    }
  });
});

describe("ensureShuxDirectoryTransition", () => {
  test("requests an absolute Windows junction without asserting NTFS behavior", async () => {
    const root = await createTempDir();
    const canonicalPath = join(root, "shux");
    const legacyPath = join(root, "mux");
    const symlink = spyOn(fs, "symlink").mockImplementation(() => Promise.resolve());

    try {
      const result = await ensureShuxDirectoryTransition({
        canonicalPath,
        legacyPaths: [legacyPath],
        platform: "win32",
      });

      expect(result.status).toBe("canonical");
      expect(symlink).toHaveBeenCalledWith(resolve(canonicalPath), legacyPath, "junction");
    } finally {
      symlink.mockRestore();
    }
  });
});

describe("initializeShuxUserDataTransition", () => {
  test("moves Electron userData and leaves the old app-name path pointing forward", async () => {
    const appDataDir = await createTempDir();
    const legacyPath = join(appDataDir, "mux");
    await fs.mkdir(legacyPath);
    await fs.writeFile(join(legacyPath, "window-state.json"), "{}", "utf8");

    const result = await initializeShuxUserDataTransition({ appDataDir, platform: "linux" });

    expect(result.status).toBe("migrated");
    expect(result.canonicalPath).toBe(join(appDataDir, "shux"));
    expect(await fs.readFile(join(result.canonicalPath, "window-state.json"), "utf8")).toBe("{}");
    expect(await fs.realpath(legacyPath)).toBe(await fs.realpath(result.canonicalPath));
    expect(await fs.realpath(join(appDataDir, "Mux"))).toBe(
      await fs.realpath(result.canonicalPath)
    );
  });

  test("migrates the historical Linux Mux userData name", async () => {
    const appDataDir = await createTempDir();
    const legacyPath = join(appDataDir, "Mux");
    await fs.mkdir(legacyPath);
    await fs.writeFile(join(legacyPath, "window-state.json"), "{}", "utf8");

    const result = await initializeShuxUserDataTransition({ appDataDir, platform: "linux" });

    expect(result.status).toBe("migrated");
    expect(await fs.readFile(join(result.canonicalPath, "window-state.json"), "utf8")).toBe("{}");
    expect(await fs.realpath(legacyPath)).toBe(await fs.realpath(result.canonicalPath));
    expect(await fs.realpath(join(appDataDir, "mux"))).toBe(
      await fs.realpath(result.canonicalPath)
    );
  });

  test("adopts a populated legacy tree into an empty canonical userData directory", async () => {
    const appDataDir = await createTempDir();
    const canonicalPath = join(appDataDir, "shux");
    const legacyPath = join(appDataDir, "mux");
    await fs.mkdir(canonicalPath);
    await fs.mkdir(legacyPath);
    await fs.writeFile(join(legacyPath, "window-state.json"), "{}", "utf8");

    const result = await initializeShuxUserDataTransition({ appDataDir, platform: "linux" });

    expect(result.status).toBe("migrated");
    expect(await fs.readFile(join(canonicalPath, "window-state.json"), "utf8")).toBe("{}");
    expect(await fs.realpath(legacyPath)).toBe(await fs.realpath(canonicalPath));
    expect(await fs.realpath(join(appDataDir, "Mux"))).toBe(await fs.realpath(canonicalPath));
    expect((await fs.lstat(canonicalPath)).isDirectory()).toBe(true);
  });

  test("returns the populated leftover userData path when empty canonical adoption fails", async () => {
    const appDataDir = await createTempDir();
    const canonicalPath = join(appDataDir, "shux");
    const legacyPath = join(appDataDir, "mux");
    await fs.mkdir(canonicalPath);
    await fs.mkdir(legacyPath);
    await fs.writeFile(join(legacyPath, "window-state.json"), "{}", "utf8");
    const rmdir = spyOn(fs, "rmdir").mockImplementation(() => {
      throw new Error("EBUSY: directory locked");
    });

    try {
      const result = await initializeShuxUserDataTransition({ appDataDir, platform: "linux" });

      expect(result.status).toBe("legacy-fallback");
      expect(result.activePath).toBe(legacyPath);
      expect(result.canonicalPath).toBe(canonicalPath);
      expect(await fs.readFile(join(legacyPath, "window-state.json"), "utf8")).toBe("{}");
      expect((await fs.lstat(canonicalPath)).isDirectory()).toBe(true);
      expect(await fs.readdir(canonicalPath)).toEqual([]);
    } finally {
      rmdir.mockRestore();
    }
  });

  test("does not merge or delete independent populated userData trees", async () => {
    const appDataDir = await createTempDir();
    const canonicalPath = join(appDataDir, "shux");
    const muxPath = join(appDataDir, "mux");
    const productNamePath = join(appDataDir, "Mux");
    await fs.mkdir(canonicalPath);
    await fs.mkdir(muxPath);
    await fs.mkdir(productNamePath);
    await fs.writeFile(join(canonicalPath, "from-shux"), "new", "utf8");
    await fs.writeFile(join(muxPath, "from-mux"), "old", "utf8");
    await fs.writeFile(join(productNamePath, "from-Mux"), "older", "utf8");

    const result = await initializeShuxUserDataTransition({ appDataDir, platform: "linux" });

    expect(result.status).toBe("conflict");
    expect(await fs.readFile(join(canonicalPath, "from-shux"), "utf8")).toBe("new");
    expect(await fs.readFile(join(muxPath, "from-mux"), "utf8")).toBe("old");
    expect(await fs.readFile(join(productNamePath, "from-Mux"), "utf8")).toBe("older");
    expect((await fs.lstat(muxPath)).isDirectory()).toBe(true);
    expect((await fs.lstat(productNamePath)).isDirectory()).toBe(true);
  });

  test("quarantines obstructing userData files and recovers a persistent canonical directory", async () => {
    const appDataDir = await createTempDir();
    const canonicalPath = join(appDataDir, "shux");
    const muxPath = join(appDataDir, "mux");
    const productNamePath = join(appDataDir, "Mux");
    await fs.writeFile(canonicalPath, "canonical-bytes", "utf8");
    await fs.writeFile(muxPath, "mux-bytes", "utf8");
    await fs.writeFile(productNamePath, "Mux-bytes", "utf8");

    const first = await initializeShuxUserDataTransition({ appDataDir, platform: "linux" });

    expect(first.status).toBe("canonical");
    expect(first.activePath).toBe(canonicalPath);
    expect((await fs.stat(first.activePath)).isDirectory()).toBe(true);
    expect(await fs.realpath(muxPath)).toBe(await fs.realpath(canonicalPath));
    expect(await fs.realpath(productNamePath)).toBe(await fs.realpath(canonicalPath));
    expect(await fs.readFile((await listQuarantineBackups(appDataDir, "shux"))[0], "utf8")).toBe(
      "canonical-bytes"
    );
    expect(await fs.readFile((await listQuarantineBackups(appDataDir, "mux"))[0], "utf8")).toBe(
      "mux-bytes"
    );
    expect(await fs.readFile((await listQuarantineBackups(appDataDir, "Mux"))[0], "utf8")).toBe(
      "Mux-bytes"
    );

    const second = await initializeShuxUserDataTransition({ appDataDir, platform: "linux" });
    expect(second.activePath).toBe(first.activePath);
    expect((await fs.stat(second.activePath)).isDirectory()).toBe(true);
    expect(await fs.readFile((await listQuarantineBackups(appDataDir, "shux"))[0], "utf8")).toBe(
      "canonical-bytes"
    );
  });

  test("quarantines broken userData aliases and recovers a persistent canonical directory", async () => {
    const appDataDir = await createTempDir();
    const canonicalPath = join(appDataDir, "shux");
    const muxPath = join(appDataDir, "mux");
    const productNamePath = join(appDataDir, "Mux");
    const missingCanonical = join(appDataDir, "missing-canonical");
    const missingMux = join(appDataDir, "missing-mux");
    const missingMuxName = join(appDataDir, "missing-Mux");
    await fs.symlink(missingCanonical, canonicalPath);
    await fs.symlink(missingMux, muxPath);
    await fs.symlink(missingMuxName, productNamePath);

    const first = await initializeShuxUserDataTransition({ appDataDir, platform: "linux" });

    expect(first.status).toBe("canonical");
    expect(first.activePath).toBe(canonicalPath);
    expect((await fs.stat(first.activePath)).isDirectory()).toBe(true);
    expect(await fs.realpath(muxPath)).toBe(await fs.realpath(canonicalPath));
    expect(await fs.readlink((await listQuarantineBackups(appDataDir, "shux"))[0])).toBe(
      missingCanonical
    );
    expect(await fs.readlink((await listQuarantineBackups(appDataDir, "mux"))[0])).toBe(missingMux);
    expect(await fs.readlink((await listQuarantineBackups(appDataDir, "Mux"))[0])).toBe(
      missingMuxName
    );

    const second = await initializeShuxUserDataTransition({ appDataDir, platform: "linux" });
    expect(second.activePath).toBe(first.activePath);
    expect((await fs.stat(second.activePath)).isDirectory()).toBe(true);
    expect(await fs.readlink((await listQuarantineBackups(appDataDir, "shux"))[0])).toBe(
      missingCanonical
    );
  });

  test("prefers a healthy mux userData tree when the canonical entry is a regular file", async () => {
    const appDataDir = await createTempDir();
    const canonicalPath = join(appDataDir, "shux");
    const legacyPath = join(appDataDir, "mux");
    await fs.writeFile(canonicalPath, "not-a-directory", "utf8");
    await fs.mkdir(legacyPath);
    await fs.writeFile(join(legacyPath, "window-state.json"), "{}", "utf8");

    const result = await initializeShuxUserDataTransition({ appDataDir, platform: "linux" });

    expect(result.status).toBe("legacy-fallback");
    expect(result.activePath).toBe(legacyPath);
    expect(result.canonicalPath).toBe(canonicalPath);
    expect(result.issues.length).toBeGreaterThan(0);
    expect((await fs.lstat(canonicalPath)).isFile()).toBe(true);
    expect(await fs.readFile(join(legacyPath, "window-state.json"), "utf8")).toBe("{}");
    expect((await fs.lstat(legacyPath)).isDirectory()).toBe(true);
    await expectMissingPath(join(appDataDir, "Mux"));
  });

  test("targets the lowercase slug even when the Electron app name is display-cased", async () => {
    const appDataDir = await createTempDir();

    for (const platform of ["darwin", "win32"] as const) {
      const identity = getElectronAppIdentity(platform);
      const result = await initializeShuxUserDataTransition({ appDataDir, platform });

      expect(identity.appName).not.toBe(identity.userDataDirName);
      expect(result.canonicalPath).toBe(join(appDataDir, identity.userDataDirName));
      expect(result.canonicalPath.endsWith(identity.appName)).toBe(false);
      expect(result.activePath).toBe(result.canonicalPath);
    }
  });
});

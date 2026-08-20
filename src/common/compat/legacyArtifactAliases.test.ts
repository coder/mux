import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, readdirSync } from "node:fs";

const SCRIPT_PATH = resolve(
  import.meta.dir,
  "../../../scripts/create-legacy-mux-artifact-aliases.sh"
);

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "legacy-mux-artifact-aliases-"));
  tempDirs.push(dir);
  return dir;
}

function runAliasScript(
  releaseDir: string,
  env: NodeJS.ProcessEnv = process.env
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bash", [SCRIPT_PATH, releaseDir], {
    encoding: "utf8",
    env,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function releaseNames(releaseDir: string): string[] {
  return readdirSync(releaseDir).sort();
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("create-legacy-mux-artifact-aliases", () => {
  test("aliases lowercase shux artifacts to matching mux names", async () => {
    const releaseDir = await createTempDir();
    const canonicalName = "shux-0.28.2-arm64.dmg";
    await writeFile(join(releaseDir, canonicalName), "canonical-bytes");

    const result = runAliasScript(releaseDir);
    expect(result.status).toBe(0);

    const legacyPath = join(releaseDir, "mux-0.28.2-arm64.dmg");
    const legacyStat = lstatSync(legacyPath);
    expect(legacyStat.isSymbolicLink()).toBe(true);
    expect(releaseNames(releaseDir)).toEqual(["mux-0.28.2-arm64.dmg", canonicalName]);
    expect(releaseNames(releaseDir).some((name) => name.startsWith("mux-Shux-"))).toBe(false);
  });

  test("maps capitalized Shux leftovers to mux-* instead of mux-Shux-*", async () => {
    const releaseDir = await createTempDir();
    await writeFile(join(releaseDir, "Shux-0.28.2-x64.AppImage"), "leaked-product-name");

    const result = runAliasScript(releaseDir);
    expect(result.status).toBe(0);
    expect(releaseNames(releaseDir)).toEqual([
      "Shux-0.28.2-x64.AppImage",
      "mux-0.28.2-x64.AppImage",
    ]);
    expect(releaseNames(releaseDir).some((name) => /mux-[Ss]hux-/.test(name))).toBe(false);

    const legacyStat = lstatSync(join(releaseDir, "mux-0.28.2-x64.AppImage"));
    expect(legacyStat.isSymbolicLink()).toBe(true);
  });

  test("leaves preexisting aliases in place and falls back to a byte-identical copy", async () => {
    const releaseDir = await createTempDir();
    await writeFile(join(releaseDir, "shux-1.0.0-x64.exe"), "installer");
    await symlink("already-present", join(releaseDir, "mux-1.0.0-x64.exe"));

    const first = runAliasScript(releaseDir);
    expect(first.status).toBe(0);
    expect(releaseNames(releaseDir)).toEqual(["mux-1.0.0-x64.exe", "shux-1.0.0-x64.exe"]);

    const blockedBin = join(await createTempDir(), "blocked-bin");
    await mkdir(blockedBin);
    await writeFile(join(blockedBin, "ln"), "#!/bin/sh\nexit 1\n");
    await chmod(join(blockedBin, "ln"), 0o755);

    const copyDir = await createTempDir();
    const canonicalName = "shux-1.0.0-arm64.zip";
    await writeFile(join(copyDir, canonicalName), "zip-bytes");
    const copyResult = runAliasScript(copyDir, {
      ...process.env,
      PATH: `${blockedBin}:${process.env.PATH ?? ""}`,
    });
    expect(copyResult.status).toBe(0);

    const copiedPath = join(copyDir, "mux-1.0.0-arm64.zip");
    expect(lstatSync(copiedPath).isSymbolicLink()).toBe(false);
    expect(await readFile(copiedPath, "utf8")).toBe("zip-bytes");
  });
});

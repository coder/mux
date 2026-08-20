import { spawnSync } from "node:child_process";
import {
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  promises as fs,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  type PathLike,
  type Stats,
  type StatSyncFn,
} from "node:fs";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { getShuxHomeLegacyFallbackMarkerPath } from "@/common/compat/legacyMux";
import { initializeShuxHomeTransition } from "@/node/compat/shuxTransition";
import { sanitizeShuxChildEnv } from "@/node/runtime/childProcessEnv";
import { cleanupObsoleteShuxBinArtifacts, getShuxHome } from "./paths";

const tempDirs: string[] = [];
const envKeysToRestore = [
  "HOME",
  "USERPROFILE",
  "SHUX_ROOT",
  "SHUX_HOME",
  "MUX_ROOT",
  "NODE_ENV",
] as const;
const savedEnv = new Map<string, string | undefined>();

function createTempMuxRoot(): string {
  const dir = mkdtempSync(join(os.tmpdir(), "mux-paths-test-"));
  tempDirs.push(dir);
  return dir;
}

function snapshotEnv(): void {
  for (const key of envKeysToRestore) {
    if (!savedEnv.has(key)) {
      savedEnv.set(key, process.env[key]);
    }
  }
}

function restoreEnv(): void {
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  savedEnv.clear();
}

function withReportedSize(stats: Stats, size: number): Stats {
  return Object.create(stats, {
    size: { configurable: true, enumerable: true, value: size },
  }) as Stats;
}

function withHomeDir(homeDir: string, run: () => void): void {
  snapshotEnv();
  const homedirSpy = spyOn(os, "homedir");
  homedirSpy.mockReturnValue(homeDir);
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  delete process.env.SHUX_ROOT;
  delete process.env.SHUX_HOME;
  delete process.env.MUX_ROOT;
  delete process.env.NODE_ENV;

  try {
    run();
  } finally {
    homedirSpy.mockRestore();
    restoreEnv();
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("cleanupObsoleteShuxBinArtifacts", () => {
  test("removes obsolete agent-browser wrapper files from mux bin", () => {
    const muxRoot = createTempMuxRoot();
    const binDir = join(muxRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "agent-browser"), "#!/bin/sh\n", "utf8");
    writeFileSync(join(binDir, "agent-browser.cmd"), "@echo off\n", "utf8");
    writeFileSync(join(binDir, "mux-askpass"), "#!/bin/sh\necho keep\n", "utf8");

    cleanupObsoleteShuxBinArtifacts(muxRoot);

    expect(existsSync(join(binDir, "agent-browser"))).toBe(false);
    expect(existsSync(join(binDir, "agent-browser.cmd"))).toBe(false);
    expect(existsSync(join(binDir, "mux-askpass"))).toBe(true);
    expect(readFileSync(join(binDir, "mux-askpass"), "utf8")).toContain("keep");
  });

  test("does not remove directories named like obsolete wrapper files", () => {
    const muxRoot = createTempMuxRoot();
    const binDir = join(muxRoot, "bin");
    const wrapperDir = join(binDir, "agent-browser");
    mkdirSync(wrapperDir, { recursive: true });

    cleanupObsoleteShuxBinArtifacts(muxRoot);

    expect(existsSync(wrapperDir)).toBe(true);
    expect(lstatSync(wrapperDir).isDirectory()).toBe(true);
  });

  test("is a no-op when mux bin does not exist", () => {
    const muxRoot = createTempMuxRoot();
    expect(() => cleanupObsoleteShuxBinArtifacts(muxRoot)).not.toThrow();
  });
});

describe("getShuxHome", () => {
  test("uses SHUX_ROOT exactly when set", () => {
    const homeDir = createTempMuxRoot();

    withHomeDir(homeDir, () => {
      process.env.SHUX_ROOT = "/custom/shux-root";
      process.env.SHUX_HOME = "/ignored/shux-home";
      process.env.NODE_ENV = "production";

      expect(getShuxHome()).toBe("/custom/shux-root");
    });
  });

  test("ignores SHUX_HOME and uses the homedir default", () => {
    const homeDir = createTempMuxRoot();

    withHomeDir(homeDir, () => {
      process.env.SHUX_HOME = "/ignored/shux-home";
      process.env.NODE_ENV = "production";

      expect(getShuxHome()).toBe(join(homeDir, ".shux"));
    });
  });

  test("uses the development suffix without SHUX_ROOT", () => {
    const homeDir = createTempMuxRoot();

    withHomeDir(homeDir, () => {
      process.env.SHUX_HOME = "/ignored/shux-home";
      process.env.NODE_ENV = "development";

      expect(getShuxHome()).toBe(join(homeDir, ".shux-dev"));
    });
  });

  test("returns the canonical future path on a fresh home", () => {
    const homeDir = createTempMuxRoot();

    withHomeDir(homeDir, () => {
      expect(getShuxHome()).toBe(join(homeDir, ".shux"));
    });
  });

  test("prefers a usable canonical directory over leftover trees", () => {
    const homeDir = createTempMuxRoot();
    mkdirSync(join(homeDir, ".shux"));
    mkdirSync(join(homeDir, ".mux"));

    withHomeDir(homeDir, () => {
      expect(getShuxHome()).toBe(join(homeDir, ".shux"));
    });
  });

  test("prefers a healthy leftover tree when canonical storage is a regular file", () => {
    const homeDir = createTempMuxRoot();
    writeFileSync(join(homeDir, ".shux"), "not-a-directory", "utf8");
    mkdirSync(join(homeDir, ".mux"));

    withHomeDir(homeDir, () => {
      expect(getShuxHome()).toBe(join(homeDir, ".mux"));
    });
  });

  test("prefers a healthy leftover tree when canonical storage is a broken symlink", () => {
    const homeDir = createTempMuxRoot();
    symlinkSync(join(homeDir, "missing-target"), join(homeDir, ".shux"));
    mkdirSync(join(homeDir, ".mux"));

    withHomeDir(homeDir, () => {
      expect(getShuxHome()).toBe(join(homeDir, ".mux"));
    });
  });

  test("follows a transition fallback when canonical is unusable and leftover is new", async () => {
    const homeDir = createTempMuxRoot();
    writeFileSync(join(homeDir, ".shux"), "not-a-directory", "utf8");

    const result = await initializeShuxHomeTransition({ homeDir, env: {}, platform: "linux" });

    withHomeDir(homeDir, () => {
      expect(result.status).toBe("legacy-fallback");
      expect(getShuxHome()).toBe(result.activePath);
      expect(getShuxHome()).toBe(join(homeDir, ".mux"));
      expect(lstatSync(join(homeDir, ".shux")).isFile()).toBe(true);
    });
  });

  test("follows session ROOT aliases after failed empty-canonical adoption", async () => {
    const homeDir = createTempMuxRoot();
    mkdirSync(join(homeDir, ".shux"));
    mkdirSync(join(homeDir, ".mux"));
    writeFileSync(join(homeDir, ".mux", "config.json"), "legacy", "utf8");
    const env: Record<string, string | undefined> = {};
    const rmdir = spyOn(fs, "rmdir").mockImplementation(() => {
      throw new Error("EBUSY: directory locked");
    });

    try {
      const result = await initializeShuxHomeTransition({ homeDir, env, platform: "linux" });

      expect(result.status).toBe("legacy-fallback");
      expect(env.SHUX_ROOT).toBe(result.activePath);
      expect(env.MUX_ROOT).toBe(result.activePath);
      expect(sanitizeShuxChildEnv(env).SHUX_ROOT).toBe(result.activePath);
      expect(sanitizeShuxChildEnv(env).MUX_ROOT).toBe(result.activePath);
      expect(readFileSync(getShuxHomeLegacyFallbackMarkerPath(homeDir), "utf8")).toBe(".mux\n");

      withHomeDir(homeDir, () => {
        expect(getShuxHome()).toBe(result.activePath);
        expect(getShuxHome()).toBe(join(homeDir, ".mux"));
      });
    } finally {
      rmdir.mockRestore();
    }
  });

  test("follows a leftover marker in a clean env without running the transition", () => {
    const homeDir = createTempMuxRoot();
    const canonicalPath = join(homeDir, ".shux");
    const legacyPath = join(homeDir, ".mux");
    mkdirSync(canonicalPath);
    mkdirSync(legacyPath);
    writeFileSync(join(legacyPath, "server.lock"), "legacy-lock", "utf8");
    writeFileSync(getShuxHomeLegacyFallbackMarkerPath(homeDir), ".mux\n", "utf8");

    withHomeDir(homeDir, () => {
      // VS Code discovery/config only call getShuxHome(); they do not run the transition.
      expect(getShuxHome()).toBe(legacyPath);
      expect(readFileSync(join(getShuxHome(), "server.lock"), "utf8")).toBe("legacy-lock");
    });
  });

  test("ignores a malformed leftover marker and keeps an empty canonical home", () => {
    const homeDir = createTempMuxRoot();
    mkdirSync(join(homeDir, ".shux"));
    mkdirSync(join(homeDir, ".mux"));
    writeFileSync(join(homeDir, ".mux", "config.json"), "legacy", "utf8");
    writeFileSync(getShuxHomeLegacyFallbackMarkerPath(homeDir), "../.mux\n", "utf8");

    withHomeDir(homeDir, () => {
      expect(getShuxHome()).toBe(join(homeDir, ".shux"));
    });
  });

  test("ignores an oversized regular leftover marker without loading it as a leftover name", () => {
    const homeDir = createTempMuxRoot();
    const canonicalPath = join(homeDir, ".shux");
    mkdirSync(canonicalPath);
    mkdirSync(join(homeDir, ".mux"));
    writeFileSync(join(homeDir, ".mux", "config.json"), "legacy", "utf8");
    writeFileSync(getShuxHomeLegacyFallbackMarkerPath(homeDir), `.mux\n${"x".repeat(80)}`, "utf8");

    withHomeDir(homeDir, () => {
      expect(getShuxHome()).toBe(canonicalPath);
    });
  });

  test.skipIf(process.platform === "win32")(
    "ignores a FIFO leftover marker without blocking startup",
    () => {
      const homeDir = createTempMuxRoot();
      const canonicalPath = join(homeDir, ".shux");
      const markerPath = getShuxHomeLegacyFallbackMarkerPath(homeDir);
      mkdirSync(canonicalPath);
      mkdirSync(join(homeDir, ".mux"));
      writeFileSync(join(homeDir, ".mux", "config.json"), "legacy", "utf8");
      const fifo = spawnSync("mkfifo", [markerPath], { encoding: "utf8" });
      expect(fifo.status).toBe(0);
      expect(lstatSync(markerPath).isFIFO()).toBe(true);

      withHomeDir(homeDir, () => {
        expect(getShuxHome()).toBe(canonicalPath);
      });
    }
  );

  test("ignores a leftover marker that is a directory", () => {
    const homeDir = createTempMuxRoot();
    const canonicalPath = join(homeDir, ".shux");
    mkdirSync(canonicalPath);
    mkdirSync(join(homeDir, ".mux"));
    writeFileSync(join(homeDir, ".mux", "config.json"), "legacy", "utf8");
    mkdirSync(getShuxHomeLegacyFallbackMarkerPath(homeDir));

    withHomeDir(homeDir, () => {
      expect(getShuxHome()).toBe(canonicalPath);
    });
  });

  test("ignores a leftover marker symlink even when the target names a leftover home", () => {
    const homeDir = createTempMuxRoot();
    const canonicalPath = join(homeDir, ".shux");
    const markerTarget = join(homeDir, "marker-target");
    mkdirSync(canonicalPath);
    mkdirSync(join(homeDir, ".mux"));
    writeFileSync(join(homeDir, ".mux", "config.json"), "legacy", "utf8");
    writeFileSync(markerTarget, ".mux\n", "utf8");
    symlinkSync(markerTarget, getShuxHomeLegacyFallbackMarkerPath(homeDir));

    withHomeDir(homeDir, () => {
      expect(getShuxHome()).toBe(canonicalPath);
    });
  });

  test("rejects a leftover marker that grows after the size check", () => {
    const homeDir = createTempMuxRoot();
    const canonicalPath = join(homeDir, ".shux");
    const markerPath = getShuxHomeLegacyFallbackMarkerPath(homeDir);
    mkdirSync(canonicalPath);
    mkdirSync(join(homeDir, ".mux"));
    writeFileSync(join(homeDir, ".mux", "config.json"), "legacy", "utf8");
    writeFileSync(markerPath, `.mux\n${"x".repeat(80)}`, "utf8");

    const originalLstat = lstatSync;
    const originalFstat = fstatSync;
    const lstatSpy = spyOn(nodeFs, "lstatSync").mockImplementation(((path: PathLike) => {
      const stats = originalLstat(path);
      return path === markerPath ? withReportedSize(stats, 5) : stats;
    }) as StatSyncFn);
    const fstatSpy = spyOn(nodeFs, "fstatSync").mockImplementation(((fd: number) => {
      return withReportedSize(originalFstat(fd), 5);
    }) as typeof fstatSync);

    try {
      withHomeDir(homeDir, () => {
        expect(getShuxHome()).toBe(canonicalPath);
      });
      expect(lstatSpy).toHaveBeenCalled();
      expect(fstatSpy).toHaveBeenCalled();
    } finally {
      lstatSpy.mockRestore();
      fstatSpy.mockRestore();
    }
  });

  test("keeps explicit SHUX_ROOT even when leftover homes exist", () => {
    const homeDir = createTempMuxRoot();
    const explicitRoot = join(homeDir, "custom");
    writeFileSync(join(homeDir, ".shux"), "not-a-directory", "utf8");
    mkdirSync(join(homeDir, ".mux"));

    withHomeDir(homeDir, () => {
      process.env.SHUX_ROOT = explicitRoot;
      expect(getShuxHome()).toBe(explicitRoot);
    });
  });
});

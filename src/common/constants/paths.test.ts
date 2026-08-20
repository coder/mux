import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupObsoleteMuxBinArtifacts, getMuxHome } from "./paths";

const tempDirs: string[] = [];

function createTempMuxRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "mux-paths-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ENV_KEYS = ["MUX_ROOT", "MUX_HOME", "NODE_ENV"] as const;
type EnvKey = (typeof ENV_KEYS)[number];

describe("getMuxHome", () => {
  let originalEnv: Record<EnvKey, string | undefined>;

  beforeEach(() => {
    originalEnv = {
      MUX_ROOT: process.env.MUX_ROOT,
      MUX_HOME: process.env.MUX_HOME,
      NODE_ENV: process.env.NODE_ENV,
    };

    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("uses MUX_ROOT exactly when set", () => {
    process.env.MUX_ROOT = "/custom/mux-root";
    process.env.MUX_HOME = "/ignored/mux-home";
    process.env.NODE_ENV = "production";

    expect(getMuxHome()).toBe("/custom/mux-root");
  });

  test("ignores MUX_HOME and uses the homedir default", () => {
    process.env.MUX_HOME = "/ignored/mux-home";
    process.env.NODE_ENV = "production";

    expect(getMuxHome()).toBe(join(homedir(), ".mux"));
  });

  test("uses the development suffix without MUX_ROOT", () => {
    process.env.MUX_HOME = "/ignored/mux-home";
    process.env.NODE_ENV = "development";

    expect(getMuxHome()).toBe(join(homedir(), ".mux-dev"));
  });
});

describe("cleanupObsoleteMuxBinArtifacts", () => {
  test("removes obsolete agent-browser wrapper files from mux bin", () => {
    const muxRoot = createTempMuxRoot();
    const binDir = join(muxRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "agent-browser"), "#!/bin/sh\n", "utf8");
    writeFileSync(join(binDir, "agent-browser.cmd"), "@echo off\n", "utf8");
    writeFileSync(join(binDir, "mux-askpass"), "#!/bin/sh\necho keep\n", "utf8");

    cleanupObsoleteMuxBinArtifacts(muxRoot);

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

    cleanupObsoleteMuxBinArtifacts(muxRoot);

    expect(existsSync(wrapperDir)).toBe(true);
    expect(lstatSync(wrapperDir).isDirectory()).toBe(true);
  });

  test("is a no-op when mux bin does not exist", () => {
    const muxRoot = createTempMuxRoot();
    expect(() => cleanupObsoleteMuxBinArtifacts(muxRoot)).not.toThrow();
  });
});

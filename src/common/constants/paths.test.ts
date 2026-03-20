import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanupObsoleteMuxBinArtifacts } from "./paths";

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

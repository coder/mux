import * as fs from "fs";
import { access, mkdir, writeFile } from "fs/promises";
import { constants } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  BUNDLED_EXTENSIONS_DEV_SUBDIR,
  BUNDLED_EXTENSIONS_PACKAGED_SUBDIR,
  detectBundledExtensionRoot,
  resolveBundledExtensionRoot,
} from "./bundledExtensionRootResolver";

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

describe("resolveBundledExtensionRoot — pure resolution", () => {
  test("dev mode resolves to <repoRoot>/build/extensions", () => {
    const result = resolveBundledExtensionRoot({
      isPackagedElectron: false,
      repoRoot: "/repo",
      resourcesPath: undefined,
    });
    expect(result.mode).toBe("dev");
    expect(result.path).toBe(path.join("/repo", BUNDLED_EXTENSIONS_DEV_SUBDIR));
  });

  test("packaged mode resolves to <resourcesPath>/extensions", () => {
    const result = resolveBundledExtensionRoot({
      isPackagedElectron: true,
      repoRoot: "/repo",
      resourcesPath: "/Applications/Mux.app/Contents/Resources",
    });
    expect(result.mode).toBe("packaged");
    expect(result.path).toBe(
      path.join("/Applications/Mux.app/Contents/Resources", BUNDLED_EXTENSIONS_PACKAGED_SUBDIR)
    );
  });

  test("packaged mode without resourcesPath throws", () => {
    expect(() =>
      resolveBundledExtensionRoot({
        isPackagedElectron: true,
        repoRoot: "/repo",
        resourcesPath: undefined,
      })
    ).toThrow(/resourcesPath/iu);
  });

  test("dev mode without repoRoot throws", () => {
    expect(() =>
      resolveBundledExtensionRoot({
        isPackagedElectron: false,
        repoRoot: "",
        resourcesPath: undefined,
      })
    ).toThrow(/repoRoot/iu);
  });
});

describe("resolveBundledExtensionRoot — dev fixture filesystem", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-bundled-resolver-dev-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns a path that exists when build/extensions is assembled", async () => {
    const extensionsDir = path.join(tempDir, "build", "extensions");
    const demoDir = path.join(
      extensionsDir,
      "node_modules",
      "@coder",
      "mux-extension-platform-demo"
    );
    await mkdir(demoDir, { recursive: true });
    await writeFile(
      path.join(extensionsDir, "package.json"),
      JSON.stringify({ dependencies: { "@coder/mux-extension-platform-demo": "0.0.1" } })
    );
    await writeFile(
      path.join(demoDir, "package.json"),
      JSON.stringify({ name: "@coder/mux-extension-platform-demo", version: "0.0.1" })
    );

    const result = resolveBundledExtensionRoot({
      isPackagedElectron: false,
      repoRoot: tempDir,
      resourcesPath: undefined,
    });

    expect(result.path).toBe(extensionsDir);
    expect(await pathExists(result.path)).toBe(true);
    expect(
      await pathExists(
        path.join(
          result.path,
          "node_modules",
          "@coder",
          "mux-extension-platform-demo",
          "package.json"
        )
      )
    ).toBe(true);
  });

  test("returns the path even when build/extensions does not exist (caller decides how to handle)", async () => {
    const result = resolveBundledExtensionRoot({
      isPackagedElectron: false,
      repoRoot: tempDir,
      resourcesPath: undefined,
    });

    expect(result.path).toBe(path.join(tempDir, "build", "extensions"));
    expect(await pathExists(result.path)).toBe(false);
  });
});

describe("resolveBundledExtensionRoot — packaged fixture filesystem", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-bundled-resolver-pkg-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns a path that exists when the resources/extensions tree is assembled", async () => {
    const extensionsDir = path.join(tempDir, "extensions");
    const nodeModules = path.join(extensionsDir, "node_modules");
    const demoDir = path.join(nodeModules, "@coder", "mux-extension-platform-demo");
    await mkdir(demoDir, { recursive: true });
    await writeFile(
      path.join(demoDir, "package.json"),
      JSON.stringify({ name: "@coder/mux-extension-platform-demo", version: "0.0.1" })
    );

    const result = resolveBundledExtensionRoot({
      isPackagedElectron: true,
      repoRoot: "/unused",
      resourcesPath: tempDir,
    });

    expect(result.path).toBe(extensionsDir);
    expect(await pathExists(result.path)).toBe(true);
    expect(
      await pathExists(
        path.join(
          result.path,
          "node_modules",
          "@coder",
          "mux-extension-platform-demo",
          "package.json"
        )
      )
    ).toBe(true);
  });

  test("ignores repoRoot in packaged mode", () => {
    const result = resolveBundledExtensionRoot({
      isPackagedElectron: true,
      repoRoot: "/should/be/ignored",
      resourcesPath: tempDir,
    });

    expect(result.path.startsWith(tempDir)).toBe(true);
    expect(result.path.includes("/should/be/ignored")).toBe(false);
  });
});

describe("detectBundledExtensionRoot — process-driven detection", () => {
  test("under bun (no electron), resolves dev-mode path off the module location", () => {
    const originalCwd = process.cwd();
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "mux-bundled-resolver-cwd-"));
    try {
      process.chdir(tempCwd);
      const result = detectBundledExtensionRoot();
      expect(result.mode).toBe("dev");
      expect(result.path).toBe(path.join(originalCwd, BUNDLED_EXTENSIONS_DEV_SUBDIR));
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tempCwd, { recursive: true, force: true });
    }
  });
});

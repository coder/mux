import * as fs from "fs";
import { access, mkdir, readFile, writeFile } from "fs/promises";
import { spawnSync } from "node:child_process";
import { constants } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resolveBundledExtensionRoot } from "./bundledExtensionRootResolver";
import { discoverExtensions, type ExtensionRootDescriptor } from "./extensionDiscoveryService";

// Test runs from the repo root (`bun test src` invocation pattern). Relying on
// process.cwd() keeps the test compatible with the CommonJS tsconfig.main.json
// (no import.meta.dir).
const REPO_ROOT = process.cwd();
const ASSEMBLE_SCRIPT = path.join(REPO_ROOT, "scripts", "bundled-extensions.ts");
const DEMO_EXTENSION_NAME = "mux-platform-demo";

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

describe("bundled-extensions-assemble", () => {
  let tempDir: string;
  let outDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-bundled-asm-"));
    outDir = path.join(tempDir, "extensions");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("validate fails when a bundled extension package has malformed package.json", async () => {
    const packagesDir = path.join(tempDir, "packages");
    const badPackageDir = path.join(packagesDir, "bad-extension");
    await mkdir(badPackageDir, { recursive: true });
    await writeFile(path.join(badPackageDir, "package.json"), "{ nope\n");
    await writeFile(
      path.join(badPackageDir, "extension.ts"),
      "export const manifest = { name: 'bad-extension', capabilities: { skills: true } };\n"
    );

    const result = spawnSync("bun", [ASSEMBLE_SCRIPT, "validate"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: { ...process.env, MUX_BUNDLED_EXTENSIONS_PACKAGES_DIR: packagesDir },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("bad-extension");
    expect(result.stderr).toContain("package.json");
  });

  test("validate fails when a bundled package has a malformed extension.ts", async () => {
    const packagesDir = path.join(tempDir, "packages");
    const badPackageDir = path.join(packagesDir, "bad-extension");
    const rootPkg = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf-8")) as {
      version: string;
    };
    await mkdir(badPackageDir, { recursive: true });
    await writeFile(
      path.join(badPackageDir, "package.json"),
      JSON.stringify({ name: "bad-extension", version: rootPkg.version }, null, 2)
    );
    await writeFile(
      path.join(badPackageDir, "extension.ts"),
      "export const manifest = createManifestDynamically();\n"
    );

    const result = spawnSync("bun", [ASSEMBLE_SCRIPT, "validate"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: { ...process.env, MUX_BUNDLED_EXTENSIONS_PACKAGES_DIR: packagesDir },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("bad-extension");
    expect(result.stderr).toContain("Static Manifest");
  });

  test("assembled directory tree contains the Demo Extension and resolves correctly", async () => {
    // Run the production assemble pipeline against an isolated out-dir. This
    // is the same code path Make wires into build / static-check / dev / test.
    const result = spawnSync("bun", [ASSEMBLE_SCRIPT, "assemble", "--out", outDir], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);

    // Tree shape: <out>/mux-platform-demo/{extension.ts,SKILL.md}
    const demoModuleDir = path.join(outDir, DEMO_EXTENSION_NAME);
    expect(await pathExists(path.join(demoModuleDir, "extension.ts"))).toBe(true);
    expect(await pathExists(path.join(demoModuleDir, "SKILL.md"))).toBe(true);

    // Discovery Service: the assembled root must validate end-to-end as a
    // bundled root and surface the demo extension's `mux-extensions` skill.
    const root: ExtensionRootDescriptor = {
      rootId: "bundled",
      kind: "bundled",
      path: outDir,
    };
    const grantedExtensionIds = new Set<string>([DEMO_EXTENSION_NAME]);
    const snapshot = await discoverExtensions({
      roots: [root],
      state: {
        isEnabled: () => true,
        getApprovalRecord: ({ extensionId }) =>
          grantedExtensionIds.has(extensionId)
            ? {
                grantedPermissions: ["skill.register"],
                requestedPermissionsHash: "test",
              }
            : undefined,
      },
    });

    expect(snapshot.roots).toHaveLength(1);
    const rootResult = snapshot.roots[0];
    expect(rootResult.state).toBe("ready");
    expect(rootResult.rootExists).toBe(true);
    expect(rootResult.diagnostics).toEqual([]);

    const demo = rootResult.extensions.find((e) => e.extensionId === DEMO_EXTENSION_NAME);
    expect(demo).toBeDefined();
    expect(demo?.activated).toBe(true);

    const skill = demo?.contributions.find((c) => c.type === "skills" && c.id === "mux-extensions");
    expect(skill).toBeDefined();
    expect(skill?.activated).toBe(true);
    expect(skill?.bodyPath).toBe("./SKILL.md");
  }, 30_000);

  test("packaged mode: resolver + assembled extraResources tree discovers Demo Extension", async () => {
    // Simulate the packaged Electron layout: electron-builder's extraResources
    // copies build/extensions into <resourcesPath>/extensions. We assemble into
    // <tempDir>/extensions, then treat tempDir as the resourcesPath and assert
    // the resolver lands on the assembled tree which Discovery can read.
    const result = spawnSync("bun", [ASSEMBLE_SCRIPT, "assemble", "--out", outDir], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);

    const resolved = resolveBundledExtensionRoot({
      isPackagedElectron: true,
      repoRoot: "/unused",
      resourcesPath: tempDir,
    });
    expect(resolved.mode).toBe("packaged");
    expect(resolved.path).toBe(outDir);
    expect(await pathExists(resolved.path)).toBe(true);

    const root: ExtensionRootDescriptor = {
      rootId: "bundled",
      kind: "bundled",
      path: resolved.path,
    };
    const snapshot = await discoverExtensions({
      roots: [root],
      state: {
        isEnabled: () => true,
        getApprovalRecord: () => ({
          grantedPermissions: ["skill.register"],
          requestedPermissionsHash: "test",
        }),
      },
    });

    expect(snapshot.roots[0].state).toBe("ready");
    const demo = snapshot.roots[0].extensions.find((e) => e.extensionId === DEMO_EXTENSION_NAME);
    expect(demo).toBeDefined();
    expect(demo?.activated).toBe(true);
  }, 30_000);
});

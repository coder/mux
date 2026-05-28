#!/usr/bin/env bun

/**
 * Bundled-extensions build pipeline.
 *
 * Subcommands:
 *   validate          Validate every packages/<name>/extension.ts Static Manifest
 *                     via the production Manifest Validator (rootKind: "bundled").
 *   build             Run each bundled-extension package's `build` script if
 *                     one is declared in its package.json.
 *   assemble [--out]  Copy each bundled Extension Module into
 *                     <out>/<manifest.name>/. Deterministic and offline — no
 *                     install, package.json root, or node_modules tree.
 *
 * Defaults:
 *   --out             build/extensions
 *
 * Used by Make targets bundled-extensions-{validate,build,assemble}.
 */

import { spawnSync } from "node:child_process";
import { access, cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import * as path from "node:path";

import {
  validateStaticManifest,
  type ExtensionDiagnostic,
} from "../src/common/extensions/manifestValidator";
import { extractStaticManifestFromFile } from "../src/node/extensions/staticManifestExtractor";

interface BundledExtensionModule {
  /** Absolute path to the package directory under packages/. */
  packageDir: string;
  /** Directory name (e.g. mux-extension-platform-demo). */
  dirName: string;
  /** Parsed package.json contents, retained for lockstep app-version validation. */
  pkg: Record<string, unknown>;
  /** Extension Module name from Static Manifest. */
  extensionName: string;
  /** The Static Manifest object exported from extension.ts. */
  rawManifest: Record<string, unknown>;
}

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const PACKAGES_DIR = process.env.MUX_BUNDLED_EXTENSIONS_PACKAGES_DIR
  ? path.resolve(process.env.MUX_BUNDLED_EXTENSIONS_PACKAGES_DIR)
  : path.join(REPO_ROOT, "packages");
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, "build", "extensions");

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  const text = await readFile(filePath, "utf-8");
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${filePath} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function discoverBundledExtensionModules(): Promise<BundledExtensionModule[]> {
  let entries;
  try {
    entries = await readdir(PACKAGES_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: BundledExtensionModule[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packageDir = path.join(PACKAGES_DIR, entry.name);
    const pkgPath = path.join(packageDir, "package.json");
    const entrypointPath = path.join(packageDir, "extension.ts");
    const hasEntrypoint = await fileExists(entrypointPath);
    let pkg: Record<string, unknown>;
    try {
      pkg = await readJson(pkgPath);
    } catch (error) {
      if (!hasEntrypoint) continue;
      throw new Error(
        `[bundled-extensions] ${entry.name} has extension.ts but package.json could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    if (!hasEntrypoint) continue;
    const extraction = await extractStaticManifestFromFile(entrypointPath);
    if (!extraction.ok) {
      const diagnostics = extraction.diagnostics.map(formatDiagnostic).join("\n");
      throw new Error(
        `[bundled-extensions] ${entry.name} has an invalid Static Manifest:\n${diagnostics}`
      );
    }
    const extensionName = extraction.manifest.name;
    if (typeof extensionName !== "string") {
      throw new Error(`[bundled-extensions] ${entry.name} Static Manifest is missing name.`);
    }
    out.push({
      packageDir,
      dirName: entry.name,
      pkg,
      extensionName,
      rawManifest: extraction.manifest,
    });
  }
  out.sort((a, b) => a.extensionName.localeCompare(b.extensionName));
  return out;
}

function formatDiagnostic(d: ExtensionDiagnostic): string {
  const ref = d.contributionRef
    ? ` [${d.contributionRef.type}#${d.contributionRef.id ?? d.contributionRef.index}]`
    : "";
  return `  [${d.severity}] ${d.code}${ref}: ${d.message}`;
}

async function cmdValidate(): Promise<number> {
  const packages = await discoverBundledExtensionModules();
  if (packages.length === 0) {
    console.log("[bundled-extensions] validate: no bundled Extension Modules found");
    return 0;
  }
  let failed = 0;
  for (const p of packages) {
    const result = validateStaticManifest({
      rawManifest: p.rawManifest,
      extensionName: p.extensionName,
      rootKind: "bundled",
    });
    const tag = result.ok ? "OK" : "FAILED";
    const out = result.ok ? console.log : console.error;
    out(`[bundled-extensions] validate: ${p.dirName} ${tag}`);
    for (const d of result.diagnostics) out(formatDiagnostic(d));
    if (!result.ok) failed++;
  }

  // Bundled extensions ship with the app, so version drift breaks release reproducibility.
  const rootPkg = await readJson(path.join(REPO_ROOT, "package.json"));
  const rootVersion = typeof rootPkg.version === "string" ? rootPkg.version : "";
  for (const p of packages) {
    const pkgVersion = typeof p.pkg.version === "string" ? p.pkg.version : "";
    if (pkgVersion !== rootVersion) {
      console.error(
        `[bundled-extensions] validate: ${p.dirName} version ${pkgVersion} does not match Mux app version ${rootVersion} (lockstep required)`
      );
      failed++;
    }
  }

  return failed === 0 ? 0 : 1;
}

async function cmdBuild(): Promise<number> {
  const packages = await discoverBundledExtensionModules();
  for (const p of packages) {
    const scripts = p.pkg.scripts;
    const hasBuild =
      typeof scripts === "object" &&
      scripts !== null &&
      typeof (scripts as Record<string, unknown>).build === "string";
    if (!hasBuild) {
      console.log(`[bundled-extensions] build: ${p.dirName} (no build script, skipping)`);
      continue;
    }
    console.log(`[bundled-extensions] build: ${p.dirName} (running bun run build)`);
    const result = spawnSync("bun", ["run", "build"], {
      cwd: p.packageDir,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      console.error(`[bundled-extensions] build: ${p.dirName} FAILED (exit ${result.status})`);
      return 1;
    }
  }
  return 0;
}

interface AssembleOptions {
  outDir: string;
}

async function assembleBundledExtensions(
  options: AssembleOptions
): Promise<{ outDir: string; packages: BundledExtensionModule[] }> {
  const packages = await discoverBundledExtensionModules();
  const outDir = path.resolve(options.outDir);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  for (const p of packages) {
    const targetDir = path.join(outDir, p.extensionName);
    await cp(p.packageDir, targetDir, {
      recursive: true,
      filter: (source) => path.basename(source) !== "package.json",
    });
    console.log(`[bundled-extensions] assemble: ${p.dirName} → ${targetDir}`);
  }

  return { outDir, packages };
}

async function cmdAssemble(args: string[]): Promise<number> {
  let outDir = DEFAULT_OUT_DIR;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out" || a === "--out-dir") {
      const next = args[i + 1];
      if (!next) {
        console.error("[bundled-extensions] assemble: --out requires a value");
        return 2;
      }
      outDir = path.resolve(next);
      i++;
    } else {
      console.error(`[bundled-extensions] assemble: unknown argument: ${a}`);
      return 2;
    }
  }
  const { packages } = await assembleBundledExtensions({ outDir });
  if (packages.length === 0) {
    console.log("[bundled-extensions] assemble: no packages found, wrote empty root");
  }
  return 0;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "validate":
      return cmdValidate();
    case "build":
      return cmdBuild();
    case "assemble":
      return cmdAssemble(rest);
    default:
      console.error(`Usage: bun scripts/bundled-extensions.ts <validate|build|assemble> [options]`);
      return command === undefined ? 0 : 2;
  }
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? (err.stack ?? err.message) : err);
      process.exit(1);
    }
  );
}

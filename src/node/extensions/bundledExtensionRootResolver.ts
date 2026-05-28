import * as path from "node:path";

// Dev mode uses the same assembled Extension Root shape as packaged Electron:
// direct child Extension Module folders under build/extensions. Packaged
// Electron copies that tree to process.resourcesPath/extensions via
// extraResources. Discovery Service consumes the resolved path without branching
// on environment.
export const BUNDLED_EXTENSIONS_DEV_SUBDIR = path.join("build", "extensions");
export const BUNDLED_EXTENSIONS_PACKAGED_SUBDIR = "extensions";

export type BundledExtensionRootMode = "dev" | "packaged";

export interface ResolvedBundledExtensionRoot {
  mode: BundledExtensionRootMode;
  path: string;
}

export interface BundledExtensionRootEnv {
  isPackagedElectron: boolean;
  repoRoot: string;
  resourcesPath: string | undefined;
}

export function resolveBundledExtensionRoot(
  env: BundledExtensionRootEnv
): ResolvedBundledExtensionRoot {
  if (env.isPackagedElectron) {
    if (!env.resourcesPath) {
      throw new Error(
        "Cannot resolve bundled extension root: resourcesPath is required in packaged Electron mode"
      );
    }
    return {
      mode: "packaged",
      path: path.join(env.resourcesPath, BUNDLED_EXTENSIONS_PACKAGED_SUBDIR),
    };
  }
  if (!env.repoRoot) {
    throw new Error("Cannot resolve bundled extension root: repoRoot is required in dev mode");
  }
  return {
    mode: "dev",
    path: path.join(env.repoRoot, BUNDLED_EXTENSIONS_DEV_SUBDIR),
  };
}

// Mirrors `detectCliEnvironment()` in src/cli/argv.ts; inlined because node/
// cannot import from cli/ (local/no-cross-boundary-imports).
function detectIsPackagedElectron(): boolean {
  return "electron" in process.versions && !process.defaultApp;
}

function pathBeforeSegment(dir: string, segment: string): string | null {
  const parts = dir.split(path.sep);
  const index = parts.lastIndexOf(segment);
  if (index === -1) return null;
  const candidate = parts.slice(0, index).join(path.sep);
  return candidate.length > 0 ? candidate : path.parse(dir).root;
}

function getModuleRepoRoot(): string {
  return (
    pathBeforeSegment(__dirname, "dist") ??
    pathBeforeSegment(__dirname, "src") ??
    path.resolve(__dirname, "..", "..", "..")
  );
}

export function detectBundledExtensionRoot(): ResolvedBundledExtensionRoot {
  return resolveBundledExtensionRoot({
    isPackagedElectron: detectIsPackagedElectron(),
    resourcesPath: process.resourcesPath,
    repoRoot: getModuleRepoRoot(),
  });
}

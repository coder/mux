import * as fs from "fs/promises";
import * as path from "path";

import type { Config } from "@/node/config";
import { detectBundledExtensionRoot } from "@/node/extensions/bundledExtensionRootResolver";
import type { ExtensionRootDescriptor } from "@/node/extensions/extensionDiscoveryService";
import {
  areProjectExtensionActiveSourcesCurrent,
  getProjectExtensionActiveRootPath,
  syncProjectExtensionLockSources,
  type SyncProjectExtensionLockSourcesInput,
} from "@/node/extensions/projectExtensionSourceSync";
import { log } from "@/node/services/log";
import type { ProjectExtensionStateService } from "@/node/extensions/projectExtensionStateService";

export const USER_GLOBAL_EXTENSION_ROOT_ID = "user-global";
export const BUNDLED_EXTENSION_ROOT_ID = "bundled";
const PROJECT_LOCAL_ROOT_PREFIX = "project-local:";

export function projectLocalRootId(projectPath: string): string {
  return `${PROJECT_LOCAL_ROOT_PREFIX}${projectPath}`;
}

export function projectPathFromProjectLocalRootId(rootId: string): string | null {
  if (!rootId.startsWith(PROJECT_LOCAL_ROOT_PREFIX)) return null;
  return rootId.slice(PROJECT_LOCAL_ROOT_PREFIX.length);
}

export function getFetchedGlobalExtensionRootPath(config: Config): string {
  return path.join(config.rootDir, "extensions", "global");
}

export function getUserGlobalExtensionRootPath(config: Config): string {
  return path.join(config.rootDir, "extensions", "local");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function pathIsDirectory(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

interface FileFingerprint {
  size: number;
  mtimeMs: number;
}

async function fileFingerprint(filePath: string): Promise<FileFingerprint | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function sameFingerprint(
  a: FileFingerprint | null | undefined,
  b: FileFingerprint | null
): boolean {
  return a != null && b !== null && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

interface ExtensionRootsProviderOptions {
  config: Config;
  projectState: ProjectExtensionStateService;
  syncProjectLocks?: (input: SyncProjectExtensionLockSourcesInput) => Promise<unknown>;
}

export function createExtensionRootsProvider(options: ExtensionRootsProviderOptions) {
  const resolvedBundledRoot = (() => {
    try {
      return detectBundledExtensionRoot();
    } catch {
      return null;
    }
  })();

  const syncedLockFingerprints = new Map<string, FileFingerprint>();

  return async (): Promise<readonly ExtensionRootDescriptor[]> => {
    const roots: ExtensionRootDescriptor[] = [];
    if (resolvedBundledRoot) {
      roots.push({
        rootId: BUNDLED_EXTENSION_ROOT_ID,
        kind: "bundled",
        path: resolvedBundledRoot.path,
      });
    }

    roots.push({
      rootId: USER_GLOBAL_EXTENSION_ROOT_ID,
      kind: "user-global",
      path: getUserGlobalExtensionRootPath(options.config),
    });

    const fetchedGlobalRootPath = getFetchedGlobalExtensionRootPath(options.config);
    if (await pathIsDirectory(fetchedGlobalRootPath)) {
      roots.push({
        rootId: "user-global-fetched",
        kind: "user-global",
        path: fetchedGlobalRootPath,
      });
    }

    const cfg = options.config.loadConfigOrDefault();
    for (const [projectPath, projectConfig] of cfg.projects) {
      const repoRootPath = path.join(projectPath, ".mux", "extensions");
      const activeRootPath = getProjectExtensionActiveRootPath(options.config.rootDir, projectPath);
      const lockPath = path.join(projectPath, ".mux", "extensions.lock.json");
      const activeRootExistsBeforeSync = await pathIsDirectory(activeRootPath);
      const repoRootExists = await pathIsDirectory(repoRootPath);
      const lockExists = await pathExists(lockPath);
      const stateExists = await pathExists(options.projectState.filePathFor(projectPath));
      const lockBackedActiveRootExists = lockExists && activeRootExistsBeforeSync;
      if (!lockBackedActiveRootExists && !repoRootExists && !lockExists && !stateExists) continue;

      const projectState = await options.projectState.load(projectPath);
      const trusted = projectConfig.trusted === true && projectState.state.rootTrusted;
      let projectLockSyncFailed = false;
      if (trusted && lockExists) {
        try {
          const lockFingerprint = await fileFingerprint(lockPath);
          const previousFingerprint = syncedLockFingerprints.get(projectPath);
          const activeSourcesCurrent =
            activeRootExistsBeforeSync &&
            (await areProjectExtensionActiveSourcesCurrent({
              projectPath,
              muxRootDir: options.config.rootDir,
            }));
          const shouldSyncProjectLock =
            !activeSourcesCurrent || !sameFingerprint(previousFingerprint, lockFingerprint);
          if (shouldSyncProjectLock) {
            await (options.syncProjectLocks ?? syncProjectExtensionLockSources)({
              projectPath,
              muxRootDir: options.config.rootDir,
              trusted,
            });
            if (lockFingerprint) syncedLockFingerprints.set(projectPath, lockFingerprint);
          }
        } catch (error) {
          syncedLockFingerprints.delete(projectPath);
          projectLockSyncFailed = true;
          log.warn("[extensions] Failed to sync project Extension Source Lock", {
            projectPath,
            error,
          });
        }
      }
      const activeRootExists =
        lockExists && !projectLockSyncFailed && (await pathIsDirectory(activeRootPath));
      const inspectionPath = projectLockSyncFailed
        ? path.dirname(lockPath)
        : activeRootExists
          ? activeRootPath
          : repoRootExists
            ? repoRootPath
            : lockExists
              ? path.dirname(lockPath)
              : repoRootPath;
      roots.push({
        rootId: projectLocalRootId(projectPath),
        kind: "project-local",
        path: inspectionPath,
        trusted: trusted && !projectLockSyncFailed,
      });
    }

    return roots;
  };
}

import * as path from "node:path";
import { VERSION } from "@/version";
import type { Config } from "@/node/config";
import type { BackupFileChange } from "@/common/orpc/schemas/backup";
import { normalizeUserPreferences } from "@/common/config/schemas/userPreferences";
import type { BackupGitRepo, BackupPayload, PreparedBackupRepository } from "./backupService";
import { BackupRepoCache } from "./gitRepo";
import {
  collectAllowlistedFiles,
  createBackupPayload,
  projectBackupPreferences,
  readBackupPayload,
  restoreBackupPayload,
  scanBackupFilesForSecrets,
  writeBackupPayload,
  type BackupFile,
} from "./payload";

function parsePorcelainStatus(output: string): BackupFileChange[] {
  if (!output) return [];
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2).trim() || "?";
      const rest = line.slice(3);
      // Renames are reported as "old -> new"; the destination is what a push writes.
      const arrow = rest.lastIndexOf(" -> ");
      return { status, path: arrow === -1 ? rest : rest.slice(arrow + 4) };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Bridges the persistent cache clone to the service-level contract. `prepare` is
 * always called before the other methods under the service's per-repo lock, so the
 * prepared cache is retained by root directory: the same instance must service the
 * later calls because it holds the fetched base commit that guards the push.
 */
export function createBackupGitRepo(options: { cacheRoot: string }): BackupGitRepo {
  const prepared = new Map<string, BackupRepoCache>();

  function cacheFor(repository: PreparedBackupRepository): BackupRepoCache {
    const cache = prepared.get(repository.rootDir);
    if (!cache) throw new Error("Backup repository was not prepared");
    return cache;
  }

  return {
    async validate(settings) {
      const cache = new BackupRepoCache({ ...settings, cacheRoot: options.cacheRoot });
      const refs = await cache.lsRemote();
      return { credential: refs.credential, empty: refs.refs.size === 0 };
    },

    async prepare(settings) {
      const cache = new BackupRepoCache({ ...settings, cacheRoot: options.cacheRoot });
      await cache.ensureCache();
      await cache.fetch();
      const remoteCommit = await cache.resetHardToRemote();
      await cache.cleanManagedPath(settings.path);
      prepared.set(cache.cachePath, cache);
      return {
        rootDir: cache.cachePath,
        credential: cache.credential ?? "ambient",
        remoteCommit,
      };
    },

    async getPushChanges(repository, managedPath) {
      return parsePorcelainStatus(await cacheFor(repository).porcelainStatus(managedPath));
    },

    async commitAndPush(repository, commitOptions) {
      const cache = cacheFor(repository);
      const commit = await cache.stageAndCommit(commitOptions.managedPath, commitOptions.message);
      if (commit == null) {
        return { commit: commitOptions.expectedRemoteCommit ?? "", changed: false };
      }
      return { commit: await cache.push(), changed: true };
    },
  };
}

/**
 * Bridges payload collection to the service-level contract. Preferences are read
 * from and written through `Config` rather than the config file so restores reuse
 * schema validation and reach open windows through the existing change stream.
 */
export function createBackupPayloadStore(options: { config: Config }): BackupPayload {
  const muxRoot = options.config.rootDir;

  function managedDir(repositoryRoot: string, managedPath: string): string {
    return path.join(repositoryRoot, ...managedPath.split("/"));
  }

  function currentPreferences() {
    return projectBackupPreferences(options.config.loadConfigOrDefault().userPreferences ?? {});
  }

  async function localFilesByPath(): Promise<Map<string, BackupFile>> {
    return new Map((await collectAllowlistedFiles(muxRoot)).map((file) => [file.path, file]));
  }

  async function buildPayload() {
    return await createBackupPayload({
      muxRoot,
      preferences: currentPreferences(),
      muxVersion: VERSION.git_describe,
      sourceLabel: path.basename(muxRoot),
    });
  }

  return {
    async exportTo(exportOptions) {
      const payload = await buildPayload();
      await writeBackupPayload(
        managedDir(exportOptions.repositoryRoot, exportOptions.managedPath),
        payload
      );
      return {
        redactions: payload.redactions,
        secretFiles: scanBackupFilesForSecrets(payload.files),
      };
    },

    async previewRestore(previewOptions) {
      const payload = await readBackupPayload(
        managedDir(previewOptions.repositoryRoot, previewOptions.managedPath)
      );
      const local = await localFilesByPath();
      const changes: BackupFileChange[] = [];
      for (const file of payload.files) {
        const existing = local.get(file.path);
        if (!existing) {
          changes.push({ status: "A", path: file.path });
        } else if (!existing.content.equals(file.content)) {
          changes.push({ status: "M", path: file.path });
        }
      }
      const backedUp = new Set(payload.files.map((file) => file.path));
      return {
        changes: changes.sort((a, b) => a.path.localeCompare(b.path)),
        localOnlyFiles: [...local.keys()].filter((file) => !backedUp.has(file)).sort(),
      };
    },

    async validateRestore(validateOptions) {
      await readBackupPayload(
        managedDir(validateOptions.repositoryRoot, validateOptions.managedPath)
      );
    },

    async writeSafetySnapshot(snapshotRoot) {
      await writeBackupPayload(snapshotRoot, await buildPayload());
    },

    async restore(restoreOptions) {
      const payload = await readBackupPayload(
        managedDir(restoreOptions.repositoryRoot, restoreOptions.managedPath)
      );
      const before = await localFilesByPath();
      const result = await restoreBackupPayload({
        muxRoot,
        payload,
        currentPreferences: currentPreferences(),
      });
      await options.config.editConfig((current) => ({
        ...current,
        userPreferences: normalizeUserPreferences(result.preferences),
      }));

      const after = await localFilesByPath();
      const changedFiles = [...after.entries()]
        .filter(([file, current]) => !before.get(file)?.content.equals(current.content))
        .map(([file]) => file)
        .sort();
      return { changedFiles, localOnlyFiles: result.localOnlyFiles };
    },
  };
}

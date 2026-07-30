import * as path from "node:path";
import { VERSION } from "@/version";
import type { Config } from "@/node/config";
import type { BackupFileChange } from "@/common/orpc/schemas/backup";
import { normalizeUserPreferences } from "@/common/config/schemas/userPreferences";
import {
  BackupServiceError,
  type BackupGitRepo,
  type BackupPayload,
  type PreparedBackupRepository,
} from "./backupService";
import { BackupRepoCache } from "./gitRepo";
import {
  backupPayloadExists,
  resolveContainedPath,
  resolveRestoredContent,
  collectAllowlistedFiles,
  createBackupPayload,
  projectBackupPreferences,
  readBackupPayload,
  restoreBackupPayload,
  scanBackupFilesForSecrets,
  serializeBackupPreferences,
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
 * BackupService prepares the cache before push-related calls. Retaining that instance
 * preserves the fetched base commit used by the push guard.
 */
export function createBackupGitRepo(options: {
  cacheRoot: string;
  /** Resolved per call so a token added after startup is picked up without a restart. */
  getToken?: () => string | null;
}): BackupGitRepo {
  const prepared = new WeakMap<PreparedBackupRepository, BackupRepoCache>();

  function newCache(settings: { repoUrl: string; branch: string }): BackupRepoCache {
    return new BackupRepoCache({
      ...settings,
      cacheRoot: options.cacheRoot,
      token: options.getToken?.() ?? undefined,
    });
  }

  function cacheFor(repository: PreparedBackupRepository): BackupRepoCache {
    const cache = prepared.get(repository);
    if (!cache) throw new Error("Backup repository was not prepared");
    return cache;
  }

  return {
    async validate(settings) {
      const cache = newCache(settings);
      const refs = await cache.lsRemote();
      return { credential: refs.credential, empty: refs.refs.size === 0 };
    },

    async prepare(settings) {
      const cache = newCache(settings);
      await cache.ensureCache();
      await cache.fetch();
      const remoteCommit = await cache.resetHardToRemote();
      await cache.cleanManagedPath(settings.path);
      const repository = {
        rootDir: cache.cachePath,
        credential: cache.credential ?? "ambient",
        remoteCommit,
      };
      prepared.set(repository, cache);
      return repository;
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
 * `muxVersion` is provenance only, but writing it as undefined drops the key from the
 * manifest and makes the backup unreadable, so never let a missing build stamp through.
 */
function resolveMuxVersion(): string {
  const describe: unknown = VERSION.git_describe;
  return typeof describe === "string" && describe.length > 0 ? describe : "unknown";
}

/**
 * Bridges payload collection to the service-level contract. Preferences are read
 * from and written through `Config` rather than the config file so restores reuse
 * schema validation and reach open windows through the existing change stream.
 */
export function createBackupPayloadStore(options: { config: Config }): BackupPayload {
  const muxRoot = options.config.rootDir;

  // Walks the chain so a symlinked ancestor is rejected before writeBackupPayload's
  // recursive removal could follow it out of the cache clone.
  async function managedDir(repositoryRoot: string, managedPath: string): Promise<string> {
    const segments = managedPath.split("/").filter((segment) => segment !== "");
    return await resolveContainedPath(repositoryRoot, segments.join("/"));
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
      muxVersion: resolveMuxVersion(),
      sourceLabel: path.basename(muxRoot),
      // The service owns the user-facing override, so report rather than throw.
      reportSecrets: true,
    });
  }

  return {
    async exportTo(exportOptions) {
      const payload = await buildPayload();
      await writeBackupPayload(
        await managedDir(exportOptions.repositoryRoot, exportOptions.managedPath),
        payload
      );
      return {
        redactions: payload.redactions,
        secretFiles: scanBackupFilesForSecrets(payload.files),
      };
    },

    async previewRestore(previewOptions) {
      const sourceDir = await managedDir(previewOptions.repositoryRoot, previewOptions.managedPath);
      const local = await localFilesByPath();
      // A repository with no backup yet is a normal first-run state, not an error:
      // nothing would be restored, and every local file is local-only.
      if (!(await backupPayloadExists(sourceDir))) {
        return { changes: [], localOnlyFiles: [...local.keys()].sort() };
      }

      const payload = await readBackupPayload(sourceDir);
      const changes: BackupFileChange[] = [];
      for (const file of payload.files) {
        // Preferences live in config rather than on disk, so compare against the
        // projection an export would produce right now.
        const existing =
          file.path === "preferences.json"
            ? serializeBackupPreferences(currentPreferences())
            : local.get(file.path)?.content;
        if (!existing) {
          changes.push({ status: "A", path: file.path });
          continue;
        }
        // Restore puts locally-held values back where the backup carries a redaction
        // marker, so compare what restore would write or every redaction reads as a change.
        if (!existing.equals(await resolveRestoredContent(muxRoot, file))) {
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
      const sourceDir = await managedDir(
        validateOptions.repositoryRoot,
        validateOptions.managedPath
      );
      if (!(await backupPayloadExists(sourceDir))) {
        throw new BackupServiceError(
          "INVALID_BACKUP",
          `No Mux backup found in '${validateOptions.managedPath}' on this branch`
        );
      }
      await readBackupPayload(sourceDir);
    },

    async writeSafetySnapshot(snapshotRoot) {
      await writeBackupPayload(snapshotRoot, await buildPayload());
    },

    async restore(restoreOptions) {
      const payload = await readBackupPayload(
        await managedDir(restoreOptions.repositoryRoot, restoreOptions.managedPath)
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

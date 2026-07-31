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
  mergeBackupPreferences,
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
  getToken?: (repoUrl: string) => string | null;
}): BackupGitRepo {
  const prepared = new WeakMap<PreparedBackupRepository, BackupRepoCache>();

  function newCache(settings: { repoUrl: string; branch: string }): BackupRepoCache {
    return new BackupRepoCache({
      ...settings,
      cacheRoot: options.cacheRoot,
      token: options.getToken?.(settings.repoUrl) ?? undefined,
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
function sameMode(a: BackupFile, b: BackupFile): boolean {
  return (a.executable === true) === (b.executable === true);
}

export function createBackupPayloadStore(options: { config: Config }): BackupPayload {
  const muxRoot = options.config.rootDir;

  // Walks the chain so a symlinked ancestor is rejected before writeBackupPayload's
  // recursive removal could follow it out of the cache clone.
  async function managedDir(repositoryRoot: string, managedPath: string): Promise<string> {
    const segments = managedPath.split("/").filter((segment) => segment !== "");
    return await resolveContainedPath(repositoryRoot, segments.join("/"));
  }

  function localPreferences() {
    return options.config.loadConfigOrDefault().userPreferences;
  }

  /** The portable subset an export writes. Machine-local keys are excluded by design. */
  function exportablePreferences() {
    return projectBackupPreferences(localPreferences() ?? {});
  }

  async function localFilesByPath(): Promise<Map<string, BackupFile>> {
    return new Map((await collectAllowlistedFiles(muxRoot)).map((file) => [file.path, file]));
  }

  async function buildPayload(overrides?: { keepLocalSecrets: true }) {
    return await createBackupPayload({
      muxRoot,
      preferences: exportablePreferences(),
      muxVersion: resolveMuxVersion(),
      sourceLabel: path.basename(muxRoot),
      // The service owns the user-facing override, so report rather than throw.
      reportSecrets: true,
      ...overrides,
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
        // Preferences live in config, and restore merges them rather than replacing the
        // file, so compare the merge result. A backup that only repeats values the local
        // config already holds changes nothing.
        if (file.path === "preferences.json") {
          const local = localPreferences();
          const merged = mergeBackupPreferences(local, JSON.parse(file.content.toString("utf-8")));
          if (!serializeBackupPreferences(local).equals(serializeBackupPreferences(merged))) {
            changes.push({ status: "M", path: file.path });
          }
          continue;
        }
        const existing = local.get(file.path);
        if (!existing) {
          changes.push({ status: "A", path: file.path });
          continue;
        }
        // Diff what restore would write, not the raw backup: rehydrated redactions
        // would otherwise read as a change on every preview.
        const restored = await resolveRestoredContent(muxRoot, file);
        if (!existing.content.equals(restored) || !sameMode(existing, file)) {
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
      // Unredacted: this copy never leaves the machine, and a redacted snapshot could
      // not restore a credential whose MCP server the restore removed.
      await writeBackupPayload(snapshotRoot, await buildPayload({ keepLocalSecrets: true }));
    },

    async restore(restoreOptions) {
      const payload = await readBackupPayload(
        await managedDir(restoreOptions.repositoryRoot, restoreOptions.managedPath)
      );
      const before = await localFilesByPath();
      const result = await restoreBackupPayload({
        muxRoot,
        payload,
        // The full local preferences, not the exportable projection: the merge result
        // replaces the stored object, so a projection here would drop machine-local keys.
        currentPreferences: localPreferences(),
      });
      await options.config.editConfig((current) => ({
        ...current,
        userPreferences: normalizeUserPreferences(result.preferences),
      }));

      const after = await localFilesByPath();
      const changedFiles = [...after.entries()]
        .filter(([file, current]) => {
          const previous = before.get(file);
          return !previous?.content.equals(current.content) || !sameMode(previous, current);
        })
        .map(([file]) => file)
        .sort();
      return { changedFiles, localOnlyFiles: result.localOnlyFiles };
    },
  };
}

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Config } from "@/node/config";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import type {
  BackupCommandApproval,
  BackupCredentialKind,
  BackupFileChange,
  BackupOperationError,
} from "@/common/orpc/schemas/backup";
import {
  SettingsBackupInputSchema,
  type SettingsBackup,
  type SettingsBackupInput,
} from "@/common/config/schemas/settingsBackup";
import { assertNotSymlink } from "./gitRepo";
import { BackupCommandApprovalRequiredError } from "./payload";

export interface PreparedBackupRepository {
  rootDir: string;
  credential: BackupCredentialKind;
  remoteCommit: string | null;
}

export interface BackupGitRepo {
  validate(settings: SettingsBackupInput): Promise<{
    credential: BackupCredentialKind;
    empty: boolean;
  }>;
  prepare(settings: SettingsBackupInput): Promise<PreparedBackupRepository>;
  getPushChanges(
    repository: PreparedBackupRepository,
    managedPath: string
  ): Promise<BackupFileChange[]>;
  commitAndPush(
    repository: PreparedBackupRepository,
    options: {
      managedPath: string;
      message: string;
      expectedRemoteCommit: string | null;
    }
  ): Promise<{ commit: string; changed: boolean; credential: BackupCredentialKind }>;
}

export interface BackupPayload {
  exportTo(options: {
    repositoryRoot: string;
    managedPath: string;
  }): Promise<{ redactions: string[]; secretFiles: string[]; secretApproval: string }>;
  previewRestore(options: { repositoryRoot: string; managedPath: string }): Promise<{
    changes: BackupFileChange[];
    localOnlyFiles: string[];
    commandApprovals: BackupCommandApproval[];
  }>;
  validateRestore(options: {
    repositoryRoot: string;
    managedPath: string;
    approvedCommandTokens?: readonly string[];
  }): Promise<void>;
  writeSafetySnapshot(snapshotRoot: string): Promise<void>;
  restore(options: {
    repositoryRoot: string;
    managedPath: string;
    approvedCommandTokens?: readonly string[];
  }): Promise<{ changedFiles: string[]; localOnlyFiles: string[] }>;
}

export interface BackupServiceDependencies {
  gitRepo: BackupGitRepo;
  payload: BackupPayload;
}

type BackupErrorCode = BackupOperationError["code"];

const BACKUP_ERROR_CODES = new Set<BackupErrorCode>([
  "AUTH_FAILED",
  "REMOTE_UNREACHABLE",
  "REPOSITORY_CHANGED",
  "INVALID_BACKUP",
  "SECRET_DETECTED",
  "COMMAND_APPROVAL_REQUIRED",
  "IO_ERROR",
  "GIT_ERROR",
]);

export class BackupServiceError extends Error {
  constructor(
    public readonly code: BackupErrorCode,
    message: string,
    public readonly files?: string[],
    public readonly secretApproval?: string
  ) {
    super(message);
    this.name = "BackupServiceError";
  }
}

function toOperationError(error: unknown): BackupOperationError {
  if (error instanceof BackupServiceError) {
    return {
      code: error.code,
      message: error.message,
      files: error.files,
      secretApproval: error.secretApproval,
    };
  }

  // A restore attempted without a preview, or after the backup's commands drifted, fails
  // with an approval list the UI has not seen yet. Dropping it would leave the user unable
  // to approve anything without guessing that Preview must be run again.
  if (error instanceof BackupCommandApprovalRequiredError) {
    return {
      code: error.code,
      message: error.message,
      commandApprovals: [...error.approvals],
    };
  }

  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown; files?: unknown };
    if (
      typeof candidate.code === "string" &&
      BACKUP_ERROR_CODES.has(candidate.code as BackupErrorCode)
    ) {
      return {
        code: candidate.code as BackupErrorCode,
        message: candidate.message,
        files: Array.isArray(candidate.files)
          ? candidate.files.filter((file): file is string => typeof file === "string")
          : undefined,
      };
    }
    return { code: "IO_ERROR", message: error.message };
  }

  return { code: "IO_ERROR", message: "Settings backup failed" };
}

function repoLockKey(settings: SettingsBackupInput): string {
  return `${settings.repoUrl}\0${settings.branch}`;
}

/** Service-level validation prevents direct callers from bypassing schema invariants. */
function normalizeBackupSettings(settings: SettingsBackupInput): SettingsBackupInput {
  const parsed = SettingsBackupInputSchema.safeParse(settings);
  if (!parsed.success) {
    throw new BackupServiceError(
      "INVALID_BACKUP",
      parsed.error.issues[0]?.message ?? "Invalid backup settings"
    );
  }
  return parsed.data;
}

export class BackupService {
  private readonly locks = new MutexMap<string>();

  constructor(
    private readonly config: Config,
    private readonly dependencies: BackupServiceDependencies
  ) {}

  getSettings(): SettingsBackup | null {
    return this.config.loadConfigOrDefault().settingsBackup ?? null;
  }

  async saveSettings(
    settings: SettingsBackupInput
  ): Promise<Result<SettingsBackup, BackupOperationError>> {
    try {
      const normalized = normalizeBackupSettings(settings);
      const saved = await this.persistSettings(normalized);
      return Ok(saved);
    } catch (error) {
      return Err(toOperationError(error));
    }
  }

  async validate(
    settings: SettingsBackupInput
  ): Promise<
    Result<
      { reachable: true; credential: BackupCredentialKind; empty: boolean },
      BackupOperationError
    >
  > {
    try {
      const normalized = normalizeBackupSettings(settings);
      const result = await this.dependencies.gitRepo.validate(normalized);
      return Ok({ reachable: true, ...result });
    } catch (error) {
      return Err(toOperationError(error));
    }
  }

  async preview(settings: SettingsBackupInput): Promise<
    Result<
      {
        pushChanges: BackupFileChange[];
        restoreChanges: BackupFileChange[];
        localOnlyFiles: string[];
        redactions: string[];
        commandApprovals: BackupCommandApproval[];
      },
      BackupOperationError
    >
  > {
    return this.withRepoLock(settings, async (normalized) => {
      try {
        const repository = await this.dependencies.gitRepo.prepare(normalized);
        const restorePreview = await this.dependencies.payload.previewRestore({
          repositoryRoot: repository.rootDir,
          managedPath: normalized.path,
        });
        const exported = await this.dependencies.payload.exportTo({
          repositoryRoot: repository.rootDir,
          managedPath: normalized.path,
        });
        const pushChanges = await this.dependencies.gitRepo.getPushChanges(
          repository,
          normalized.path
        );
        return Ok({
          pushChanges,
          restoreChanges: restorePreview.changes,
          localOnlyFiles: restorePreview.localOnlyFiles,
          redactions: exported.redactions,
          commandApprovals: restorePreview.commandApprovals,
        });
      } catch (error) {
        return Err(toOperationError(error));
      }
    });
  }

  async push(
    settings: SettingsBackupInput,
    options: { approvedSecretDigest?: string } = {}
  ): Promise<
    Result<
      {
        commit: string;
        changed: boolean;
        credential: BackupCredentialKind;
        redactions: string[];
      },
      BackupOperationError
    >
  > {
    const approvedSecretDigest = options.approvedSecretDigest;
    return this.withRepoLock(settings, async (normalized) => {
      try {
        const repository = await this.dependencies.gitRepo.prepare(normalized);
        const exported = await this.dependencies.payload.exportTo({
          repositoryRoot: repository.rootDir,
          managedPath: normalized.path,
        });
        // Approval is bound to the exact flagged bytes, so an override the user granted for
        // one payload cannot publish a different one another window wrote in between.
        if (exported.secretFiles.length > 0 && approvedSecretDigest !== exported.secretApproval) {
          throw new BackupServiceError(
            "SECRET_DETECTED",
            "Potential secrets were found in the backup payload",
            exported.secretFiles,
            exported.secretApproval
          );
        }

        const pushed = await this.dependencies.gitRepo.commitAndPush(repository, {
          managedPath: normalized.path,
          message: "Back up Mux settings",
          expectedRemoteCommit: repository.remoteCommit,
        });
        await this.persistSettings(normalized, { lastPushedCommit: pushed.commit });
        // The pushing credential, not the one prepare() used: the ladder can fall through
        // to a later rung when the earlier one can read but not write.
        return Ok({
          ...pushed,
          redactions: exported.redactions,
        });
      } catch (error) {
        return Err(toOperationError(error));
      }
    });
  }

  async restore(
    settings: SettingsBackupInput,
    options: { approvedCommandTokens?: readonly string[] } = {}
  ): Promise<
    Result<
      { commit: string; snapshotPath: string; changedFiles: string[]; localOnlyFiles: string[] },
      BackupOperationError
    >
  > {
    const approvedCommandTokens =
      options.approvedCommandTokens == null ? undefined : [...options.approvedCommandTokens];
    return this.withRepoLock(settings, async (normalized) => {
      try {
        const repository = await this.dependencies.gitRepo.prepare(normalized);
        if (repository.remoteCommit == null) {
          throw new BackupServiceError("INVALID_BACKUP", "The backup repository is empty");
        }

        // Before the snapshot, so a restore blocked on command approval does not leave an
        // unredacted copy of the local settings on disk.
        await this.dependencies.payload.validateRestore({
          repositoryRoot: repository.rootDir,
          managedPath: normalized.path,
          approvedCommandTokens,
        });
        const snapshotPath = await this.createSnapshotPath();
        try {
          await this.dependencies.payload.writeSafetySnapshot(snapshotPath);
        } catch (error) {
          // Nothing has been restored yet, so a snapshot that did not finish is an empty or
          // partial unredacted copy that no recovery can use, and every retry would add one.
          await fs.rm(snapshotPath, { recursive: true, force: true });
          throw error;
        }
        try {
          const restored = await this.dependencies.payload.restore({
            repositoryRoot: repository.rootDir,
            managedPath: normalized.path,
            approvedCommandTokens,
          });
          await this.persistSettings(normalized, { lastRestoredCommit: repository.remoteCommit });
          return Ok({
            commit: repository.remoteCommit,
            snapshotPath,
            changedFiles: restored.changedFiles,
            localOnlyFiles: restored.localOnlyFiles,
          });
        } catch (error) {
          // Past the snapshot, the restore may have overwritten files before failing, and
          // the snapshot is the only recovery path, so the failure must carry it.
          return Err({ ...toOperationError(error), snapshotPath });
        }
      } catch (error) {
        return Err(toOperationError(error));
      }
    });
  }

  private async persistSettings(
    settings: SettingsBackupInput,
    commitUpdate: Pick<SettingsBackup, "lastPushedCommit" | "lastRestoredCommit"> = {}
  ): Promise<SettingsBackup> {
    let saved: SettingsBackup | undefined;
    await this.config.editConfig((current) => {
      const previous = current.settingsBackup;
      const sameRepository =
        previous?.repoUrl === settings.repoUrl &&
        previous.branch === settings.branch &&
        previous.path === settings.path;
      // Commit metadata must not rewrite the repository settings tuple. Another window can
      // save a different repository while a push or restore is in flight.
      if (previous !== undefined && !sameRepository && Object.keys(commitUpdate).length > 0) {
        saved = previous;
        return current;
      }
      saved = {
        ...settings,
        ...(sameRepository
          ? {
              lastPushedCommit: previous.lastPushedCommit,
              lastRestoredCommit: previous.lastRestoredCommit,
            }
          : {}),
        ...commitUpdate,
      };
      return { ...current, settingsBackup: saved };
    });

    if (saved == null) {
      throw new BackupServiceError("IO_ERROR", "Settings backup configuration was not saved");
    }
    // saveConfig logs and swallows write failures by design, so a resolved editConfig does
    // not prove the write landed; on a full disk this method would otherwise report saved
    // settings, a recorded push, or a recorded restore that config.json never received.
    // loadConfigOrDefault reads the file fresh, so a lost write reads back as the old value.
    const stored = this.config.loadConfigOrDefault().settingsBackup;
    if (
      stored?.repoUrl !== saved.repoUrl ||
      stored.branch !== saved.branch ||
      stored.path !== saved.path ||
      stored.lastPushedCommit !== saved.lastPushedCommit ||
      stored.lastRestoredCommit !== saved.lastRestoredCommit
    ) {
      throw new BackupServiceError(
        "IO_ERROR",
        "The backup settings could not be written to config.json"
      );
    }
    return saved;
  }

  private async createSnapshotPath(): Promise<string> {
    // Mode matches the chmod `ensureCache` applies to this same directory: the snapshot
    // below is unredacted, so the tree above it must not be traversable by other users.
    const cacheRoot = path.join(this.config.rootDir, "backup-cache");
    // The snapshot holds the local settings unredacted, so a link here would put the copy
    // wherever it points (a world-readable /tmp, say).
    await assertNotSymlink(cacheRoot);
    await fs.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    return fs.mkdtemp(path.join(cacheRoot, "restore-"));
  }

  private withRepoLock<T>(
    settings: SettingsBackupInput,
    operation: (normalized: SettingsBackupInput) => Promise<Result<T, BackupOperationError>>
  ): Promise<Result<T, BackupOperationError>> {
    let normalized: SettingsBackupInput;
    try {
      normalized = normalizeBackupSettings(settings);
    } catch (error) {
      return Promise.resolve(Err(toOperationError(error)));
    }
    return this.locks.withLock(repoLockKey(normalized), () => operation(normalized));
  }
}

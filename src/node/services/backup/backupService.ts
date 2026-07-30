import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Config } from "@/node/config";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { isValidBackupPath } from "@/common/orpc/schemas/backup";
import type {
  BackupCredentialKind,
  BackupFileChange,
  BackupOperationError,
  SettingsBackup,
  SettingsBackupInput,
} from "@/common/orpc/schemas/backup";

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
  ): Promise<{ commit: string; changed: boolean }>;
}

export interface BackupPayload {
  exportTo(options: {
    repositoryRoot: string;
    managedPath: string;
  }): Promise<{ redactions: string[]; secretFiles: string[] }>;
  previewRestore(options: {
    repositoryRoot: string;
    managedPath: string;
  }): Promise<{ changes: BackupFileChange[]; localOnlyFiles: string[] }>;
  validateRestore(options: { repositoryRoot: string; managedPath: string }): Promise<void>;
  writeSafetySnapshot(snapshotRoot: string): Promise<void>;
  restore(options: {
    repositoryRoot: string;
    managedPath: string;
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
  "IO_ERROR",
  "GIT_ERROR",
]);

export class BackupServiceError extends Error {
  constructor(
    public readonly code: BackupErrorCode,
    message: string,
    public readonly files?: string[]
  ) {
    super(message);
    this.name = "BackupServiceError";
  }
}

function toOperationError(error: unknown): BackupOperationError {
  if (error instanceof BackupServiceError) {
    return { code: error.code, message: error.message, files: error.files };
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
  return `${settings.repoUrl.trim()}\0${settings.branch.trim()}`;
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
      // The ORPC schema also refines this, but the service owns the invariant because
      // the managed path scopes every write and every `git clean`.
      if (!isValidBackupPath(settings.path)) {
        throw new BackupServiceError(
          "INVALID_BACKUP",
          "Enter a subdirectory inside the repository"
        );
      }
      const saved = await this.persistSettings(settings);
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
      const result = await this.dependencies.gitRepo.validate(settings);
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
      },
      BackupOperationError
    >
  > {
    return this.withRepoLock(settings, async () => {
      try {
        const repository = await this.dependencies.gitRepo.prepare(settings);
        const restorePreview = await this.dependencies.payload.previewRestore({
          repositoryRoot: repository.rootDir,
          managedPath: settings.path,
        });
        const exported = await this.dependencies.payload.exportTo({
          repositoryRoot: repository.rootDir,
          managedPath: settings.path,
        });
        const pushChanges = await this.dependencies.gitRepo.getPushChanges(
          repository,
          settings.path
        );
        return Ok({
          pushChanges,
          restoreChanges: restorePreview.changes,
          localOnlyFiles: restorePreview.localOnlyFiles,
          redactions: exported.redactions,
        });
      } catch (error) {
        return Err(toOperationError(error));
      }
    });
  }

  async push(
    settings: SettingsBackupInput,
    options: { allowSecrets?: boolean } = {}
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
    return this.withRepoLock(settings, async () => {
      try {
        const repository = await this.dependencies.gitRepo.prepare(settings);
        const exported = await this.dependencies.payload.exportTo({
          repositoryRoot: repository.rootDir,
          managedPath: settings.path,
        });
        if (exported.secretFiles.length > 0 && options.allowSecrets !== true) {
          throw new BackupServiceError(
            "SECRET_DETECTED",
            "Potential secrets were found in the backup payload",
            exported.secretFiles
          );
        }

        const pushed = await this.dependencies.gitRepo.commitAndPush(repository, {
          managedPath: settings.path,
          message: "Back up Mux settings",
          expectedRemoteCommit: repository.remoteCommit,
        });
        await this.persistSettings(settings, { lastPushedCommit: pushed.commit });
        return Ok({
          ...pushed,
          credential: repository.credential,
          redactions: exported.redactions,
        });
      } catch (error) {
        return Err(toOperationError(error));
      }
    });
  }

  async restore(
    settings: SettingsBackupInput
  ): Promise<
    Result<
      { commit: string; snapshotPath: string; changedFiles: string[]; localOnlyFiles: string[] },
      BackupOperationError
    >
  > {
    return this.withRepoLock(settings, async () => {
      try {
        const repository = await this.dependencies.gitRepo.prepare(settings);
        if (repository.remoteCommit == null) {
          throw new BackupServiceError("INVALID_BACKUP", "The backup repository is empty");
        }

        await this.dependencies.payload.validateRestore({
          repositoryRoot: repository.rootDir,
          managedPath: settings.path,
        });
        const snapshotPath = await this.createSnapshotPath();
        await this.dependencies.payload.writeSafetySnapshot(snapshotPath);
        const restored = await this.dependencies.payload.restore({
          repositoryRoot: repository.rootDir,
          managedPath: settings.path,
        });
        await this.persistSettings(settings, { lastRestoredCommit: repository.remoteCommit });
        return Ok({
          commit: repository.remoteCommit,
          snapshotPath,
          changedFiles: restored.changedFiles,
          localOnlyFiles: restored.localOnlyFiles,
        });
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
    return saved;
  }

  private async createSnapshotPath(): Promise<string> {
    const cacheRoot = path.join(this.config.rootDir, "backup-cache");
    await fs.mkdir(cacheRoot, { recursive: true });
    return fs.mkdtemp(path.join(cacheRoot, "restore-"));
  }

  private withRepoLock<T>(settings: SettingsBackupInput, operation: () => Promise<T>): Promise<T> {
    return this.locks.withLock(repoLockKey(settings), operation);
  }
}

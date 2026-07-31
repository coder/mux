import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Config } from "@/node/config";
import type { ProjectsConfig } from "@/common/types/project";
import type { SettingsBackupInput } from "@/common/orpc/schemas/backup";
import { BackupNonFastForwardError } from "./gitRepo";
import { BackupRemoteUnreachableError } from "./credentials";
import {
  BackupService,
  BackupServiceError,
  type BackupGitRepo,
  type BackupPayload,
  type PreparedBackupRepository,
} from "./backupService";

const SETTINGS: SettingsBackupInput = {
  repoUrl: "git@github.com:example/settings.git",
  branch: "main",
  path: "mux",
};

class TestConfig extends Config {
  private state: ProjectsConfig = { projects: new Map() };

  override loadConfigOrDefault(): ProjectsConfig {
    return this.state;
  }

  override editConfig(edit: (config: ProjectsConfig) => ProjectsConfig): Promise<void> {
    this.state = edit(this.state);
    return Promise.resolve();
  }
}

function createTestConfig(rootDir: string): Config {
  return new TestConfig(rootDir);
}

function createRepository(
  overrides: Partial<PreparedBackupRepository> = {}
): PreparedBackupRepository {
  return {
    rootDir: "/cache/repository",
    credential: "ssh",
    remoteCommit: "remote-commit",
    ...overrides,
  };
}

function createGitRepo(overrides: Partial<BackupGitRepo> = {}): BackupGitRepo {
  return {
    validate: () => Promise.resolve({ credential: "ssh", empty: false }),
    prepare: () => Promise.resolve(createRepository()),
    getPushChanges: () => Promise.resolve([]),
    commitAndPush: () =>
      Promise.resolve({ commit: "pushed-commit", changed: true, credential: "gh" as const }),
    ...overrides,
  };
}

function createPayload(overrides: Partial<BackupPayload> = {}): BackupPayload {
  return {
    exportTo: () => Promise.resolve({ redactions: [], secretFiles: [] }),
    previewRestore: () =>
      Promise.resolve({ changes: [], localOnlyFiles: [], commandApprovals: [] }),
    validateRestore: () => Promise.resolve(),
    writeSafetySnapshot: () => Promise.resolve(),
    restore: () => Promise.resolve({ changedFiles: [], localOnlyFiles: [] }),
    ...overrides,
  };
}

describe("BackupService", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-backup-service-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("creates a safety snapshot before restoring and records the restored commit", async () => {
    const events: string[] = [];
    const service = new BackupService(createTestConfig(tempDir), {
      gitRepo: createGitRepo(),
      payload: createPayload({
        validateRestore: () => {
          events.push("validate");
          return Promise.resolve();
        },
        writeSafetySnapshot: async (snapshotRoot) => {
          events.push("snapshot");
          await fs.writeFile(path.join(snapshotRoot, "AGENTS.md"), "before restore", "utf8");
        },
        restore: () => {
          events.push("restore");
          return Promise.resolve({
            changedFiles: ["AGENTS.md"],
            localOnlyFiles: ["skills/local/SKILL.md"],
          });
        },
      }),
    });

    const result = await service.restore(SETTINGS);

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(result.error.message);
    }
    expect(result.data.commit).toBe("remote-commit");
    expect(
      result.data.snapshotPath.startsWith(path.join(tempDir, "backup-cache", "restore-"))
    ).toBe(true);
    expect(result.data.changedFiles).toEqual(["AGENTS.md"]);
    expect(result.data.localOnlyFiles).toEqual(["skills/local/SKILL.md"]);
    expect(events).toEqual(["validate", "snapshot", "restore"]);
    expect(await fs.readFile(path.join(result.data.snapshotPath, "AGENTS.md"), "utf8")).toBe(
      "before restore"
    );
    expect(service.getSettings()?.lastRestoredCommit).toBe("remote-commit");
  });

  test("computes restore preview before materializing the local export", async () => {
    const events: string[] = [];
    const service = new BackupService(createTestConfig(tempDir), {
      gitRepo: createGitRepo({
        getPushChanges: () => {
          events.push("push-preview");
          return Promise.resolve([{ path: "AGENTS.md", status: "M" }]);
        },
      }),
      payload: createPayload({
        previewRestore: () => {
          events.push("restore-preview");
          return Promise.resolve({
            changes: [{ path: "preferences.json", status: "M" }],
            localOnlyFiles: [],
            commandApprovals: [],
          });
        },
        exportTo: () => {
          events.push("export");
          return Promise.resolve({ redactions: [], secretFiles: [] });
        },
      }),
    });

    const result = await service.preview(SETTINGS);

    expect(result.success).toBe(true);
    expect(events).toEqual(["restore-preview", "export", "push-preview"]);
  });

  test("returns repository drift as expected Result data without updating settings", async () => {
    const service = new BackupService(createTestConfig(tempDir), {
      gitRepo: createGitRepo({
        commitAndPush: () => {
          throw new BackupServiceError(
            "REPOSITORY_CHANGED",
            "The backup changed since you last read it"
          );
        },
      }),
      payload: createPayload(),
    });

    const result = await service.push(SETTINGS);

    expect(result).toEqual({
      success: false,
      error: {
        code: "REPOSITORY_CHANGED",
        message: "The backup changed since you last read it",
        files: undefined,
      },
    });
    expect(service.getSettings()).toBeNull();
  });

  test("blocks a push when the payload secret scan reports files", async () => {
    let commitAttempted = false;
    const service = new BackupService(createTestConfig(tempDir), {
      gitRepo: createGitRepo({
        commitAndPush: () => {
          commitAttempted = true;
          return Promise.resolve({
            commit: "unexpected",
            changed: true,
            credential: "gh" as const,
          });
        },
      }),
      payload: createPayload({
        exportTo: () =>
          Promise.resolve({
            redactions: [],
            secretFiles: ["skills/private/SKILL.md"],
          }),
      }),
    });

    const result = await service.push(SETTINGS);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected secret detection to block the push");
    expect(result.error.code).toBe("SECRET_DETECTED");
    expect(result.error.files).toEqual(["skills/private/SKILL.md"]);
    expect(commitAttempted).toBe(false);
  });

  test("maps a real non-fast-forward failure to repository drift", async () => {
    const service = new BackupService(createTestConfig(tempDir), {
      gitRepo: createGitRepo({
        commitAndPush: () => Promise.reject(new BackupNonFastForwardError()),
      }),
      payload: createPayload(),
    });

    const result = await service.push(SETTINGS);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected the drifted remote to block the push");
    expect(result.error.code).toBe("REPOSITORY_CHANGED");
    expect(result.error.message).toBe("The backup changed since you last read it");
  });

  test("surfaces an unreachable remote to the client as REMOTE_UNREACHABLE", async () => {
    // The ladder throws this, but only `toOperationError` decides what a client sees, and
    // its fallback is IO_ERROR, which cannot be told apart from a local disk failure.
    const service = new BackupService(createTestConfig(tempDir), {
      gitRepo: createGitRepo({
        validate: () => Promise.reject(new BackupRemoteUnreachableError(new Error("no dns"))),
      }),
      payload: createPayload(),
    });

    const result = await service.validate(SETTINGS);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected the unreachable remote to fail validation");
    expect(result.error.code).toBe("REMOTE_UNREACHABLE");
  });

  test("rejects a managed path that targets the git directory", async () => {
    const service = new BackupService(createTestConfig(tempDir), {
      gitRepo: createGitRepo(),
      payload: createPayload(),
    });

    const result = await service.saveSettings({ ...SETTINGS, path: ".git" });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected the .git path to be rejected");
    expect(result.error.code).toBe("INVALID_BACKUP");
  });

  test("serializes operations for the same repository", async () => {
    const firstCanFinish = Promise.withResolvers<void>();
    const starts: string[] = [];
    let prepareCount = 0;
    const service = new BackupService(createTestConfig(tempDir), {
      gitRepo: createGitRepo({
        prepare: async () => {
          prepareCount += 1;
          starts.push(`prepare-${prepareCount}`);
          if (prepareCount === 1) {
            await firstCanFinish.promise;
          }
          return createRepository();
        },
      }),
      payload: createPayload(),
    });

    const first = service.preview(SETTINGS);
    await Promise.resolve();
    const second = service.preview(SETTINGS);
    await Promise.resolve();

    expect(starts).toEqual(["prepare-1"]);
    firstCanFinish.resolve();
    await Promise.all([first, second]);
    expect(starts).toEqual(["prepare-1", "prepare-2"]);
  });

  test("preserves commit metadata when saving the same repository settings", async () => {
    const service = new BackupService(createTestConfig(tempDir), {
      gitRepo: createGitRepo(),
      payload: createPayload(),
    });

    const pushed = await service.push(SETTINGS);
    expect(pushed.success).toBe(true);

    const saved = await service.saveSettings(SETTINGS);

    expect(saved).toEqual({
      success: true,
      data: {
        ...SETTINGS,
        lastPushedCommit: "pushed-commit",
        lastRestoredCommit: undefined,
      },
    });
  });
});

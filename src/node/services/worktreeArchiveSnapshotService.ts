import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { Err, Ok, type Result } from "@/common/types/result";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { getSrcBaseDir, isWorktreeRuntime } from "@/common/types/runtime";
import { getErrorMessage } from "@/common/utils/errors";
import type {
  WorktreeArchiveSnapshot,
  WorktreeArchiveSnapshotProject,
} from "@/common/schemas/project";
import type { Config } from "@/node/config";
import { detectDefaultTrunkBranch } from "@/node/git";
import { ContainerManager } from "@/node/multiProject/containerManager";
import { isGitRepository } from "@/node/utils/pathUtils";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import type { InitLogger } from "@/node/runtime/Runtime";
import { coerceNonEmptyString, findWorkspaceEntry } from "@/node/services/taskUtils";
import { getWorkspaceProjectRepos } from "@/node/services/workspaceProjectRepos";
import { log } from "@/node/services/log";
import { execFileAsync } from "@/node/utils/disposableExec";
import { GIT_NO_HOOKS_ENV } from "@/node/utils/gitNoHooksEnv";
import { isPathInsideDir } from "@/node/utils/pathUtils";

const SNAPSHOT_VERSION = 1;
const SNAPSHOT_DIR_NAME = "archive-state";
const SNAPSHOT_METADATA_FILE_NAME = "metadata.json";
const NOOP_INIT_LOGGER: InitLogger = {
  logStep: () => undefined,
  logStdout: () => undefined,
  logStderr: () => undefined,
  logComplete: () => undefined,
  enterHookPhase: () => undefined,
};

interface CreatedRestoreWorkspace {
  projectPath: string;
  projectName: string;
  workspacePath: string;
}

function getPersistedWorkspaceName(workspace: { name?: string; path: string }): string | undefined {
  const explicitName = coerceNonEmptyString(workspace.name);
  if (explicitName) {
    return explicitName;
  }

  const pathBasename = path.basename(workspace.path.trim());
  return pathBasename.length > 0 ? pathBasename : undefined;
}

function findWorkspaceEntryByIdOrPath(
  config: Config,
  configSnapshot: ReturnType<Config["loadConfigOrDefault"]>,
  workspaceId: string
): ReturnType<typeof findWorkspaceEntry> {
  const directMatch = findWorkspaceEntry(configSnapshot, workspaceId);
  if (directMatch) {
    return directMatch;
  }

  const locatedWorkspace = config.findWorkspace(workspaceId);
  if (!locatedWorkspace) {
    return null;
  }

  const projectConfig = configSnapshot.projects.get(locatedWorkspace.projectPath);
  const workspace = projectConfig?.workspaces.find(
    (entry) => entry.path === locatedWorkspace.workspacePath
  );
  if (!workspace) {
    return null;
  }

  return {
    projectPath: locatedWorkspace.projectPath,
    workspace,
  };
}

export class WorktreeArchiveSnapshotService {
  constructor(private readonly config: Config) {}

  async preflightSnapshotForArchive(args: {
    workspaceId: string;
    workspaceMetadata: WorkspaceMetadata;
  }): Promise<Result<void>> {
    assert(
      args.workspaceId.trim().length > 0,
      "preflightSnapshotForArchive: workspaceId must be non-empty"
    );

    if (!isWorktreeRuntime(args.workspaceMetadata.runtimeConfig)) {
      return Err("Archive snapshots are only supported for worktree runtimes");
    }

    const configSnapshot = this.config.loadConfigOrDefault();
    const workspaceEntry = findWorkspaceEntryByIdOrPath(
      this.config,
      configSnapshot,
      args.workspaceId
    );
    if (!workspaceEntry) {
      return Err("Workspace not found in config");
    }

    const workspaceName = getPersistedWorkspaceName(workspaceEntry.workspace);
    if (!workspaceName) {
      return Err("Workspace is missing its persisted branch name");
    }

    const projectRepos = getWorkspaceProjectRepos({
      workspaceId: args.workspaceId,
      workspaceName,
      workspacePath: workspaceEntry.workspace.path,
      runtimeConfig: args.workspaceMetadata.runtimeConfig,
      projectPath: args.workspaceMetadata.projectPath,
      projectName: args.workspaceMetadata.projectName,
      projects: workspaceEntry.workspace.projects,
    });
    assert(
      projectRepos.length > 0,
      "preflightSnapshotForArchive: expected at least one project repo"
    );

    try {
      for (const projectRepo of projectRepos) {
        await this.ensureNoUnsupportedUntrackedFiles(projectRepo.repoCwd);
        await this.ensureNoDirtySubmodules(projectRepo.repoCwd);
      }
      return Ok(undefined);
    } catch (error) {
      return Err(`Failed to capture archive snapshot: ${getErrorMessage(error)}`);
    }
  }

  async captureSnapshotForArchive(args: {
    workspaceId: string;
    workspaceMetadata: WorkspaceMetadata;
  }): Promise<Result<WorktreeArchiveSnapshot>> {
    assert(
      args.workspaceId.trim().length > 0,
      "captureSnapshotForArchive: workspaceId must be non-empty"
    );

    if (!isWorktreeRuntime(args.workspaceMetadata.runtimeConfig)) {
      return Err("Archive snapshots are only supported for worktree runtimes");
    }

    const configSnapshot = this.config.loadConfigOrDefault();
    const workspaceEntry = findWorkspaceEntryByIdOrPath(
      this.config,
      configSnapshot,
      args.workspaceId
    );
    if (!workspaceEntry) {
      return Err("Workspace not found in config");
    }

    const workspaceName = getPersistedWorkspaceName(workspaceEntry.workspace);
    if (!workspaceName) {
      return Err("Workspace is missing its persisted branch name");
    }

    const sessionDir = this.config.getSessionDir(args.workspaceId);
    const stateDir = path.join(sessionDir, SNAPSHOT_DIR_NAME);
    const tempStateDir = path.join(
      sessionDir,
      `${SNAPSHOT_DIR_NAME}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );

    await fsPromises.mkdir(sessionDir, { recursive: true });
    await fsPromises.rm(tempStateDir, { recursive: true, force: true });
    await fsPromises.mkdir(tempStateDir, { recursive: true });

    try {
      const projectRepos = getWorkspaceProjectRepos({
        workspaceId: args.workspaceId,
        workspaceName,
        workspacePath: workspaceEntry.workspace.path,
        runtimeConfig: args.workspaceMetadata.runtimeConfig,
        projectPath: args.workspaceMetadata.projectPath,
        projectName: args.workspaceMetadata.projectName,
        projects: workspaceEntry.workspace.projects,
      });
      assert(
        projectRepos.length > 0,
        "captureSnapshotForArchive: expected at least one project repo"
      );

      const taskBaseCommitShaByProjectPath = this.buildTaskBaseCommitShaByProjectPath({
        primaryProjectPath: args.workspaceMetadata.projectPath,
        taskBaseCommitSha: workspaceEntry.workspace.taskBaseCommitSha,
        taskBaseCommitShaByProjectPath: workspaceEntry.workspace.taskBaseCommitShaByProjectPath,
      });

      const projectSnapshots: WorktreeArchiveSnapshotProject[] = [];
      for (const projectRepo of projectRepos) {
        await this.ensureNoUnsupportedUntrackedFiles(projectRepo.repoCwd);
        await this.ensureNoDirtySubmodules(projectRepo.repoCwd);

        const trunkBranch = await this.resolveTrunkBranch({
          taskTrunkBranch: workspaceEntry.workspace.taskTrunkBranch,
          projectPath: projectRepo.projectPath,
        });
        const headSha = await this.gitStdout(projectRepo.repoCwd, ["rev-parse", "HEAD"]);
        const baseSha =
          taskBaseCommitShaByProjectPath[projectRepo.projectPath] ||
          (await this.gitStdout(projectRepo.repoCwd, ["merge-base", trunkBranch, "HEAD"]));

        const commitCount = Number(
          await this.gitStdout(projectRepo.repoCwd, [
            "rev-list",
            "--count",
            `${baseSha}..${headSha}`,
          ])
        );
        assert(
          Number.isFinite(commitCount) && commitCount >= 0,
          "captureSnapshotForArchive: invalid commit count"
        );

        let committedPatchPath: string | undefined;
        const committedPatch =
          commitCount > 0
            ? await this.runGitCommand(projectRepo.repoCwd, [
                "format-patch",
                "--stdout",
                "--binary",
                `${baseSha}..${headSha}`,
              ])
            : "";
        if (committedPatch.trim().length > 0) {
          committedPatchPath = await this.writeArtifact({
            sessionDir,
            stateDir: tempStateDir,
            fileName: `${projectRepo.storageKey}.series.mbox`,
            contents: committedPatch,
          });
        }

        const stagedPatch = await this.runGitCommand(projectRepo.repoCwd, [
          "diff",
          "--cached",
          "--binary",
        ]);
        const stagedPatchPath =
          stagedPatch.trim().length > 0
            ? await this.writeArtifact({
                sessionDir,
                stateDir: tempStateDir,
                fileName: `${projectRepo.storageKey}.staged.patch`,
                contents: stagedPatch,
              })
            : undefined;

        const unstagedPatch = await this.runGitCommand(projectRepo.repoCwd, ["diff", "--binary"]);
        const unstagedPatchPath =
          unstagedPatch.trim().length > 0
            ? await this.writeArtifact({
                sessionDir,
                stateDir: tempStateDir,
                fileName: `${projectRepo.storageKey}.unstaged.patch`,
                contents: unstagedPatch,
              })
            : undefined;

        projectSnapshots.push({
          projectPath: projectRepo.projectPath,
          projectName: projectRepo.projectName,
          storageKey: projectRepo.storageKey,
          branchName: workspaceName,
          trunkBranch,
          baseSha,
          headSha,
          committedPatchPath,
          stagedPatchPath,
          unstagedPatchPath,
        });
      }

      const snapshot: WorktreeArchiveSnapshot = {
        version: SNAPSHOT_VERSION,
        capturedAt: new Date().toISOString(),
        stateDirPath: SNAPSHOT_DIR_NAME,
        projects: projectSnapshots,
      };

      await fsPromises.writeFile(
        path.join(tempStateDir, SNAPSHOT_METADATA_FILE_NAME),
        JSON.stringify(snapshot, null, 2),
        "utf-8"
      );
      await fsPromises.rm(stateDir, { recursive: true, force: true });
      await fsPromises.rename(tempStateDir, stateDir);

      return Ok(snapshot);
    } catch (error) {
      await fsPromises.rm(tempStateDir, { recursive: true, force: true });
      return Err(`Failed to capture archive snapshot: ${getErrorMessage(error)}`);
    }
  }

  async restoreSnapshotAfterUnarchive(args: {
    workspaceId: string;
    workspaceMetadata: WorkspaceMetadata;
  }): Promise<Result<"restored" | "skipped">> {
    assert(
      args.workspaceId.trim().length > 0,
      "restoreSnapshotAfterUnarchive: workspaceId must be non-empty"
    );

    const configSnapshot = this.config.loadConfigOrDefault();
    const workspaceEntry = findWorkspaceEntryByIdOrPath(
      this.config,
      configSnapshot,
      args.workspaceId
    );
    if (!workspaceEntry) {
      return Err("Workspace not found in config");
    }

    const snapshot = workspaceEntry.workspace.worktreeArchiveSnapshot;
    if (!snapshot) {
      return Ok("skipped");
    }

    if (!isWorktreeRuntime(args.workspaceMetadata.runtimeConfig)) {
      return Err("Archive snapshot restore is only supported for worktree runtimes");
    }

    const persistedWorkspacePath = workspaceEntry.workspace.path;
    const workspaceName = getPersistedWorkspaceName(workspaceEntry.workspace);
    if (!workspaceName) {
      return Err("Workspace is missing its persisted branch name");
    }

    const createdWorkspaces: CreatedRestoreWorkspace[] = [];
    let containerCreated = false;
    let restoredCheckoutReadyForWriteback = false;

    try {
      if (await this.pathExists(persistedWorkspacePath)) {
        const existingProjectSnapshot =
          snapshot.projects.length === 1 ? snapshot.projects[0] : undefined;
        if (
          existingProjectSnapshot &&
          (await this.existingCheckoutMatchesSnapshot({
            workspaceId: args.workspaceId,
            workspacePath: persistedWorkspacePath,
            projectSnapshot: existingProjectSnapshot,
          }))
        ) {
          await this.clearSnapshotState(args.workspaceId, snapshot);
          return Ok("skipped");
        }

        throw new Error(
          "Persisted workspace path already exists; snapshot restore will not discard saved recovery data until the checkout is reconciled manually."
        );
      }
      for (const projectSnapshot of snapshot.projects) {
        const branchRefSha = await this.tryGitStdout(projectSnapshot.projectPath, [
          "rev-parse",
          `refs/heads/${projectSnapshot.branchName}`,
        ]);
        if (branchRefSha && branchRefSha !== projectSnapshot.headSha) {
          throw new Error(
            `Refusing to restore ${projectSnapshot.projectName}: local branch ${projectSnapshot.branchName} no longer matches the archived snapshot.`
          );
        }

        const headShaAvailable = await this.gitCommitExists(
          projectSnapshot.projectPath,
          projectSnapshot.headSha
        );
        const startPoint = branchRefSha
          ? undefined
          : headShaAvailable
            ? projectSnapshot.headSha
            : projectSnapshot.baseSha;

        const trusted = configSnapshot.projects.get(projectSnapshot.projectPath)?.trusted === true;
        const runtime = createRuntime(args.workspaceMetadata.runtimeConfig, {
          projectPath: projectSnapshot.projectPath,
          workspaceName,
        });
        const restoreResult = await runtime.createWorkspace({
          projectPath: projectSnapshot.projectPath,
          branchName: projectSnapshot.branchName,
          trunkBranch: projectSnapshot.trunkBranch,
          directoryName: workspaceName,
          startPoint,
          skipRemoteSync: true,
          workspacePathOverride:
            snapshot.projects.length === 1 ? persistedWorkspacePath : undefined,
          initLogger: NOOP_INIT_LOGGER,
          trusted,
        });
        if (!restoreResult.success || !restoreResult.workspacePath) {
          throw new Error(
            `Failed to recreate ${projectSnapshot.projectName}: ${
              restoreResult.error ?? "runtime did not return a workspace path"
            }`
          );
        }

        createdWorkspaces.push({
          projectPath: projectSnapshot.projectPath,
          projectName: projectSnapshot.projectName,
          workspacePath: restoreResult.workspacePath,
        });

        if (!headShaAvailable) {
          const committedPatchPath = projectSnapshot.committedPatchPath
            ? this.resolveSessionRelativePath(
                this.config.getSessionDir(args.workspaceId),
                projectSnapshot.committedPatchPath
              )
            : undefined;
          const committedPatchAvailable =
            committedPatchPath !== undefined && (await this.pathExists(committedPatchPath));
          const committedHistoryWasCaptured = projectSnapshot.baseSha !== projectSnapshot.headSha;
          if (committedHistoryWasCaptured && !committedPatchAvailable) {
            throw new Error(
              `Failed to restore ${projectSnapshot.projectName}: archived committed history is unavailable.`
            );
          }
          if (committedPatchAvailable && committedPatchPath) {
            await this.runGitCommand(restoreResult.workspacePath, [
              "am",
              "--3way",
              committedPatchPath,
            ]);
          }
        }

        if (projectSnapshot.stagedPatchPath) {
          const stagedPatchPath = this.resolveSessionRelativePath(
            this.config.getSessionDir(args.workspaceId),
            projectSnapshot.stagedPatchPath
          );
          if (!(await this.pathExists(stagedPatchPath))) {
            throw new Error(
              `Failed to restore ${projectSnapshot.projectName}: staged patch artifact is unavailable.`
            );
          }
          await this.runGitCommand(restoreResult.workspacePath, [
            "apply",
            "--index",
            "--binary",
            stagedPatchPath,
          ]);
        }

        if (projectSnapshot.unstagedPatchPath) {
          const unstagedPatchPath = this.resolveSessionRelativePath(
            this.config.getSessionDir(args.workspaceId),
            projectSnapshot.unstagedPatchPath
          );
          if (!(await this.pathExists(unstagedPatchPath))) {
            throw new Error(
              `Failed to restore ${projectSnapshot.projectName}: unstaged patch artifact is unavailable.`
            );
          }
          await this.runGitCommand(restoreResult.workspacePath, [
            "apply",
            "--binary",
            unstagedPatchPath,
          ]);
        }
      }

      if (snapshot.projects.length > 1) {
        const srcBaseDir =
          getSrcBaseDir(args.workspaceMetadata.runtimeConfig) ?? this.config.srcDir;
        const containerManager = new ContainerManager(srcBaseDir);
        await containerManager.createContainer(
          workspaceName,
          createdWorkspaces.map((workspace) => ({
            projectName: workspace.projectName,
            workspacePath: workspace.workspacePath,
          }))
        );
        containerCreated = true;
      }

      restoredCheckoutReadyForWriteback = true;
      await this.clearSnapshotState(args.workspaceId, snapshot);
      return Ok("restored");
    } catch (error) {
      log.debug("Failed to restore worktree archive snapshot", {
        workspaceId: args.workspaceId,
        error: getErrorMessage(error),
      });
      if (!restoredCheckoutReadyForWriteback) {
        await this.cleanupFailedRestore({
          workspaceName,
          runtimeConfig: args.workspaceMetadata.runtimeConfig,
          createdWorkspaces,
          containerCreated,
        });
        return Err(`Failed to restore archive snapshot: ${getErrorMessage(error)}`);
      }

      log.debug("Keeping restored worktree despite snapshot cleanup/writeback failure", {
        workspaceId: args.workspaceId,
        error: getErrorMessage(error),
      });
      return Ok("restored");
    }
  }

  private buildTaskBaseCommitShaByProjectPath(args: {
    primaryProjectPath: string;
    taskBaseCommitSha?: string;
    taskBaseCommitShaByProjectPath?: Record<string, string>;
  }): Record<string, string> {
    const baseCommitShaByProjectPath: Record<string, string> = {};
    for (const [projectPath, value] of Object.entries(args.taskBaseCommitShaByProjectPath ?? {})) {
      const sha = value.trim();
      if (sha.length > 0) {
        baseCommitShaByProjectPath[projectPath] = sha;
      }
    }

    const primaryBaseSha = args.taskBaseCommitSha?.trim();
    if (primaryBaseSha) {
      baseCommitShaByProjectPath[args.primaryProjectPath] = primaryBaseSha;
    }

    return baseCommitShaByProjectPath;
  }

  private async resolveTrunkBranch(args: {
    taskTrunkBranch?: string;
    projectPath: string;
  }): Promise<string> {
    const configuredTrunkBranch = args.taskTrunkBranch?.trim();
    if (configuredTrunkBranch) {
      return configuredTrunkBranch;
    }

    return detectDefaultTrunkBranch(args.projectPath);
  }

  private async ensureNoUnsupportedUntrackedFiles(repoCwd: string): Promise<void> {
    const untrackedOutput = await this.gitStdout(repoCwd, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "--directory",
    ]);
    const untrackedPaths = untrackedOutput
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (untrackedPaths.length > 0) {
      throw new Error(
        `Archive snapshot does not yet support untracked files: ${untrackedPaths.join(", ")}`
      );
    }
  }

  private async ensureNoDirtySubmodules(repoCwd: string): Promise<void> {
    const submoduleStatus = await this.tryGitStdout(repoCwd, [
      "submodule",
      "status",
      "--recursive",
    ]);
    if (!submoduleStatus) {
      return;
    }

    const submodulePaths = submoduleStatus
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.split(/\s+/)[1])
      .filter((submodulePath): submodulePath is string => typeof submodulePath === "string");

    for (const submodulePath of submodulePaths) {
      const absoluteSubmodulePath = path.join(repoCwd, submodulePath);
      const dirtyOutput = await this.tryGitStdout(absoluteSubmodulePath, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ]);
      if (dirtyOutput && dirtyOutput.trim().length > 0) {
        throw new Error(`Archive snapshot does not support dirty submodules yet: ${submodulePath}`);
      }
    }
  }

  private async gitCommitExists(repoPath: string, sha: string): Promise<boolean> {
    return (await this.tryGitStdout(repoPath, ["cat-file", "-e", `${sha}^{commit}`])) !== undefined;
  }

  private async gitStdout(repoPath: string, args: string[]): Promise<string> {
    const trimmed = (await this.runGitCommand(repoPath, args)).trimEnd();
    return trimmed;
  }

  private async tryGitStdout(repoPath: string, args: string[]): Promise<string | undefined> {
    try {
      return await this.gitStdout(repoPath, args);
    } catch {
      return undefined;
    }
  }

  private async runGitCommand(repoPath: string, args: string[]): Promise<string> {
    const gitEnv =
      args[0] === "am"
        ? {
            ...GIT_NO_HOOKS_ENV,
            GIT_COMMITTER_NAME: "Mux Archive Restore",
            GIT_COMMITTER_EMAIL: "mux-archive-restore@local",
          }
        : GIT_NO_HOOKS_ENV;
    using proc = execFileAsync("git", ["-C", repoPath, ...args], { env: gitEnv });
    const { stdout } = await proc.result;
    return stdout;
  }

  private resolveSessionRelativePath(sessionDir: string, relativePath: string): string {
    assert(
      relativePath.trim().length > 0,
      "resolveSessionRelativePath: relativePath must be non-empty"
    );
    const absolutePath = path.resolve(sessionDir, relativePath);
    const isStrictChildPath =
      isPathInsideDir(sessionDir, absolutePath) && absolutePath !== sessionDir;
    assert(isStrictChildPath, `resolveSessionRelativePath: refusing to escape ${sessionDir}`);
    return absolutePath;
  }

  private async writeArtifact(args: {
    sessionDir: string;
    stateDir: string;
    fileName: string;
    contents: string;
  }): Promise<string> {
    const artifactPath = path.join(args.stateDir, args.fileName);
    await fsPromises.writeFile(artifactPath, args.contents, "utf-8");

    assert(
      isPathInsideDir(args.sessionDir, artifactPath),
      `writeArtifact: artifact path escaped session dir (${artifactPath})`
    );

    const relativePath = path.join(SNAPSHOT_DIR_NAME, args.fileName);
    assert(!path.isAbsolute(relativePath), "writeArtifact: relativePath must stay relative");
    return relativePath;
  }

  private async clearSnapshotState(
    workspaceId: string,
    snapshot: WorktreeArchiveSnapshot
  ): Promise<void> {
    const sessionDir = this.config.getSessionDir(workspaceId);
    const stateDir = this.resolveSessionRelativePath(sessionDir, snapshot.stateDirPath);
    await fsPromises.rm(stateDir, { recursive: true, force: true });

    await this.config.editConfig((config) => {
      const workspaceEntry = findWorkspaceEntryByIdOrPath(this.config, config, workspaceId);
      if (workspaceEntry) {
        delete workspaceEntry.workspace.worktreeArchiveSnapshot;
      }
      return config;
    });
  }

  private async cleanupFailedRestore(args: {
    workspaceName: string;
    runtimeConfig: WorkspaceMetadata["runtimeConfig"];
    createdWorkspaces: CreatedRestoreWorkspace[];
    containerCreated: boolean;
  }): Promise<void> {
    if (args.containerCreated) {
      const srcBaseDir = getSrcBaseDir(args.runtimeConfig) ?? this.config.srcDir;
      await new ContainerManager(srcBaseDir)
        .removeContainer(args.workspaceName)
        .catch(() => undefined);
    }

    for (const createdWorkspace of [...args.createdWorkspaces].reverse()) {
      try {
        await this.removeRestoredWorktreePath(
          createdWorkspace.projectPath,
          createdWorkspace.workspacePath
        );
      } catch (error) {
        log.debug("Failed to clean up partially restored worktree snapshot", {
          projectPath: createdWorkspace.projectPath,
          workspacePath: createdWorkspace.workspacePath,
          error: getErrorMessage(error),
        });
      }
    }
  }

  private async existingCheckoutMatchesSnapshot(args: {
    workspaceId: string;
    workspacePath: string;
    projectSnapshot: WorktreeArchiveSnapshotProject;
  }): Promise<boolean> {
    const checkoutIsGitRepo = await isGitRepository(args.workspacePath);
    if (!checkoutIsGitRepo) {
      return false;
    }

    const checkoutBranch = await this.tryGitStdout(args.workspacePath, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    if (checkoutBranch !== args.projectSnapshot.branchName) {
      return false;
    }

    const checkoutHeadSha = await this.tryGitStdout(args.workspacePath, ["rev-parse", "HEAD"]);
    if (checkoutHeadSha !== args.projectSnapshot.headSha) {
      return false;
    }

    const checkoutCommonDir = await this.tryGitStdout(args.workspacePath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const expectedCommonDir = path.resolve(args.projectSnapshot.projectPath, ".git");
    if (!checkoutCommonDir || path.resolve(checkoutCommonDir) !== expectedCommonDir) {
      return false;
    }

    const expectedStagedPatch = args.projectSnapshot.stagedPatchPath
      ? await fsPromises.readFile(
          this.resolveSessionRelativePath(
            this.config.getSessionDir(args.workspaceId),
            args.projectSnapshot.stagedPatchPath
          ),
          "utf-8"
        )
      : "";
    const expectedUnstagedPatch = args.projectSnapshot.unstagedPatchPath
      ? await fsPromises.readFile(
          this.resolveSessionRelativePath(
            this.config.getSessionDir(args.workspaceId),
            args.projectSnapshot.unstagedPatchPath
          ),
          "utf-8"
        )
      : "";

    const currentStagedPatch = await this.runGitCommand(args.workspacePath, [
      "diff",
      "--cached",
      "--binary",
    ]);
    const currentUnstagedPatch = await this.runGitCommand(args.workspacePath, ["diff", "--binary"]);

    return (
      currentStagedPatch === expectedStagedPatch && currentUnstagedPatch === expectedUnstagedPatch
    );
  }

  private async removeRestoredWorktreePath(
    projectPath: string,
    workspacePath: string
  ): Promise<void> {
    try {
      using removeProc = execFileAsync(
        "git",
        ["-C", projectPath, "worktree", "remove", "--force", workspacePath],
        { env: GIT_NO_HOOKS_ENV }
      );
      await removeProc.result;
      return;
    } catch {
      try {
        using pruneProc = execFileAsync("git", ["-C", projectPath, "worktree", "prune"], {
          env: GIT_NO_HOOKS_ENV,
        });
        await pruneProc.result;
      } catch {
        // Best-effort prune only; fall through to filesystem cleanup.
      }
    }

    await fsPromises.rm(workspacePath, { recursive: true, force: true });
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    return fsPromises
      .access(targetPath)
      .then(() => true)
      .catch(() => false);
  }
}

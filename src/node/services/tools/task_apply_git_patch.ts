import assert from "node:assert/strict";
import * as fsPromises from "fs/promises";
import * as path from "node:path";

import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  TaskApplyGitPatchToolResultSchema,
  TOOL_DEFINITIONS,
} from "@/common/utils/tools/toolDefinitions";
import { shellQuote } from "@/common/utils/shell";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { gitNoHooksPrefix } from "@/node/utils/gitNoHooksEnv";
import {
  getSubagentGitPatchMboxPath,
  markSubagentGitPatchArtifactApplied,
  readSubagentGitPatchArtifact,
} from "@/node/services/subagentGitPatchArtifacts";
import { log } from "@/node/services/log";
import { Config } from "@/node/config";
import { coerceNonEmptyString, findWorkspaceEntry } from "@/node/services/taskUtils";
import { getWorkspaceProjectRepos } from "@/node/services/workspaceProjectRepos";

import { parseToolResult, requireWorkspaceId } from "./toolUtils";

interface AppliedCommit {
  subject: string;
  sha?: string;
}

interface TaskApplyGitPatchProjectResult {
  projectPath: string;
  projectName: string;
  status: "applied" | "failed" | "skipped";
  appliedCommits?: AppliedCommit[];
  headCommitSha?: string;
  error?: string;
  failedPatchSubject?: string;
  conflictPaths?: string[];
  note?: string;
}

async function copyLocalFileToRuntime(params: {
  runtime: ToolConfiguration["runtime"];
  localPath: string;
  remotePath: string;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const writable = params.runtime.writeFile(params.remotePath, params.abortSignal);
  const writer = writable.getWriter();

  const fileHandle = await fsPromises.open(params.localPath, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    while (true) {
      const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      await writer.write(buffer.subarray(0, bytesRead));
    }

    await writer.close();
  } catch (error) {
    writer.releaseLock();
    throw error;
  } finally {
    await fileHandle.close();
  }
}

function mergeNotes(...notes: Array<string | undefined>): string | undefined {
  const parts = notes
    .map((note) => (typeof note === "string" ? note.trim() : ""))
    .filter((note) => note.length > 0);

  return parts.length > 0 ? parts.join("\n") : undefined;
}

function isPathInsideDir(dirPath: string, filePath: string): boolean {
  const resolvedDir = path.resolve(dirPath);
  const resolvedFile = path.resolve(filePath);
  const relative = path.relative(resolvedDir, resolvedFile);

  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function tryRevParseHead(params: {
  runtime: ToolConfiguration["runtime"];
  cwd: string;
}): Promise<string | undefined> {
  try {
    const headResult = await execBuffered(params.runtime, "git rev-parse HEAD", {
      cwd: params.cwd,
      timeout: 10,
    });
    if (headResult.exitCode !== 0) {
      return undefined;
    }
    const sha = headResult.stdout.trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}

async function getAppliedCommits(params: {
  runtime: ToolConfiguration["runtime"];
  cwd: string;
  beforeHeadSha: string | undefined;
  commitCountHint: number | undefined;
  includeSha: boolean;
}): Promise<AppliedCommit[]> {
  const format = "%H%x00%s";

  async function tryGitLog(args: {
    cmd: string;
    includeSha: boolean;
  }): Promise<AppliedCommit[] | undefined> {
    try {
      const result = await execBuffered(params.runtime, args.cmd, {
        cwd: params.cwd,
        timeout: 30,
      });
      if (result.exitCode !== 0) {
        log.debug("task_apply_git_patch: git log failed", {
          cwd: params.cwd,
          exitCode: result.exitCode,
          stderr: result.stderr.trim(),
          stdout: result.stdout.trim(),
        });
        return undefined;
      }

      const lines = result.stdout
        .split("\n")
        .map((line) => line.replace(/\r$/, ""))
        .filter((line) => line.length > 0);

      const commits: AppliedCommit[] = [];
      for (const line of lines) {
        const nulIndex = line.indexOf("\u0000");
        if (nulIndex === -1) {
          commits.push({ subject: line });
          continue;
        }

        const sha = line.slice(0, nulIndex);
        const subject = line.slice(nulIndex + 1);
        if (subject.length === 0) continue;

        if (args.includeSha && sha.length > 0) {
          commits.push({ sha, subject });
        } else {
          commits.push({ subject });
        }
      }

      return commits;
    } catch (error) {
      log.debug("task_apply_git_patch: git log threw", { cwd: params.cwd, error });
      return undefined;
    }
  }

  if (params.beforeHeadSha) {
    const rangeCmd = `git log --reverse --format=${format} ${params.beforeHeadSha}..HEAD`;
    const commits = await tryGitLog({ cmd: rangeCmd, includeSha: params.includeSha });
    if (commits) return commits;
  }

  if (typeof params.commitCountHint === "number" && params.commitCountHint > 0) {
    const countCmd = `git log -n ${params.commitCountHint} --reverse --format=${format} HEAD`;
    const commits = await tryGitLog({ cmd: countCmd, includeSha: params.includeSha });
    if (commits) return commits;
  }

  return [];
}

const MAX_PARENT_WORKSPACE_DEPTH = 32;

function inferMuxRootFromWorkspaceSessionDir(workspaceSessionDir: string): string | undefined {
  assert(
    workspaceSessionDir.length > 0,
    "inferMuxRootFromWorkspaceSessionDir: workspaceSessionDir must be non-empty"
  );

  const sessionsDir = path.dirname(workspaceSessionDir);
  if (path.basename(sessionsDir) !== "sessions") {
    return undefined;
  }

  return path.dirname(sessionsDir);
}

function parseFailedPatchSubjectFromGitAmOutput(output: string): string | undefined {
  const normalized = output.replace(/\r/g, "");

  const patchFailedMatch = /^Patch failed at \d+ (.+)$/m.exec(normalized);
  if (patchFailedMatch) {
    const subject = patchFailedMatch[1].trim();
    return subject.length > 0 ? subject : undefined;
  }

  const applyingMatches = Array.from(normalized.matchAll(/^Applying: (.+)$/gm));
  const subject = applyingMatches.at(-1)?.[1]?.trim();
  return subject && subject.length > 0 ? subject : undefined;
}

async function tryGetConflictPaths(params: {
  runtime: ToolConfiguration["runtime"];
  cwd: string;
}): Promise<string[]> {
  assert(params.cwd.length > 0, "tryGetConflictPaths: cwd must be non-empty");

  try {
    const diffResult = await execBuffered(params.runtime, "git diff --name-only --diff-filter=U", {
      cwd: params.cwd,
      timeout: 30,
    });

    if (diffResult.exitCode !== 0) {
      log.debug("task_apply_git_patch: git diff --name-only --diff-filter=U failed", {
        cwd: params.cwd,
        exitCode: diffResult.exitCode,
        stderr: diffResult.stderr.trim(),
        stdout: diffResult.stdout.trim(),
      });
      return [];
    }

    const paths = diffResult.stdout
      .split("\n")
      .map((line) => line.replace(/\r$/, "").trim())
      .filter((line) => line.length > 0);

    return Array.from(new Set(paths));
  } catch (error) {
    log.debug("task_apply_git_patch: git diff --name-only --diff-filter=U threw", {
      cwd: params.cwd,
      error,
    });
    return [];
  }
}

async function isGitAmInProgress(params: {
  runtime: ToolConfiguration["runtime"];
  cwd: string;
}): Promise<boolean> {
  assert(params.cwd.length > 0, "isGitAmInProgress: cwd must be non-empty");

  try {
    const checkResult = await execBuffered(
      params.runtime,
      'test -d "$(git rev-parse --git-path rebase-apply)"',
      {
        cwd: params.cwd,
        timeout: 30,
      }
    );

    return checkResult.exitCode === 0;
  } catch (error) {
    log.debug("task_apply_git_patch: failed to detect git am progress state", {
      cwd: params.cwd,
      error,
    });
    return false;
  }
}

async function findGitPatchArtifactInWorkspaceOrAncestors(params: {
  workspaceId: string;
  workspaceSessionDir: string;
  childTaskId: string;
}): Promise<{
  artifact: NonNullable<Awaited<ReturnType<typeof readSubagentGitPatchArtifact>>>;
  artifactWorkspaceId: string;
  artifactSessionDir: string;
  note?: string;
} | null> {
  assert(
    params.workspaceId.length > 0,
    "findGitPatchArtifactInWorkspaceOrAncestors: workspaceId must be non-empty"
  );
  assert(
    params.workspaceSessionDir.length > 0,
    "findGitPatchArtifactInWorkspaceOrAncestors: workspaceSessionDir must be non-empty"
  );
  assert(
    params.childTaskId.length > 0,
    "findGitPatchArtifactInWorkspaceOrAncestors: childTaskId must be non-empty"
  );

  const direct = await readSubagentGitPatchArtifact(params.workspaceSessionDir, params.childTaskId);
  if (direct) {
    return {
      artifact: direct,
      artifactWorkspaceId: params.workspaceId,
      artifactSessionDir: params.workspaceSessionDir,
    };
  }

  const muxRootDir = inferMuxRootFromWorkspaceSessionDir(params.workspaceSessionDir);
  if (!muxRootDir) {
    log.debug(
      "task_apply_git_patch: workspaceSessionDir not under sessions/; skipping ancestor lookup",
      {
        workspaceId: params.workspaceId,
        workspaceSessionDir: params.workspaceSessionDir,
        childTaskId: params.childTaskId,
      }
    );
    return null;
  }

  const configService = new Config(muxRootDir);

  let cfg: ReturnType<Config["loadConfigOrDefault"]>;
  try {
    cfg = configService.loadConfigOrDefault();
  } catch (error) {
    log.debug("task_apply_git_patch: failed to load mux config for ancestor lookup", {
      workspaceId: params.workspaceId,
      muxRootDir,
      error,
    });
    return null;
  }

  const parentById = new Map<string, string | undefined>();
  for (const project of cfg.projects.values()) {
    for (const workspace of project.workspaces) {
      if (!workspace.id) continue;
      parentById.set(workspace.id, workspace.parentWorkspaceId);
    }
  }

  const visited = new Set<string>();
  visited.add(params.workspaceId);

  let current = params.workspaceId;
  for (let i = 0; i < MAX_PARENT_WORKSPACE_DEPTH; i++) {
    const parent = parentById.get(current);
    if (!parent) {
      return null;
    }

    if (visited.has(parent)) {
      log.warn("task_apply_git_patch: possible parentWorkspaceId cycle during ancestor lookup", {
        workspaceId: params.workspaceId,
        childTaskId: params.childTaskId,
        current,
        parent,
      });
      return null;
    }

    visited.add(parent);

    const parentSessionDir = configService.getSessionDir(parent);
    const artifact = await readSubagentGitPatchArtifact(parentSessionDir, params.childTaskId);
    if (artifact) {
      return {
        artifact,
        artifactWorkspaceId: parent,
        artifactSessionDir: parentSessionDir,
        note: `Patch artifact loaded from ancestor workspace ${parent}.`,
      };
    }

    current = parent;
  }

  log.warn("task_apply_git_patch: exceeded parentWorkspaceId depth during ancestor lookup", {
    workspaceId: params.workspaceId,
    childTaskId: params.childTaskId,
  });

  return null;
}

function toLegacyFields(projectResults: TaskApplyGitPatchProjectResult[]): {
  appliedCommits?: AppliedCommit[];
  headCommitSha?: string;
  conflictPaths?: string[];
  failedPatchSubject?: string;
} {
  if (projectResults.length !== 1) {
    return {};
  }

  const [onlyProjectResult] = projectResults;
  return {
    ...(onlyProjectResult.appliedCommits
      ? { appliedCommits: onlyProjectResult.appliedCommits }
      : {}),
    ...(onlyProjectResult.headCommitSha ? { headCommitSha: onlyProjectResult.headCommitSha } : {}),
    ...(onlyProjectResult.conflictPaths ? { conflictPaths: onlyProjectResult.conflictPaths } : {}),
    ...(onlyProjectResult.failedPatchSubject
      ? { failedPatchSubject: onlyProjectResult.failedPatchSubject }
      : {}),
  };
}

function summarizeNonReadyProjectArtifact(params: {
  projectArtifact: NonNullable<
    Awaited<ReturnType<typeof readSubagentGitPatchArtifact>>
  >["projectArtifacts"][number];
}): TaskApplyGitPatchProjectResult {
  const noteByStatus: Record<string, string | undefined> = {
    pending: "Patch generation is still in progress for this project.",
    skipped: "Patch generation was skipped because this project produced no commits.",
    failed: undefined,
    ready: undefined,
  };

  return {
    projectPath: params.projectArtifact.projectPath,
    projectName: params.projectArtifact.projectName,
    status: params.projectArtifact.status === "failed" ? "failed" : "skipped",
    error:
      params.projectArtifact.error ??
      noteByStatus[params.projectArtifact.status] ??
      `Project patch status is ${params.projectArtifact.status}.`,
  };
}

function resolveCurrentWorkspaceRepoTargets(params: {
  workspaceId: string;
  workspaceSessionDir: string;
}): Map<string, { projectName: string; repoCwd: string }> {
  const muxRootDir = inferMuxRootFromWorkspaceSessionDir(params.workspaceSessionDir);
  if (!muxRootDir) {
    return new Map();
  }

  const configService = new Config(muxRootDir);
  let cfg: ReturnType<Config["loadConfigOrDefault"]>;
  try {
    cfg = configService.loadConfigOrDefault();
  } catch {
    return new Map();
  }

  const entry = findWorkspaceEntry(cfg, params.workspaceId);
  const workspace = entry?.workspace;
  const workspacePath = coerceNonEmptyString(workspace?.path);
  const workspaceName = coerceNonEmptyString(workspace?.name);
  if (!entry || !workspace?.runtimeConfig || !workspacePath || !workspaceName) {
    return new Map();
  }

  const projectRepos = getWorkspaceProjectRepos({
    workspaceId: params.workspaceId,
    workspaceName,
    workspacePath,
    runtimeConfig: workspace.runtimeConfig,
    projectPath: entry.projectPath,
    projectName:
      workspace.projects?.find((project) => project.projectPath === entry.projectPath)
        ?.projectName ??
      entry.projectPath.split("/").filter(Boolean).at(-1) ??
      entry.projectPath,
    projects: workspace.projects,
  });

  return new Map(
    projectRepos.map((projectRepo) => [
      projectRepo.projectPath,
      {
        projectName: projectRepo.projectName,
        repoCwd: projectRepo.repoCwd,
      },
    ])
  );
}

async function resolvePatchPath(params: {
  taskId: string;
  artifactSessionDir: string;
  projectArtifact: NonNullable<
    Awaited<ReturnType<typeof readSubagentGitPatchArtifact>>
  >["projectArtifacts"][number];
  artifactLookupNote?: string;
}): Promise<{ patchPath: string; note?: string } | { error: string; note?: string }> {
  const expectedPatchPath = getSubagentGitPatchMboxPath(
    params.artifactSessionDir,
    params.taskId,
    params.projectArtifact.storageKey
  );

  if (!isPathInsideDir(params.artifactSessionDir, expectedPatchPath)) {
    return {
      error: "Invalid task_id.",
      note: "task_id must not contain path traversal segments.",
    };
  }

  const safeMboxPath =
    typeof params.projectArtifact.mboxPath === "string" &&
    params.projectArtifact.mboxPath.length > 0
      ? isPathInsideDir(params.artifactSessionDir, params.projectArtifact.mboxPath)
        ? params.projectArtifact.mboxPath
        : undefined
      : undefined;

  let patchPathNote = mergeNotes(
    params.artifactLookupNote,
    params.projectArtifact.mboxPath && !safeMboxPath
      ? "Ignoring unsafe mboxPath in patch artifact metadata; using canonical patch location."
      : undefined
  );

  const patchCandidates = [safeMboxPath, expectedPatchPath].filter(
    (candidate): candidate is string => typeof candidate === "string"
  );

  let patchPath: string | null = null;
  for (const candidate of patchCandidates) {
    try {
      const stat = await fsPromises.stat(candidate);
      if (stat.isFile()) {
        patchPath = candidate;
        break;
      }
    } catch {
      // try next candidate
    }
  }

  if (!patchPath) {
    const checkedPaths = Array.from(new Set(patchCandidates))
      .map((candidate) =>
        isPathInsideDir(params.artifactSessionDir, candidate)
          ? path.relative(params.artifactSessionDir, candidate) || path.basename(candidate)
          : candidate
      )
      .join(", ");

    return {
      error: "Patch file is missing on disk.",
      note: mergeNotes(
        patchPathNote,
        checkedPaths.length > 0 ? `Checked patch locations: ${checkedPaths}` : undefined
      ),
    };
  }

  if (safeMboxPath && patchPath === expectedPatchPath && safeMboxPath !== expectedPatchPath) {
    patchPathNote = mergeNotes(
      patchPathNote,
      "Patch file not found at metadata mboxPath; using canonical patch location."
    );
  }

  return { patchPath, note: patchPathNote };
}

async function applyProjectPatch(params: {
  taskId: string;
  workspaceId: string;
  runtime: ToolConfiguration["runtime"];
  runtimeTempDir: string;
  trusted: boolean;
  repoCwd: string;
  projectArtifact: NonNullable<
    Awaited<ReturnType<typeof readSubagentGitPatchArtifact>>
  >["projectArtifacts"][number];
  artifactWorkspaceId: string;
  artifactSessionDir: string;
  artifactLookupNote?: string;
  dryRun: boolean;
  threeWay: boolean;
  force: boolean;
  isReplay: boolean;
  abortSignal?: AbortSignal;
}): Promise<{ success: boolean; projectResult: TaskApplyGitPatchProjectResult }> {
  const patchResolution = await resolvePatchPath({
    taskId: params.taskId,
    artifactSessionDir: params.artifactSessionDir,
    projectArtifact: params.projectArtifact,
    artifactLookupNote: params.artifactLookupNote,
  });
  if ("error" in patchResolution) {
    return {
      success: false,
      projectResult: {
        projectPath: params.projectArtifact.projectPath,
        projectName: params.projectArtifact.projectName,
        status: "failed",
        error: patchResolution.error,
        note: patchResolution.note,
      },
    };
  }

  if (!params.force) {
    const statusResult = await execBuffered(params.runtime, "git status --porcelain", {
      cwd: params.repoCwd,
      timeout: 10,
    });
    if (statusResult.exitCode !== 0) {
      return {
        success: false,
        projectResult: {
          projectPath: params.projectArtifact.projectPath,
          projectName: params.projectArtifact.projectName,
          status: "failed",
          error: statusResult.stderr.trim() || "git status failed",
          note: patchResolution.note,
        },
      };
    }

    if (statusResult.stdout.trim().length > 0) {
      return {
        success: false,
        projectResult: {
          projectPath: params.projectArtifact.projectPath,
          projectName: params.projectArtifact.projectName,
          status: "failed",
          error: "Working tree is not clean.",
          note: mergeNotes(
            patchResolution.note,
            "Commit/stash your changes (or pass force=true) before applying patches."
          ),
        },
      };
    }
  }

  const remotePatchPath = path.posix.join(
    params.runtimeTempDir,
    `mux-task-${params.taskId}-${params.projectArtifact.storageKey}-series.mbox`
  );

  await copyLocalFileToRuntime({
    runtime: params.runtime,
    localPath: patchResolution.patchPath,
    remotePath: remotePatchPath,
    abortSignal: params.abortSignal,
  });

  const flags: string[] = [];
  if (params.threeWay) flags.push("--3way");

  const nhp = gitNoHooksPrefix(params.trusted);

  if (params.dryRun) {
    const dryRunId = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
    const dryRunWorktreePath = path.posix.join(
      params.runtimeTempDir,
      `mux-git-am-dry-run-${params.taskId}-${params.projectArtifact.storageKey}-${dryRunId}`
    );

    const addResult = await execBuffered(
      params.runtime,
      `${nhp}git worktree add --detach ${shellQuote(dryRunWorktreePath)} HEAD`,
      { cwd: params.repoCwd, timeout: 60 }
    );
    if (addResult.exitCode !== 0) {
      return {
        success: false,
        projectResult: {
          projectPath: params.projectArtifact.projectPath,
          projectName: params.projectArtifact.projectName,
          status: "failed",
          error: addResult.stderr.trim() || addResult.stdout.trim() || "git worktree add failed",
        },
      };
    }

    try {
      const beforeHeadSha = await tryRevParseHead({
        runtime: params.runtime,
        cwd: dryRunWorktreePath,
      });

      const amCmd = `${nhp}git am ${flags.join(" ")} ${shellQuote(remotePatchPath)}`.trim();
      const amResult = await execBuffered(params.runtime, amCmd, {
        cwd: dryRunWorktreePath,
        timeout: 300,
      });

      if (amResult.exitCode !== 0) {
        const stderr = amResult.stderr.trim();
        const stdout = amResult.stdout.trim();
        const errorOutput = [stderr, stdout]
          .filter((s) => s.length > 0)
          .join("\n")
          .trim();

        const conflictPaths = await tryGetConflictPaths({
          runtime: params.runtime,
          cwd: dryRunWorktreePath,
        });
        const failedPatchSubject = parseFailedPatchSubjectFromGitAmOutput(errorOutput);

        return {
          success: false,
          projectResult: {
            projectPath: params.projectArtifact.projectPath,
            projectName: params.projectArtifact.projectName,
            status: "failed",
            conflictPaths,
            failedPatchSubject,
            error:
              errorOutput.length > 0
                ? errorOutput
                : `git am failed (exitCode=${amResult.exitCode})`,
            note: mergeNotes(
              patchResolution.note,
              "Dry run failed; the patch does not apply cleanly against the current HEAD. If this is a parent integration workspace, do not attempt a real apply here; delegate conflict resolution to a sub-agent that can replay and resolve the patch. Dedicated reconciliation workspaces can proceed with real apply plus manual conflict resolution (`git am --continue` / `git am --abort`)."
            ),
          },
        };
      }

      const appliedCommits = await getAppliedCommits({
        runtime: params.runtime,
        cwd: dryRunWorktreePath,
        beforeHeadSha,
        commitCountHint: params.projectArtifact.commitCount,
        includeSha: false,
      });

      return {
        success: true,
        projectResult: {
          projectPath: params.projectArtifact.projectPath,
          projectName: params.projectArtifact.projectName,
          status: "applied",
          appliedCommits,
          note: mergeNotes(patchResolution.note, "Dry run succeeded; no commits were applied."),
        },
      };
    } finally {
      try {
        const abortResult = await execBuffered(params.runtime, `${nhp}git am --abort`, {
          cwd: dryRunWorktreePath,
          timeout: 30,
        });
        if (abortResult.exitCode !== 0) {
          log.debug("task_apply_git_patch: dry-run git am --abort failed", {
            taskId: params.taskId,
            workspaceId: params.workspaceId,
            cwd: params.repoCwd,
            dryRunWorktreePath,
            exitCode: abortResult.exitCode,
            stderr: abortResult.stderr.trim(),
            stdout: abortResult.stdout.trim(),
          });
        }
      } catch (error: unknown) {
        log.debug("task_apply_git_patch: dry-run git am --abort threw", {
          taskId: params.taskId,
          workspaceId: params.workspaceId,
          cwd: params.repoCwd,
          dryRunWorktreePath,
          error,
        });
      }

      try {
        const removeResult = await execBuffered(
          params.runtime,
          `${nhp}git worktree remove --force ${shellQuote(dryRunWorktreePath)}`,
          { cwd: params.repoCwd, timeout: 60 }
        );
        if (removeResult.exitCode !== 0) {
          log.debug("task_apply_git_patch: dry-run git worktree remove failed", {
            taskId: params.taskId,
            workspaceId: params.workspaceId,
            cwd: params.repoCwd,
            dryRunWorktreePath,
            exitCode: removeResult.exitCode,
            stderr: removeResult.stderr.trim(),
            stdout: removeResult.stdout.trim(),
          });
        }
      } catch (error: unknown) {
        log.debug("task_apply_git_patch: dry-run git worktree remove threw", {
          taskId: params.taskId,
          workspaceId: params.workspaceId,
          cwd: params.repoCwd,
          dryRunWorktreePath,
          error,
        });
      }

      try {
        const pruneResult = await execBuffered(params.runtime, "git worktree prune", {
          cwd: params.repoCwd,
          timeout: 60,
        });
        if (pruneResult.exitCode !== 0) {
          log.debug("task_apply_git_patch: dry-run git worktree prune failed", {
            taskId: params.taskId,
            workspaceId: params.workspaceId,
            cwd: params.repoCwd,
            exitCode: pruneResult.exitCode,
            stderr: pruneResult.stderr.trim(),
            stdout: pruneResult.stdout.trim(),
          });
        }
      } catch (error: unknown) {
        log.debug("task_apply_git_patch: dry-run git worktree prune threw", {
          taskId: params.taskId,
          workspaceId: params.workspaceId,
          cwd: params.repoCwd,
          error,
        });
      }
    }
  }

  const beforeHeadSha = await tryRevParseHead({ runtime: params.runtime, cwd: params.repoCwd });

  const amCmd = `${nhp}git am ${flags.join(" ")} ${shellQuote(remotePatchPath)}`.trim();
  const amResult = await execBuffered(params.runtime, amCmd, {
    cwd: params.repoCwd,
    timeout: 300,
  });

  if (amResult.exitCode !== 0) {
    const stderr = amResult.stderr.trim();
    const stdout = amResult.stdout.trim();
    const errorOutput = [stderr, stdout]
      .filter((s) => s.length > 0)
      .join("\n")
      .trim();

    const conflictPaths = await tryGetConflictPaths({
      runtime: params.runtime,
      cwd: params.repoCwd,
    });
    const failedPatchSubject = parseFailedPatchSubjectFromGitAmOutput(errorOutput);
    const gitAmInProgress = await isGitAmInProgress({
      runtime: params.runtime,
      cwd: params.repoCwd,
    });
    const conflictRecoveryNote =
      conflictPaths.length > 0 || gitAmInProgress
        ? "git am stopped in conflict-recovery state. Resolve conflicts/issues and run `git am --continue`, or run `git am --abort` to restore a clean working tree and delegate resolution to a sub-agent."
        : "git am failed before entering conflict-recovery state. Review the error output above and fix the patch/input before retrying.";

    return {
      success: false,
      projectResult: {
        projectPath: params.projectArtifact.projectPath,
        projectName: params.projectArtifact.projectName,
        status: "failed",
        conflictPaths,
        failedPatchSubject,
        error:
          errorOutput.length > 0 ? errorOutput : `git am failed (exitCode=${amResult.exitCode})`,
        note: mergeNotes(patchResolution.note, conflictRecoveryNote),
      },
    };
  }

  const headCommitSha = await tryRevParseHead({ runtime: params.runtime, cwd: params.repoCwd });

  const appliedCommits = await getAppliedCommits({
    runtime: params.runtime,
    cwd: params.repoCwd,
    beforeHeadSha,
    commitCountHint: params.projectArtifact.commitCount,
    includeSha: true,
  });

  if (!params.isReplay) {
    await markSubagentGitPatchArtifactApplied({
      workspaceId: params.artifactWorkspaceId,
      workspaceSessionDir: params.artifactSessionDir,
      childTaskId: params.taskId,
      projectPath: params.projectArtifact.projectPath,
      appliedAtMs: Date.now(),
    });
  }

  return {
    success: true,
    projectResult: {
      projectPath: params.projectArtifact.projectPath,
      projectName: params.projectArtifact.projectName,
      status: "applied",
      appliedCommits,
      headCommitSha,
      note: patchResolution.note,
    },
  };
}

export const createTaskApplyGitPatchTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.task_apply_git_patch.description,
    inputSchema: TOOL_DEFINITIONS.task_apply_git_patch.schema,
    execute: async (args, { abortSignal }): Promise<unknown> => {
      const workspaceId = requireWorkspaceId(config, "task_apply_git_patch");
      assert(config.cwd, "task_apply_git_patch requires cwd");
      assert(config.runtimeTempDir, "task_apply_git_patch requires runtimeTempDir");
      const workspaceSessionDir = config.workspaceSessionDir;
      assert(workspaceSessionDir, "task_apply_git_patch requires workspaceSessionDir");

      const taskId = args.task_id;
      const dryRun = args.dry_run === true;
      const threeWay = args.three_way !== false;
      const force = args.force === true;

      const artifactLookup = await findGitPatchArtifactInWorkspaceOrAncestors({
        workspaceId,
        workspaceSessionDir,
        childTaskId: taskId,
      });

      if (!artifactLookup) {
        return parseToolResult(
          TaskApplyGitPatchToolResultSchema,
          {
            success: false as const,
            taskId,
            dryRun,
            error: "No git patch artifact found for this taskId.",
          },
          "task_apply_git_patch"
        );
      }

      const artifact = artifactLookup.artifact;
      const artifactWorkspaceId = artifactLookup.artifactWorkspaceId;
      const artifactSessionDir = artifactLookup.artifactSessionDir;
      const isReplay = artifactWorkspaceId !== workspaceId;
      const artifactLookupNote = artifactLookup.note;

      if (artifact.parentWorkspaceId !== artifactWorkspaceId) {
        return parseToolResult(
          TaskApplyGitPatchToolResultSchema,
          {
            success: false as const,
            taskId,
            dryRun,
            error: "This patch artifact belongs to a different parent workspace.",
            note: mergeNotes(
              artifactLookupNote,
              `Expected parent workspace ${artifactWorkspaceId} but artifact metadata says ${artifact.parentWorkspaceId}.`
            ),
          },
          "task_apply_git_patch"
        );
      }

      const projectArtifacts =
        args.project_path != null
          ? artifact.projectArtifacts.filter(
              (projectArtifact) => projectArtifact.projectPath === args.project_path
            )
          : artifact.projectArtifacts;

      if (args.project_path != null && projectArtifacts.length === 0) {
        return parseToolResult(
          TaskApplyGitPatchToolResultSchema,
          {
            success: false as const,
            taskId,
            dryRun,
            error: `No project patch artifact found for ${args.project_path}.`,
          },
          "task_apply_git_patch"
        );
      }

      if (projectArtifacts.length === 0) {
        return parseToolResult(
          TaskApplyGitPatchToolResultSchema,
          {
            success: false as const,
            taskId,
            dryRun,
            error: "This task has no project patch artifacts.",
          },
          "task_apply_git_patch"
        );
      }

      const repoTargetsByProjectPath = resolveCurrentWorkspaceRepoTargets({
        workspaceId,
        workspaceSessionDir,
      });
      const projectResults: TaskApplyGitPatchProjectResult[] = [];

      const readyProjectArtifacts = projectArtifacts.filter(
        (projectArtifact) => projectArtifact.status === "ready"
      );
      if (readyProjectArtifacts.length === 0) {
        for (const projectArtifact of projectArtifacts) {
          projectResults.push(summarizeNonReadyProjectArtifact({ projectArtifact }));
        }

        const legacyFields = toLegacyFields(projectResults);
        return parseToolResult(
          TaskApplyGitPatchToolResultSchema,
          {
            success: false as const,
            taskId,
            dryRun,
            projectResults,
            error: "This task has no ready project patch artifacts.",
            note: artifactLookupNote,
            ...legacyFields,
          },
          "task_apply_git_patch"
        );
      }

      let shouldStopAfterFailure = false;
      for (const projectArtifact of projectArtifacts) {
        if (shouldStopAfterFailure) {
          projectResults.push({
            projectPath: projectArtifact.projectPath,
            projectName: projectArtifact.projectName,
            status: "skipped",
            error: "Not attempted because an earlier project apply failed.",
          });
          continue;
        }

        if (projectArtifact.status !== "ready") {
          projectResults.push(summarizeNonReadyProjectArtifact({ projectArtifact }));
          if (args.project_path != null) {
            shouldStopAfterFailure = true;
          }
          continue;
        }

        if (!isReplay && projectArtifact.appliedAtMs && !force && !dryRun) {
          projectResults.push({
            projectPath: projectArtifact.projectPath,
            projectName: projectArtifact.projectName,
            status: "failed",
            error: `Patch already applied at ${new Date(projectArtifact.appliedAtMs).toISOString()}.`,
            note: "Re-run with force=true to apply again.",
          });
          shouldStopAfterFailure = true;
          continue;
        }

        const repoTarget = repoTargetsByProjectPath.get(projectArtifact.projectPath);
        const repoCwd =
          repoTarget?.repoCwd ?? (artifact.projectArtifacts.length === 1 ? config.cwd : undefined);
        if (!repoCwd) {
          projectResults.push({
            projectPath: projectArtifact.projectPath,
            projectName: projectArtifact.projectName,
            status: "failed",
            error: "Could not resolve the current workspace repo root for this project.",
          });
          shouldStopAfterFailure = true;
          continue;
        }

        const applyResult = await applyProjectPatch({
          taskId,
          workspaceId,
          runtime: config.runtime,
          runtimeTempDir: config.runtimeTempDir,
          trusted: config.trusted === true,
          repoCwd,
          projectArtifact,
          artifactWorkspaceId,
          artifactSessionDir,
          artifactLookupNote,
          dryRun,
          threeWay,
          force,
          isReplay,
          abortSignal,
        });
        projectResults.push(applyResult.projectResult);
        if (!applyResult.success) {
          shouldStopAfterFailure = true;
        }
      }

      const legacyFields = toLegacyFields(projectResults);
      const attemptedReadyCount = projectArtifacts.filter(
        (projectArtifact) => projectArtifact.status === "ready"
      ).length;
      const appliedReadyCount = projectResults.filter(
        (projectResult) => projectResult.status === "applied"
      ).length;
      const hasApplyFailure = projectResults.some(
        (projectResult, index) =>
          projectResult.status === "failed" && projectArtifacts[index]?.status === "ready"
      );
      const overallNote = mergeNotes(
        artifactLookupNote,
        projectResults
          .map((projectResult) => projectResult.note)
          .filter((note): note is string => typeof note === "string")
          .join("\n") || undefined
      );

      if (hasApplyFailure) {
        const firstFailedProject = projectResults.find(
          (projectResult) => projectResult.status === "failed"
        );
        return parseToolResult(
          TaskApplyGitPatchToolResultSchema,
          {
            success: false as const,
            taskId,
            dryRun,
            projectResults,
            error:
              firstFailedProject?.error ??
              `Failed while applying project patches (${appliedReadyCount}/${attemptedReadyCount} ready projects applied).`,
            note: overallNote,
            ...legacyFields,
          },
          "task_apply_git_patch"
        );
      }

      return parseToolResult(
        TaskApplyGitPatchToolResultSchema,
        {
          success: true as const,
          taskId,
          projectResults,
          dryRun,
          note: overallNote,
          ...(projectResults.length === 1 ? legacyFields : {}),
        },
        "task_apply_git_patch"
      );
    },
  });
};

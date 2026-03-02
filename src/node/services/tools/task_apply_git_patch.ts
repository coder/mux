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

import { parseToolResult, requireWorkspaceId } from "./toolUtils";

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

export const createTaskApplyGitPatchTool: ToolFactory = (config: ToolConfiguration) => {
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

  async function tryRevParseHead(params: { cwd: string }): Promise<string | undefined> {
    try {
      const headResult = await execBuffered(config.runtime, "git rev-parse HEAD", {
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
    cwd: string;
    beforeHeadSha: string | undefined;
    commitCountHint: number | undefined;
    includeSha: boolean;
  }): Promise<Array<{ sha?: string; subject: string }>> {
    const format = "%H%x00%s";

    async function tryGitLog(args: {
      cmd: string;
      includeSha: boolean;
    }): Promise<Array<{ sha?: string; subject: string }> | undefined> {
      try {
        const result = await execBuffered(config.runtime, args.cmd, {
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

        const commits: Array<{ sha?: string; subject: string }> = [];
        for (const line of lines) {
          const nulIndex = line.indexOf("\u0000");
          if (nulIndex === -1) {
            // Defensive: unexpected formatting; treat as a subject-only line.
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

    // Best option: log the exact range of new commits.
    if (params.beforeHeadSha) {
      const rangeCmd = `git log --reverse --format=${format} ${params.beforeHeadSha}..HEAD`;
      const commits = await tryGitLog({ cmd: rangeCmd, includeSha: params.includeSha });
      if (commits) return commits;
    }

    // Fallback: best-effort last-N commits.
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

  async function tryGetConflictPaths(params: { cwd: string }): Promise<string[]> {
    assert(params.cwd.length > 0, "tryGetConflictPaths: cwd must be non-empty");

    try {
      const diffResult = await execBuffered(
        config.runtime,
        "git diff --name-only --diff-filter=U",
        {
          cwd: params.cwd,
          timeout: 30,
        }
      );

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

    const direct = await readSubagentGitPatchArtifact(
      params.workspaceSessionDir,
      params.childTaskId
    );
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

      if (artifact.status === "pending") {
        return parseToolResult(
          TaskApplyGitPatchToolResultSchema,
          {
            success: false as const,
            taskId,
            error: "Patch artifact is still pending generation.",
          },
          "task_apply_git_patch"
        );
      }

      if (artifact.status === "failed") {
        return parseToolResult(
          TaskApplyGitPatchToolResultSchema,
          {
            success: false as const,
            taskId,
            error: artifact.error ?? "Patch artifact generation failed.",
          },
          "task_apply_git_patch"
        );
      }

      if (artifact.status === "skipped") {
        return parseToolResult(
          TaskApplyGitPatchToolResultSchema,
          {
            success: false as const,
            taskId,
            error: "This task produced no commits (patch generation was skipped).",
          },
          "task_apply_git_patch"
        );
      }

      if (!isReplay && artifact.appliedAtMs && !force && !dryRun) {
        return parseToolResult(
          TaskApplyGitPatchToolResultSchema,
          {
            success: false as const,
            taskId,
            error: `Patch already applied at ${new Date(artifact.appliedAtMs).toISOString()}.`,
            note: "Re-run with force=true to apply again.",
          },
          "task_apply_git_patch"
        );
      }

      const expectedPatchPath = getSubagentGitPatchMboxPath(artifactSessionDir, taskId);

      // Defensive: `task_id` is user-controlled input; reject path traversal.
      if (!isPathInsideDir(artifactSessionDir, expectedPatchPath)) {
        return parseToolResult(
          TaskApplyGitPatchToolResultSchema,
          {
            success: false as const,
            taskId,
            error: "Invalid task_id.",
            note: "task_id must not contain path traversal segments.",
          },
          "task_apply_git_patch"
        );
      }

      const safeMboxPath =
        typeof artifact.mboxPath === "string" && artifact.mboxPath.length > 0
          ? isPathInsideDir(artifactSessionDir, artifact.mboxPath)
            ? artifact.mboxPath
            : undefined
          : undefined;

      let patchPathNote = mergeNotes(
        artifactLookupNote,
        artifact.mboxPath && !safeMboxPath
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
            isPathInsideDir(artifactSessionDir, candidate)
              ? path.relative(artifactSessionDir, candidate) || path.basename(candidate)
              : candidate
          )
          .join(", ");

        log.debug("task_apply_git_patch: patch file missing", {
          taskId,
          workspaceId,
          cwd: config.cwd,
          checkedPaths,
        });

        return parseToolResult(
          TaskApplyGitPatchToolResultSchema,
          {
            success: false as const,
            taskId,
            error: "Patch file is missing on disk.",
            note: mergeNotes(
              patchPathNote,
              checkedPaths.length > 0 ? `Checked patch locations: ${checkedPaths}` : undefined
            ),
          },
          "task_apply_git_patch"
        );
      }

      if (safeMboxPath && patchPath === expectedPatchPath && safeMboxPath !== expectedPatchPath) {
        patchPathNote = mergeNotes(
          patchPathNote,
          "Patch file not found at metadata mboxPath; using canonical patch location."
        );
      }

      if (!force) {
        const statusResult = await execBuffered(config.runtime, "git status --porcelain", {
          cwd: config.cwd,
          timeout: 10,
        });
        if (statusResult.exitCode !== 0) {
          return parseToolResult(
            TaskApplyGitPatchToolResultSchema,
            {
              success: false as const,
              taskId,
              error: statusResult.stderr.trim() || "git status failed",
              note: patchPathNote,
            },
            "task_apply_git_patch"
          );
        }

        if (statusResult.stdout.trim().length > 0) {
          return parseToolResult(
            TaskApplyGitPatchToolResultSchema,
            {
              success: false as const,
              taskId,
              error: "Working tree is not clean.",
              note: mergeNotes(
                patchPathNote,
                "Commit/stash your changes (or pass force=true) before applying patches."
              ),
            },
            "task_apply_git_patch"
          );
        }
      }

      // Use path.posix.join to preserve forward slashes:
      // - SSH runtime needs POSIX-style paths
      // - Windows local runtime uses drive-qualified paths like C:/Users/... (also with /)
      const remotePatchPath = path.posix.join(
        config.runtimeTempDir,
        `mux-task-${taskId}-series.mbox`
      );

      await copyLocalFileToRuntime({
        runtime: config.runtime,
        localPath: patchPath,
        remotePath: remotePatchPath,
        abortSignal,
      });

      const flags: string[] = [];
      if (threeWay) flags.push("--3way");

      // Disable git hooks for untrusted projects (prevents applypatch-msg, pre-applypatch, post-applypatch)
      const nhp = gitNoHooksPrefix(config.trusted);

      if (dryRun) {
        // `git am` doesn't support a native --dry-run. Instead, apply inside a temporary worktree
        // and discard it. This avoids mutating the current worktree while still exercising `git am`.
        const dryRunId = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
        const dryRunWorktreePath = path.posix.join(
          config.runtimeTempDir,
          `mux-git-am-dry-run-${taskId}-${dryRunId}`
        );

        const addResult = await execBuffered(
          config.runtime,
          `${nhp}git worktree add --detach ${shellQuote(dryRunWorktreePath)} HEAD`,
          { cwd: config.cwd, timeout: 60 }
        );
        if (addResult.exitCode !== 0) {
          return parseToolResult(
            TaskApplyGitPatchToolResultSchema,
            {
              success: false as const,
              taskId,
              error:
                addResult.stderr.trim() || addResult.stdout.trim() || "git worktree add failed",
            },
            "task_apply_git_patch"
          );
        }

        try {
          const beforeHeadSha = await tryRevParseHead({ cwd: dryRunWorktreePath });

          const amCmd = `${nhp}git am ${flags.join(" ")} ${shellQuote(remotePatchPath)}`.trim();
          const amResult = await execBuffered(config.runtime, amCmd, {
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

            const conflictPaths = await tryGetConflictPaths({ cwd: dryRunWorktreePath });
            const failedPatchSubject = parseFailedPatchSubjectFromGitAmOutput(errorOutput);

            return parseToolResult(
              TaskApplyGitPatchToolResultSchema,
              {
                success: false as const,
                taskId,
                dryRun: true,
                conflictPaths,
                failedPatchSubject,
                error:
                  errorOutput.length > 0
                    ? errorOutput
                    : `git am failed (exitCode=${amResult.exitCode})`,
                note: mergeNotes(
                  patchPathNote,
                  "Dry run failed; the patch does not apply cleanly. Applying for real will likely require conflict resolution."
                ),
              },
              "task_apply_git_patch"
            );
          }

          const appliedCommits = await getAppliedCommits({
            cwd: dryRunWorktreePath,
            beforeHeadSha,
            commitCountHint: artifact.commitCount,
            includeSha: false,
          });

          return parseToolResult(
            TaskApplyGitPatchToolResultSchema,
            {
              success: true as const,
              taskId,
              appliedCommits,
              dryRun: true,
              note: mergeNotes(patchPathNote, "Dry run succeeded; no commits were applied."),
            },
            "task_apply_git_patch"
          );
        } finally {
          // Best-effort: clean up the temp worktree. This should never fail the tool call.
          try {
            const abortResult = await execBuffered(config.runtime, `${nhp}git am --abort`, {
              cwd: dryRunWorktreePath,
              timeout: 30,
            });
            if (abortResult.exitCode !== 0) {
              log.debug("task_apply_git_patch: dry-run git am --abort failed", {
                taskId,
                workspaceId,
                cwd: config.cwd,
                dryRunWorktreePath,
                exitCode: abortResult.exitCode,
                stderr: abortResult.stderr.trim(),
                stdout: abortResult.stdout.trim(),
              });
            }
          } catch (error: unknown) {
            log.debug("task_apply_git_patch: dry-run git am --abort threw", {
              taskId,
              workspaceId,
              cwd: config.cwd,
              dryRunWorktreePath,
              error,
            });
          }

          try {
            const removeResult = await execBuffered(
              config.runtime,
              `${nhp}git worktree remove --force ${shellQuote(dryRunWorktreePath)}`,
              { cwd: config.cwd, timeout: 60 }
            );
            if (removeResult.exitCode !== 0) {
              log.debug("task_apply_git_patch: dry-run git worktree remove failed", {
                taskId,
                workspaceId,
                cwd: config.cwd,
                dryRunWorktreePath,
                exitCode: removeResult.exitCode,
                stderr: removeResult.stderr.trim(),
                stdout: removeResult.stdout.trim(),
              });
            }
          } catch (error: unknown) {
            log.debug("task_apply_git_patch: dry-run git worktree remove threw", {
              taskId,
              workspaceId,
              cwd: config.cwd,
              dryRunWorktreePath,
              error,
            });
          }

          try {
            const pruneResult = await execBuffered(config.runtime, "git worktree prune", {
              cwd: config.cwd,
              timeout: 60,
            });
            if (pruneResult.exitCode !== 0) {
              log.debug("task_apply_git_patch: dry-run git worktree prune failed", {
                taskId,
                workspaceId,
                cwd: config.cwd,
                exitCode: pruneResult.exitCode,
                stderr: pruneResult.stderr.trim(),
                stdout: pruneResult.stdout.trim(),
              });
            }
          } catch (error: unknown) {
            log.debug("task_apply_git_patch: dry-run git worktree prune threw", {
              taskId,
              workspaceId,
              cwd: config.cwd,
              error,
            });
          }
        }
      }

      const beforeHeadSha = await tryRevParseHead({ cwd: config.cwd });

      const amCmd = `${nhp}git am ${flags.join(" ")} ${shellQuote(remotePatchPath)}`.trim();
      const amResult = await execBuffered(config.runtime, amCmd, { cwd: config.cwd, timeout: 300 });

      if (amResult.exitCode !== 0) {
        const stderr = amResult.stderr.trim();
        const stdout = amResult.stdout.trim();
        const errorOutput = [stderr, stdout]
          .filter((s) => s.length > 0)
          .join("\n")
          .trim();

        const conflictPaths = await tryGetConflictPaths({ cwd: config.cwd });
        const failedPatchSubject = parseFailedPatchSubjectFromGitAmOutput(errorOutput);

        return parseToolResult(
          TaskApplyGitPatchToolResultSchema,
          {
            success: false as const,
            taskId,
            dryRun: false,
            conflictPaths,
            failedPatchSubject,
            error:
              errorOutput.length > 0
                ? errorOutput
                : `git am failed (exitCode=${amResult.exitCode})`,
            note: mergeNotes(
              patchPathNote,
              "If git am stopped due to conflicts, resolve them then run `git am --continue` or `git am --abort`."
            ),
          },
          "task_apply_git_patch"
        );
      }

      const headCommitSha = await tryRevParseHead({ cwd: config.cwd });

      const appliedCommits = await getAppliedCommits({
        cwd: config.cwd,
        beforeHeadSha,
        commitCountHint: artifact.commitCount,
        includeSha: true,
      });

      if (!dryRun && !isReplay) {
        await markSubagentGitPatchArtifactApplied({
          workspaceId: artifactWorkspaceId,
          workspaceSessionDir: artifactSessionDir,
          childTaskId: taskId,
          appliedAtMs: Date.now(),
        });
      }

      return parseToolResult(
        TaskApplyGitPatchToolResultSchema,
        {
          success: true as const,
          taskId,
          appliedCommits,
          headCommitSha,
          note: mergeNotes(patchPathNote),
        },
        "task_apply_git_patch"
      );
    },
  });
};

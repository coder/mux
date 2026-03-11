import * as path from "node:path";
import assert from "node:assert/strict";
import * as fsPromises from "fs/promises";

import type { Config } from "@/node/config";
import type {
  SubagentGitPatchArtifact,
  SubagentGitProjectPatchArtifact,
} from "@/common/utils/tools/toolDefinitions";
import type { ProjectRef } from "@/common/types/workspace";
import {
  coerceNonEmptyString,
  tryReadGitHeadCommitSha,
  findWorkspaceEntry,
} from "@/node/services/taskUtils";
import { log } from "@/node/services/log";
import { readAgentDefinition } from "@/node/services/agentDefinitions/agentDefinitionsService";
import { resolveAgentInheritanceChain } from "@/node/services/agentDefinitions/resolveAgentInheritanceChain";
import { isExecLikeEditingCapableInResolvedChain } from "@/common/utils/agentTools";
import { createRuntimeForWorkspace } from "@/node/runtime/runtimeHelpers";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { AgentIdSchema } from "@/common/orpc/schemas";
import {
  getSubagentGitPatchMboxPath,
  matchesProjectArtifactProjectPathForUpdate,
  upsertSubagentGitPatchArtifact,
} from "@/node/services/subagentGitPatchArtifacts";
import { shellQuote } from "@/common/utils/shell";
import { streamToString } from "@/node/runtime/streamUtils";
import { getErrorMessage } from "@/common/utils/errors";
import { PlatformPaths } from "@/common/utils/paths";
import { getWorkspaceProjectRepos } from "@/node/services/workspaceProjectRepos";

/** Callback invoked after patch generation completes (success or failure). */
export type OnPatchGenerationComplete = (childWorkspaceId: string) => Promise<void>;

async function writeReadableStreamToLocalFile(
  stream: ReadableStream<Uint8Array>,
  filePath: string
): Promise<void> {
  assert(filePath.length > 0, "writeReadableStreamToLocalFile: filePath must be non-empty");

  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });

  const fileHandle = await fsPromises.open(filePath, "w");
  try {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          await fileHandle.write(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
  } finally {
    await fileHandle.close();
  }
}

function getPrimaryProjectName(projectPath: string, projects?: ProjectRef[]): string {
  const matchingProjectName = projects
    ?.find((project) => project.projectPath.trim() === projectPath.trim())
    ?.projectName?.trim();
  return matchingProjectName && matchingProjectName.length > 0
    ? matchingProjectName
    : PlatformPaths.getProjectName(projectPath).trim();
}

function buildTaskBaseCommitShaByProjectPath(params: {
  projectPath: string;
  projects?: ProjectRef[];
  taskBaseCommitSha?: string;
  taskBaseCommitShaByProjectPath?: Record<string, string>;
}): Record<string, string> {
  const baseCommitShaByProjectPath = { ...(params.taskBaseCommitShaByProjectPath ?? {}) };
  if (params.taskBaseCommitSha?.trim()) {
    baseCommitShaByProjectPath[params.projectPath] = params.taskBaseCommitSha.trim();
  }

  if (Array.isArray(params.projects)) {
    for (const project of params.projects) {
      if (!project.projectPath.trim()) {
        continue;
      }
      if (!(project.projectPath in baseCommitShaByProjectPath)) {
        baseCommitShaByProjectPath[project.projectPath] = "";
      }
    }
  }

  return baseCommitShaByProjectPath;
}

function buildPendingProjectArtifacts(params: {
  projectPath: string;
  projects?: ProjectRef[];
  taskBaseCommitSha?: string;
  taskBaseCommitShaByProjectPath?: Record<string, string>;
}): SubagentGitProjectPatchArtifact[] {
  const baseCommitShaByProjectPath = buildTaskBaseCommitShaByProjectPath(params);
  const projectRefs =
    params.projects && params.projects.length > 0
      ? params.projects
      : [
          {
            projectPath: params.projectPath,
            projectName: getPrimaryProjectName(params.projectPath),
          },
        ];

  return projectRefs.map((project) => {
    const projectName = project.projectName.trim();
    assert(projectName.length > 0, "buildPendingProjectArtifacts: projectName must be non-empty");

    return {
      projectPath: project.projectPath,
      projectName,
      storageKey: projectName,
      status: "pending",
      baseCommitSha: baseCommitShaByProjectPath[project.projectPath] || undefined,
    } satisfies SubagentGitProjectPatchArtifact;
  });
}

function buildPendingPatchArtifact(params: {
  childTaskId: string;
  parentWorkspaceId: string;
  createdAtMs: number;
  updatedAtMs: number;
  projectArtifacts: SubagentGitProjectPatchArtifact[];
}): SubagentGitPatchArtifact {
  return {
    childTaskId: params.childTaskId,
    parentWorkspaceId: params.parentWorkspaceId,
    createdAtMs: params.createdAtMs,
    updatedAtMs: params.updatedAtMs,
    status: "pending",
    projectArtifacts: params.projectArtifacts,
    readyProjectCount: 0,
    failedProjectCount: 0,
    skippedProjectCount: 0,
    totalCommitCount: 0,
  };
}

export function upsertProjectArtifact(params: {
  artifact: SubagentGitPatchArtifact;
  nextProjectArtifact: SubagentGitProjectPatchArtifact;
  updatedAtMs: number;
}): SubagentGitPatchArtifact {
  let didMatchExistingArtifact = false;
  const projectArtifacts = params.artifact.projectArtifacts.map((projectArtifact) => {
    if (
      !matchesProjectArtifactProjectPathForUpdate(
        projectArtifact,
        params.nextProjectArtifact.projectPath
      )
    ) {
      return projectArtifact;
    }

    didMatchExistingArtifact = true;
    return params.nextProjectArtifact;
  });

  return {
    ...params.artifact,
    updatedAtMs: params.updatedAtMs,
    projectArtifacts: didMatchExistingArtifact
      ? projectArtifacts
      : [...projectArtifacts, params.nextProjectArtifact],
  };
}

function failPendingProjectArtifacts(params: {
  artifact: SubagentGitPatchArtifact;
  error: string;
  updatedAtMs: number;
}): SubagentGitPatchArtifact {
  return {
    ...params.artifact,
    updatedAtMs: params.updatedAtMs,
    projectArtifacts: params.artifact.projectArtifacts.map((projectArtifact) =>
      projectArtifact.status === "pending"
        ? {
            ...projectArtifact,
            status: "failed",
            error: params.error,
          }
        : projectArtifact
    ),
  };
}

// ---------------------------------------------------------------------------
// GitPatchArtifactService
// ---------------------------------------------------------------------------

/**
 * Handles git-format-patch artifact generation for subagent tasks.
 *
 * Extracted from TaskService to keep patch-specific logic self-contained.
 */
export class GitPatchArtifactService {
  private readonly pendingJobsByTaskId = new Map<string, Promise<void>>();

  constructor(private readonly config: Config) {}

  /**
   * If the child workspace is an exec-like agent, write a pending patch artifact
   * marker and kick off background `git format-patch` generation.
   *
   * @param onComplete - called after generation finishes (success *or* failure),
   *   typically used to trigger reported-leaf-task cleanup.
   */
  async maybeStartGeneration(
    parentWorkspaceId: string,
    childWorkspaceId: string,
    onComplete: OnPatchGenerationComplete
  ): Promise<void> {
    assert(
      parentWorkspaceId.length > 0,
      "maybeStartGeneration: parentWorkspaceId must be non-empty"
    );
    assert(childWorkspaceId.length > 0, "maybeStartGeneration: childWorkspaceId must be non-empty");

    const parentSessionDir = this.config.getSessionDir(parentWorkspaceId);

    // Write a pending marker before we attempt cleanup, so the reported task workspace isn't deleted
    // while we're still reading commits from it.
    const nowMs = Date.now();
    const cfg = this.config.loadConfigOrDefault();
    const childEntry = findWorkspaceEntry(cfg, childWorkspaceId);

    // Only exec-like subagents are expected to make commits that should be handed back to the parent.
    // NOTE: Custom agents can inherit from exec (base: exec). Those should also generate patches,
    // but read-only subagents (e.g. explore) should not.
    const childAgentIdRaw = coerceNonEmptyString(
      childEntry?.workspace.agentId ?? childEntry?.workspace.agentType
    );
    const childAgentId = childAgentIdRaw?.toLowerCase();
    if (!childAgentId) {
      return;
    }

    let shouldGeneratePatch = childAgentId === "exec";

    if (!shouldGeneratePatch) {
      const parsedChildAgentId = AgentIdSchema.safeParse(childAgentId);
      if (parsedChildAgentId.success) {
        const agentId = parsedChildAgentId.data;

        // Prefer resolving agent inheritance from the parent workspace: project agents may be untracked
        // (and therefore absent from child worktrees), but they are always present in the parent that
        // spawned the task.
        const agentDiscoveryEntry = findWorkspaceEntry(cfg, parentWorkspaceId) ?? childEntry;
        const agentDiscoveryWs = agentDiscoveryEntry?.workspace;

        const agentWorkspacePath = coerceNonEmptyString(agentDiscoveryWs?.path);
        const runtimeConfig = agentDiscoveryWs?.runtimeConfig;

        if (agentDiscoveryEntry && agentWorkspacePath && runtimeConfig) {
          const fallbackName =
            agentWorkspacePath.split("/").pop() ?? agentWorkspacePath.split("\\").pop() ?? "";
          const workspaceName =
            coerceNonEmptyString(agentDiscoveryWs?.name) ?? coerceNonEmptyString(fallbackName);

          if (workspaceName) {
            const runtime = createRuntimeForWorkspace({
              runtimeConfig,
              projectPath: agentDiscoveryEntry.projectPath,
              name: workspaceName,
            });

            try {
              const agentDefinition = await readAgentDefinition(
                runtime,
                agentWorkspacePath,
                agentId
              );
              const chain = await resolveAgentInheritanceChain({
                runtime,
                workspacePath: agentWorkspacePath,
                agentId,
                agentDefinition,
                workspaceId: childWorkspaceId,
              });

              shouldGeneratePatch = isExecLikeEditingCapableInResolvedChain(chain);
            } catch {
              // ignore - treat as non-exec-like
            }
          }
        }
      }
    }

    if (!shouldGeneratePatch || !childEntry) {
      return;
    }

    const pendingProjectArtifacts = buildPendingProjectArtifacts({
      projectPath: childEntry.projectPath,
      projects: childEntry.workspace.projects,
      taskBaseCommitSha: coerceNonEmptyString(childEntry.workspace.taskBaseCommitSha) ?? undefined,
      taskBaseCommitShaByProjectPath: childEntry.workspace.taskBaseCommitShaByProjectPath,
    });

    const artifact = await upsertSubagentGitPatchArtifact({
      workspaceId: parentWorkspaceId,
      workspaceSessionDir: parentSessionDir,
      childTaskId: childWorkspaceId,
      updater: (existing) => {
        if (existing && existing.status !== "pending") {
          return existing;
        }

        return (
          existing ??
          buildPendingPatchArtifact({
            childTaskId: childWorkspaceId,
            parentWorkspaceId,
            createdAtMs: nowMs,
            updatedAtMs: nowMs,
            projectArtifacts: pendingProjectArtifacts,
          })
        );
      },
    });

    if (artifact.status !== "pending") {
      return;
    }

    if (this.pendingJobsByTaskId.has(childWorkspaceId)) {
      return;
    }

    let job: Promise<void>;
    try {
      job = this.generate(parentWorkspaceId, childWorkspaceId, onComplete)
        .catch(async (error: unknown) => {
          log.error("Subagent git patch generation failed", {
            parentWorkspaceId,
            childWorkspaceId,
            error,
          });

          try {
            await upsertSubagentGitPatchArtifact({
              workspaceId: parentWorkspaceId,
              workspaceSessionDir: parentSessionDir,
              childTaskId: childWorkspaceId,
              updater: (existing) => {
                const failedAtMs = Date.now();
                const pendingArtifact =
                  existing ??
                  buildPendingPatchArtifact({
                    childTaskId: childWorkspaceId,
                    parentWorkspaceId,
                    createdAtMs: failedAtMs,
                    updatedAtMs: failedAtMs,
                    projectArtifacts: pendingProjectArtifacts,
                  });
                return failPendingProjectArtifacts({
                  artifact: pendingArtifact,
                  error: getErrorMessage(error),
                  updatedAtMs: failedAtMs,
                });
              },
            });
          } catch (updateError: unknown) {
            log.error("Failed to mark subagent git patch artifact as failed", {
              parentWorkspaceId,
              childWorkspaceId,
              error: updateError,
            });
          }
        })
        .finally(() => {
          this.pendingJobsByTaskId.delete(childWorkspaceId);
        });
    } catch (error: unknown) {
      await upsertSubagentGitPatchArtifact({
        workspaceId: parentWorkspaceId,
        workspaceSessionDir: parentSessionDir,
        childTaskId: childWorkspaceId,
        updater: (existing) => {
          const failedAtMs = Date.now();
          const pendingArtifact =
            existing ??
            buildPendingPatchArtifact({
              childTaskId: childWorkspaceId,
              parentWorkspaceId,
              createdAtMs: failedAtMs,
              updatedAtMs: failedAtMs,
              projectArtifacts: pendingProjectArtifacts,
            });
          return failPendingProjectArtifacts({
            artifact: pendingArtifact,
            error: getErrorMessage(error),
            updatedAtMs: failedAtMs,
          });
        },
      });
      return;
    }

    this.pendingJobsByTaskId.set(childWorkspaceId, job);
  }

  private async generate(
    parentWorkspaceId: string,
    childWorkspaceId: string,
    onComplete: OnPatchGenerationComplete
  ): Promise<void> {
    assert(parentWorkspaceId.length > 0, "generate: parentWorkspaceId must be non-empty");
    assert(childWorkspaceId.length > 0, "generate: childWorkspaceId must be non-empty");

    const parentSessionDir = this.config.getSessionDir(parentWorkspaceId);

    const updateArtifact = async (
      updater: Parameters<typeof upsertSubagentGitPatchArtifact>[0]["updater"]
    ): Promise<SubagentGitPatchArtifact> => {
      return await upsertSubagentGitPatchArtifact({
        workspaceId: parentWorkspaceId,
        workspaceSessionDir: parentSessionDir,
        childTaskId: childWorkspaceId,
        updater,
      });
    };

    const nowMs = Date.now();

    try {
      const cfg = this.config.loadConfigOrDefault();
      const entry = findWorkspaceEntry(cfg, childWorkspaceId);

      if (!entry) {
        await updateArtifact((existing) =>
          failPendingProjectArtifacts({
            artifact:
              existing ??
              buildPendingPatchArtifact({
                childTaskId: childWorkspaceId,
                parentWorkspaceId,
                createdAtMs: nowMs,
                updatedAtMs: nowMs,
                projectArtifacts: [],
              }),
            error: "Task workspace not found in config.",
            updatedAtMs: nowMs,
          })
        );
        return;
      }

      const ws = entry.workspace;

      const workspacePath = coerceNonEmptyString(ws.path);
      if (!workspacePath) {
        await updateArtifact((existing) =>
          failPendingProjectArtifacts({
            artifact:
              existing ??
              buildPendingPatchArtifact({
                childTaskId: childWorkspaceId,
                parentWorkspaceId,
                createdAtMs: nowMs,
                updatedAtMs: nowMs,
                projectArtifacts: buildPendingProjectArtifacts({
                  projectPath: entry.projectPath,
                  projects: ws.projects,
                  taskBaseCommitSha: coerceNonEmptyString(ws.taskBaseCommitSha) ?? undefined,
                  taskBaseCommitShaByProjectPath: ws.taskBaseCommitShaByProjectPath,
                }),
              }),
            error: "Task workspace path missing.",
            updatedAtMs: nowMs,
          })
        );
        return;
      }

      if (!ws.runtimeConfig) {
        await updateArtifact((existing) =>
          failPendingProjectArtifacts({
            artifact:
              existing ??
              buildPendingPatchArtifact({
                childTaskId: childWorkspaceId,
                parentWorkspaceId,
                createdAtMs: nowMs,
                updatedAtMs: nowMs,
                projectArtifacts: buildPendingProjectArtifacts({
                  projectPath: entry.projectPath,
                  projects: ws.projects,
                  taskBaseCommitSha: coerceNonEmptyString(ws.taskBaseCommitSha) ?? undefined,
                  taskBaseCommitShaByProjectPath: ws.taskBaseCommitShaByProjectPath,
                }),
              }),
            error: "Task runtimeConfig missing.",
            updatedAtMs: nowMs,
          })
        );
        return;
      }

      const fallbackName = workspacePath.split("/").pop() ?? workspacePath.split("\\").pop() ?? "";
      const workspaceName = coerceNonEmptyString(ws.name) ?? coerceNonEmptyString(fallbackName);
      if (!workspaceName) {
        await updateArtifact((existing) =>
          failPendingProjectArtifacts({
            artifact:
              existing ??
              buildPendingPatchArtifact({
                childTaskId: childWorkspaceId,
                parentWorkspaceId,
                createdAtMs: nowMs,
                updatedAtMs: nowMs,
                projectArtifacts: buildPendingProjectArtifacts({
                  projectPath: entry.projectPath,
                  projects: ws.projects,
                  taskBaseCommitSha: coerceNonEmptyString(ws.taskBaseCommitSha) ?? undefined,
                  taskBaseCommitShaByProjectPath: ws.taskBaseCommitShaByProjectPath,
                }),
              }),
            error: "Task workspace name missing.",
            updatedAtMs: nowMs,
          })
        );
        return;
      }

      const runtime = createRuntimeForWorkspace({
        runtimeConfig: ws.runtimeConfig,
        projectPath: entry.projectPath,
        name: workspaceName,
      });

      const projectRepos = getWorkspaceProjectRepos({
        workspaceId: childWorkspaceId,
        workspaceName,
        workspacePath,
        runtimeConfig: ws.runtimeConfig,
        projectPath: entry.projectPath,
        projectName: getPrimaryProjectName(entry.projectPath, ws.projects),
        projects: ws.projects,
      });
      const taskBaseCommitShaByProjectPath = buildTaskBaseCommitShaByProjectPath({
        projectPath: entry.projectPath,
        projects: ws.projects,
        taskBaseCommitSha: coerceNonEmptyString(ws.taskBaseCommitSha) ?? undefined,
        taskBaseCommitShaByProjectPath: ws.taskBaseCommitShaByProjectPath,
      });

      const ensureProjectArtifact = async (
        nextProjectArtifact: SubagentGitProjectPatchArtifact
      ): Promise<void> => {
        await updateArtifact((existing) => {
          const pendingArtifact =
            existing ??
            buildPendingPatchArtifact({
              childTaskId: childWorkspaceId,
              parentWorkspaceId,
              createdAtMs: nowMs,
              updatedAtMs: nowMs,
              projectArtifacts: buildPendingProjectArtifacts({
                projectPath: entry.projectPath,
                projects: ws.projects,
                taskBaseCommitSha: coerceNonEmptyString(ws.taskBaseCommitSha) ?? undefined,
                taskBaseCommitShaByProjectPath: ws.taskBaseCommitShaByProjectPath,
              }),
            });
          return upsertProjectArtifact({
            artifact: pendingArtifact,
            nextProjectArtifact,
            updatedAtMs: Date.now(),
          });
        });
      };

      for (const projectRepo of projectRepos) {
        try {
          let baseCommitSha = coerceNonEmptyString(
            taskBaseCommitShaByProjectPath[projectRepo.projectPath]
          );
          if (!baseCommitSha) {
            const trunkBranch =
              coerceNonEmptyString(ws.taskTrunkBranch) ??
              coerceNonEmptyString(findWorkspaceEntry(cfg, parentWorkspaceId)?.workspace.name);

            if (!trunkBranch) {
              await ensureProjectArtifact({
                projectPath: projectRepo.projectPath,
                projectName: projectRepo.projectName,
                storageKey: projectRepo.storageKey,
                status: "failed",
                error:
                  "taskBaseCommitSha missing and could not determine trunk branch for merge-base fallback.",
              });
              continue;
            }

            const mergeBaseResult = await execBuffered(
              runtime,
              `git merge-base ${shellQuote(trunkBranch)} HEAD`,
              { cwd: projectRepo.repoCwd, timeout: 30 }
            );
            if (mergeBaseResult.exitCode !== 0) {
              await ensureProjectArtifact({
                projectPath: projectRepo.projectPath,
                projectName: projectRepo.projectName,
                storageKey: projectRepo.storageKey,
                status: "failed",
                error: `git merge-base failed: ${mergeBaseResult.stderr.trim() || "unknown error"}`,
              });
              continue;
            }

            baseCommitSha = mergeBaseResult.stdout.trim();
          }

          const headCommitSha = await tryReadGitHeadCommitSha(runtime, projectRepo.repoCwd);
          if (!headCommitSha) {
            await ensureProjectArtifact({
              projectPath: projectRepo.projectPath,
              projectName: projectRepo.projectName,
              storageKey: projectRepo.storageKey,
              status: "failed",
              baseCommitSha,
              error: "git rev-parse HEAD failed.",
            });
            continue;
          }

          const countResult = await execBuffered(
            runtime,
            `git rev-list --count ${baseCommitSha}..${headCommitSha}`,
            { cwd: projectRepo.repoCwd, timeout: 30 }
          );
          if (countResult.exitCode !== 0) {
            await ensureProjectArtifact({
              projectPath: projectRepo.projectPath,
              projectName: projectRepo.projectName,
              storageKey: projectRepo.storageKey,
              status: "failed",
              baseCommitSha,
              headCommitSha,
              error: `git rev-list failed: ${countResult.stderr.trim() || "unknown error"}`,
            });
            continue;
          }

          const commitCount = Number.parseInt(countResult.stdout.trim(), 10);
          if (!Number.isFinite(commitCount) || commitCount < 0) {
            await ensureProjectArtifact({
              projectPath: projectRepo.projectPath,
              projectName: projectRepo.projectName,
              storageKey: projectRepo.storageKey,
              status: "failed",
              baseCommitSha,
              headCommitSha,
              error: `Invalid commit count: ${countResult.stdout.trim()}`,
            });
            continue;
          }

          if (commitCount === 0) {
            await ensureProjectArtifact({
              projectPath: projectRepo.projectPath,
              projectName: projectRepo.projectName,
              storageKey: projectRepo.storageKey,
              status: "skipped",
              baseCommitSha,
              headCommitSha,
              commitCount,
            });
            continue;
          }

          const patchPath = getSubagentGitPatchMboxPath(
            parentSessionDir,
            childWorkspaceId,
            projectRepo.storageKey
          );

          const formatPatchStream = await runtime.exec(
            `git format-patch --stdout --binary ${baseCommitSha}..${headCommitSha}`,
            { cwd: projectRepo.repoCwd, timeout: 120 }
          );
          await formatPatchStream.stdin.close();

          const stderrPromise = streamToString(formatPatchStream.stderr);
          const writePromise = writeReadableStreamToLocalFile(formatPatchStream.stdout, patchPath);

          const [exitCode, stderr] = await Promise.all([
            formatPatchStream.exitCode,
            stderrPromise,
            writePromise,
          ]);

          if (exitCode !== 0) {
            await fsPromises.rm(patchPath, { force: true });
            await ensureProjectArtifact({
              projectPath: projectRepo.projectPath,
              projectName: projectRepo.projectName,
              storageKey: projectRepo.storageKey,
              status: "failed",
              baseCommitSha,
              headCommitSha,
              commitCount,
              error: `git format-patch failed (exitCode=${exitCode}): ${stderr.trim() || "unknown error"}`,
            });
            continue;
          }

          await ensureProjectArtifact({
            projectPath: projectRepo.projectPath,
            projectName: projectRepo.projectName,
            storageKey: projectRepo.storageKey,
            status: "ready",
            baseCommitSha,
            headCommitSha,
            commitCount,
            mboxPath: patchPath,
          });
        } catch (error: unknown) {
          await ensureProjectArtifact({
            projectPath: projectRepo.projectPath,
            projectName: projectRepo.projectName,
            storageKey: projectRepo.storageKey,
            status: "failed",
            error: getErrorMessage(error),
          });
        }
      }
    } catch (error: unknown) {
      await updateArtifact((existing) =>
        failPendingProjectArtifacts({
          artifact:
            existing ??
            buildPendingPatchArtifact({
              childTaskId: childWorkspaceId,
              parentWorkspaceId,
              createdAtMs: nowMs,
              updatedAtMs: nowMs,
              projectArtifacts: [],
            }),
          error: getErrorMessage(error),
          updatedAtMs: Date.now(),
        })
      );
    } finally {
      // Unblock auto-cleanup once the patch generation attempt has finished.
      await onComplete(childWorkspaceId);
    }
  }
}

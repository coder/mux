import * as path from "node:path";
import assert from "node:assert/strict";
import * as fsPromises from "fs/promises";

import type { Config } from "@/node/config";
import type {
  SubagentGitPatchArtifact,
  SubagentGitProjectPatchArtifact,
} from "@/common/utils/tools/toolDefinitions";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { ProjectRef } from "@/common/types/workspace";
import {
  coerceNonEmptyString,
  tryReadGitHeadCommitSha,
  findWorkspaceEntry,
} from "@/node/services/taskUtils";
import { log } from "@/node/services/log";
import { parseGitStatusPorcelainZ } from "@/node/services/gitPatchPathParsing";
import { readAgentDefinition } from "@/node/services/agentDefinitions/agentDefinitionsService";
import { resolveAgentInheritanceChain } from "@/node/services/agentDefinitions/resolveAgentInheritanceChain";
import { isExecLikeEditingCapableInResolvedChain } from "@/common/utils/agentTools";
import {
  createRuntimeContextForWorkspace,
  createRuntimeForWorkspace,
  type WorkspaceRuntimeContext,
} from "@/node/runtime/runtimeHelpers";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { AgentIdSchema } from "@/common/orpc/schemas";
import { resolvePersistedAgentIdCandidates } from "@/common/utils/agentIds";
import {
  getSubagentGitPatchMboxPath,
  getSubagentGitPatchWorktreePatchPath,
  matchesProjectArtifactProjectPathForUpdate,
  upsertSubagentGitPatchArtifact,
} from "@/node/services/subagentGitPatchArtifacts";
import {
  SUBAGENT_WORKTREE_PATCH_MAX_BYTES,
  SUBAGENT_WORKTREE_PATCH_MAX_STAGED_BYTES,
} from "@/constants/subagentPatch";
import { shellQuote } from "@/common/utils/shell";
import { streamToString } from "@/node/runtime/streamUtils";
import { getErrorMessage } from "@/common/utils/errors";
import { PlatformPaths } from "@/common/utils/paths";
import { isPathInsideDir } from "@/node/utils/pathUtils";
import type { Runtime } from "@/node/runtime/Runtime";
import {
  getWorkspaceProjectRepos,
  getWorkspaceProjectStorageKeys,
} from "@/node/services/workspaceProjectRepos";

/** Callback invoked after patch generation completes (success or failure). */
export type OnPatchGenerationComplete = (childWorkspaceId: string) => Promise<void>;

async function writeReadableStreamToLocalFile(
  stream: ReadableStream<Uint8Array>,
  filePath: string,
  maxBytes?: number
): Promise<{ truncated: boolean }> {
  assert(filePath.length > 0, "writeReadableStreamToLocalFile: filePath must be non-empty");

  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });

  const fileHandle = await fsPromises.open(filePath, "w");
  let bytesWritten = 0;
  try {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          // Stop consuming once the cap is exceeded so an oversized stream
          // never lands on local disk, even transiently.
          if (maxBytes != null && bytesWritten + value.length > maxBytes) {
            await reader.cancel();
            return { truncated: true };
          }
          await fileHandle.write(value);
          bytesWritten += value.length;
        }
      }
    } finally {
      reader.releaseLock();
    }
  } finally {
    await fileHandle.close();
  }
  return { truncated: false };
}

async function writeRuntimeCommandOutputToLocalFile(params: {
  runtime: Runtime;
  command: string;
  cwd: string;
  timeout: number;
  filePath: string;
  maxBytes?: number;
}): Promise<{ exitCode: number; stderr: string; truncated: boolean }> {
  const stream = await params.runtime.exec(params.command, {
    cwd: params.cwd,
    timeout: params.timeout,
  });
  await stream.stdin.close();

  const stderrPromise = streamToString(stream.stderr);
  const writePromise = writeReadableStreamToLocalFile(
    stream.stdout,
    params.filePath,
    params.maxBytes
  );
  const [exitCode, stderr, writeResult] = await Promise.all([
    stream.exitCode,
    stderrPromise,
    writePromise,
  ]);
  return { exitCode, stderr, truncated: writeResult.truncated };
}

type WorktreeCaptureFields = Pick<
  SubagentGitProjectPatchArtifact,
  | "hadUncommittedChanges"
  | "worktreePatchPath"
  | "worktreePatchBytes"
  | "worktreePatchSkippedReason"
>;

/**
 * Best-effort list of submodule paths with uncommitted changes. Uncommitted
 * work inside a submodule cannot be represented in a superproject patch (the
 * temp-index capture stages only the unchanged gitlink), so callers report it
 * as uncaptured instead of claiming the diff was empty. Returns null when a
 * probe fails: the repository is already known dirty at that point, so an
 * unknown submodule state must surface as possibly-uncaptured work rather
 * than pass as "no dirty submodules".
 */
async function listDirtySubmodulePaths(params: {
  runtime: ReturnType<typeof createRuntimeForWorkspace>;
  repoCwd: string;
}): Promise<string[] | null> {
  // -z keeps paths verbatim: on line-oriented output core.quotePath wraps
  // exotic names (e.g. non-ASCII) in C-style quotes, and probing that quoted
  // literal matches nothing, silently missing the dirty submodule.
  const lsFilesResult = await execBuffered(params.runtime, "git ls-files -s -z", {
    cwd: params.repoCwd,
    timeout: 60,
  });
  if (lsFilesResult.exitCode !== 0) {
    log.debug("listDirtySubmodulePaths: ls-files probe failed", {
      repoCwd: params.repoCwd,
      stderr: lsFilesResult.stderr.trim(),
    });
    return null;
  }
  // Records are `<mode> <object> <stage>\t<path>`; gitlinks have mode 160000.
  const submodulePaths = lsFilesResult.stdout
    .split("\0")
    .filter((record) => record.startsWith("160000 "))
    .map((record) => record.slice(record.indexOf("\t") + 1));
  if (submodulePaths.length === 0) {
    return [];
  }
  const diffResult = await execBuffered(
    params.runtime,
    "git diff --name-only -z --ignore-submodules=none HEAD",
    { cwd: params.repoCwd, timeout: 60 }
  );
  if (diffResult.exitCode !== 0) {
    log.debug("listDirtySubmodulePaths: diff probe failed", {
      repoCwd: params.repoCwd,
      stderr: diffResult.stderr.trim(),
    });
    return null;
  }
  const changedPaths = new Set(diffResult.stdout.split("\0").filter((line) => line.length > 0));
  return submodulePaths.filter((subPath) => changedPaths.has(subPath));
}

/**
 * Untracked embedded git repositories show up in status as `?? dir/` and
 * would be staged by `git add -A` as a bare gitlink whose commit exists only
 * in the child's checkout, so their contents must be reported as uncaptured
 * and the gitlink kept out of the patch. Status is parsed from `-z` records
 * because core.quotePath wraps exotic names (e.g. containing spaces) in
 * quotes on the line-oriented output, which would hide them from the probe.
 * Returns null when a probe fails, so callers warn about possibly-uncaptured
 * embedded repositories instead of treating the failure as "none exist".
 */
async function listUntrackedEmbeddedRepoPaths(params: {
  runtime: ReturnType<typeof createRuntimeForWorkspace>;
  repoCwd: string;
}): Promise<string[] | null> {
  const statusResult = await execBuffered(
    params.runtime,
    "git status --porcelain -z --untracked-files=all",
    { cwd: params.repoCwd, timeout: 60 }
  );
  if (statusResult.exitCode !== 0) {
    log.debug("listUntrackedEmbeddedRepoPaths: status probe failed", {
      repoCwd: params.repoCwd,
      stderr: statusResult.stderr.trim(),
    });
    return null;
  }
  // Even with --untracked-files=all, git will not descend into a directory
  // that is itself a repository, so embedded repos surface as `?? dir/`.
  const candidateDirs = parseGitStatusPorcelainZ(statusResult.stdout)
    .filter((entry) => entry.status === "??" && entry.path.endsWith("/"))
    .map((entry) => entry.path);
  if (candidateDirs.length === 0) {
    return [];
  }

  const probeCommand = candidateDirs
    .map(
      (dir) =>
        `if [ -e ${shellQuote(`${dir}.git`)} ]; then printf '%s\\0' ${shellQuote(dir.replace(/\/+$/, ""))}; fi`
    )
    .join("\n");
  const result = await execBuffered(params.runtime, probeCommand, {
    cwd: params.repoCwd,
    timeout: 60,
  });
  if (result.exitCode !== 0) {
    log.debug("listUntrackedEmbeddedRepoPaths: .git probe failed", {
      repoCwd: params.repoCwd,
      stderr: result.stderr.trim(),
    });
    return null;
  }
  return result.stdout.split("\0").filter((line) => line.length > 0);
}

/**
 * Never rejects: a runtime/filesystem failure mid-capture must not bubble to
 * the generate error path with empty capture fields, because cleanup would
 * then remove a possibly-dirty child with no warning recorded.
 */
async function captureWorktreeDiff(params: {
  runtime: ReturnType<typeof createRuntimeForWorkspace>;
  repoCwd: string;
  localPatchPath: string;
  maxBytes: number;
  maxStagedBytes: number;
}): Promise<WorktreeCaptureFields> {
  try {
    return await captureWorktreeDiffUnsafe(params);
  } catch (error: unknown) {
    log.warn("captureWorktreeDiff: capture failed", {
      repoCwd: params.repoCwd,
      error: getErrorMessage(error),
    });
    // The exception may have fired after the patch file was created (e.g. a
    // stream failure mid-write), and the apply path probes this canonical
    // location even without metadata, so a leftover incomplete file would
    // be applied as if it were a complete capture. Removal is best-effort:
    // this recovery path must never reject.
    await fsPromises.rm(params.localPatchPath, { force: true }).catch(() => undefined);
    return {
      hadUncommittedChanges: true,
      worktreePatchSkippedReason: `Could not capture uncommitted changes (${getErrorMessage(error)}); any uncommitted work was NOT captured.`,
    };
  }
}

/** Uses a temporary index so capture never mutates the child's index or worktree. */
async function captureWorktreeDiffUnsafe(params: {
  runtime: ReturnType<typeof createRuntimeForWorkspace>;
  repoCwd: string;
  localPatchPath: string;
  maxBytes: number;
  maxStagedBytes: number;
}): Promise<WorktreeCaptureFields> {
  const statusResult = await execBuffered(
    params.runtime,
    "git status --porcelain -z --untracked-files=all",
    { cwd: params.repoCwd, timeout: 60 }
  );
  if (statusResult.exitCode !== 0) {
    log.warn("captureWorktreeDiff: git status failed; skipping worktree capture", {
      repoCwd: params.repoCwd,
      stderr: statusResult.stderr.trim(),
    });
    // Unknown dirty state must not read as clean: cleanup would silently
    // discard any uncommitted work, so warn the parent explicitly.
    // Invariant: every exit that records no worktreePatchPath leaves no file
    // at the canonical path. A stale patch from a capture that crashed
    // before recording metadata would otherwise be found by apply-side
    // canonical probing and re-apply outdated changes.
    await fsPromises.rm(params.localPatchPath, { force: true });
    return {
      hadUncommittedChanges: true,
      worktreePatchSkippedReason: `Could not inspect the worktree for uncommitted changes (git status failed: ${statusResult.stderr.trim() || "unknown error"}); any uncommitted work was NOT captured.`,
    };
  }
  if (statusResult.stdout.trim().length === 0) {
    // Same invariant: the work may have been committed since a crashed
    // capture wrote the file, and the regenerated commit series already
    // contains it.
    await fsPromises.rm(params.localPatchPath, { force: true });
    return {};
  }

  const dirtySubmodulePaths = await listDirtySubmodulePaths({
    runtime: params.runtime,
    repoCwd: params.repoCwd,
  });
  const embeddedRepoPaths = await listUntrackedEmbeddedRepoPaths({
    runtime: params.runtime,
    repoCwd: params.repoCwd,
  });
  // Unknown gitlink discovery must skip capture entirely: with no exclusion
  // list, the later `git add -A` would stage any moved submodule or embedded
  // repo gitlink, emitting a patch that references a commit no target can
  // fetch once child cleanup removes the only repository containing it.
  if (dirtySubmodulePaths == null || embeddedRepoPaths == null) {
    await fsPromises.rm(params.localPatchPath, { force: true });
    const probeFailureReasons = [
      dirtySubmodulePaths == null
        ? "Could not determine whether submodules contain uncommitted changes (probe failed)."
        : undefined,
      embeddedRepoPaths == null
        ? "Could not determine whether untracked embedded git repositories exist (probe failed)."
        : undefined,
    ].filter((reason): reason is string => reason != null);
    return {
      hadUncommittedChanges: true,
      worktreePatchSkippedReason: [
        ...probeFailureReasons,
        "The uncommitted changes were not captured.",
      ].join(" "),
    };
  }
  const skipReasons = [
    dirtySubmodulePaths.length > 0
      ? `Uncommitted changes inside submodule(s) ${dirtySubmodulePaths.join(", ")} were NOT captured: submodule contents cannot be represented in a superproject patch.`
      : undefined,
    embeddedRepoPaths.length > 0
      ? `Untracked embedded git repository(ies) ${embeddedRepoPaths.join(", ")} were NOT captured: their contents cannot be represented in a superproject patch.`
      : undefined,
  ].filter((reason): reason is string => reason != null);
  const submoduleSkipReason = skipReasons.length > 0 ? skipReasons.join(" ") : undefined;

  // `git add` writes whole blobs before the capped diff stream produces any
  // output, so the diff byte cap alone does not bound disk usage: a
  // multi-gigabyte dirty file would fill the temporary object dir (and /tmp)
  // before truncation is detected. Preflight the on-disk size of every dirty
  // path and skip capture when staging would exceed the bound. Excluded
  // submodule/embedded-repo paths are directories and are not staged, so
  // they do not count. A preflight exec failure throws into the outer
  // captureWorktreeDiff handler, which reports a conservative
  // uncaptured-work skip.
  const excludedRoots = [...dirtySubmodulePaths, ...embeddedRepoPaths].map((repoPath) =>
    repoPath.replace(/\/+$/, "")
  );
  const isExcludedPath = (filePath: string): boolean => {
    const normalized = filePath.replace(/\/+$/, "");
    return excludedRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
  };
  const candidatePaths = [
    ...new Set(
      parseGitStatusPorcelainZ(statusResult.stdout)
        .map((entry) => entry.path)
        .filter((filePath) => !isExcludedPath(filePath))
    ),
  ];
  let stagedBytes = 0;
  let batch: string[] = [];
  let batchLength = 0;
  const runDuBatch = async (): Promise<void> => {
    if (batch.length === 0) {
      return;
    }
    // du stats rather than reads, so the preflight itself is cheap. -s
    // prints one line per argument (no subdirectory lines to double count).
    const duResult = await execBuffered(params.runtime, `du -sk -- ${batch.join(" ")}`, {
      cwd: params.repoCwd,
      timeout: 60,
    });
    let probeStdout = duResult.stdout;
    if (duResult.exitCode !== 0) {
      // Missing paths (deletions, races) are the only tolerated failure:
      // rerun per path, skipping paths that no longer exist. Any du failure
      // on a path that still exists (du unavailable, unreadable dirs) must
      // throw into the outer captureWorktreeDiff handler, which reports an
      // uncaptured-work skip; reading a failed probe as "small" would let a
      // multi-gigabyte dirty file through to `git add`.
      const fallbackResult = await execBuffered(
        params.runtime,
        `ex=0; for p in ${batch.join(" ")}; do if [ -e "$p" ] || [ -L "$p" ]; then du -sk -- "$p" || ex=1; fi; done; exit $ex`,
        { cwd: params.repoCwd, timeout: 60 }
      );
      if (fallbackResult.exitCode !== 0) {
        throw new Error(
          `staging-size preflight failed: ${
            fallbackResult.stderr.trim() || duResult.stderr.trim() || "du failed"
          }`
        );
      }
      probeStdout = fallbackResult.stdout;
    }
    for (const line of probeStdout.split("\n")) {
      const sizeMatch = /^(\d+)\s/.exec(line);
      if (sizeMatch != null) {
        stagedBytes += Number(sizeMatch[1]) * 1024;
      }
    }
    batch = [];
    batchLength = 0;
  };
  for (const filePath of candidatePaths) {
    const quoted = shellQuote(filePath);
    if (batchLength + quoted.length + 1 > 60_000) {
      await runDuBatch();
      if (stagedBytes > params.maxStagedBytes) {
        break;
      }
    }
    batch.push(quoted);
    batchLength += quoted.length + 1;
  }
  if (stagedBytes <= params.maxStagedBytes) {
    await runDuBatch();
  }
  if (stagedBytes > params.maxStagedBytes) {
    await fsPromises.rm(params.localPatchPath, { force: true });
    return {
      hadUncommittedChanges: true,
      worktreePatchSkippedReason: [
        `Uncommitted files total ${stagedBytes} bytes on disk, exceeding the ${params.maxStagedBytes}-byte staging bound; the uncommitted changes were not captured.`,
        submoduleSkipReason,
      ]
        .filter((reason): reason is string => reason != null)
        .join(" "),
    };
  }

  // Excluding embedded repos keeps their gitlinks (which reference commits
  // that exist only in the child's checkout) out of the patch. Dirty tracked
  // submodules are excluded for the same reason: `git add -A` would stage
  // their moved gitlink, and a submodule commit that exists only in the
  // child's clone becomes unfetchable once cleanup removes the child, so the
  // applied patch would point the target at an unavailable commit. `literal`
  // magic keeps a name like `nested*repo` from glob-matching dirty sibling
  // paths, which would silently drop them from the patch.
  const gitlinkExcludes = [...dirtySubmodulePaths, ...embeddedRepoPaths]
    .map((repoPath) => ` ${shellQuote(`:(exclude,literal)${repoPath}`)}`)
    .join("");
  const diffCommand = [
    "set -e",
    'TMP_INDEX="$(mktemp)"',
    // `git add` writes whole blobs before the diff stream (and its byte cap)
    // produces any output, so staged objects go to a throwaway object dir:
    // a huge dirty file must not permanently grow the repo's object store.
    'TMP_OBJECTS="$(mktemp -d)"',
    'trap \'rm -f "$TMP_INDEX"; rm -rf "$TMP_OBJECTS"\' EXIT',
    'REAL_OBJECTS="$(cd "$(git rev-parse --git-path objects)" && pwd)"',
    'export GIT_OBJECT_DIRECTORY="$TMP_OBJECTS"',
    'export GIT_ALTERNATE_OBJECT_DIRECTORIES="$REAL_OBJECTS"',
    'GIT_INDEX_FILE="$TMP_INDEX" git read-tree HEAD',
    `GIT_INDEX_FILE="$TMP_INDEX" git add -A -- .${gitlinkExcludes}`,
    // Explicit prefixes: user config like diff.noprefix=true would emit
    // headers the later default `git apply` cannot consume.
    'GIT_INDEX_FILE="$TMP_INDEX" git diff --src-prefix=a/ --dst-prefix=b/ --cached --binary HEAD --',
  ].join("\n");

  const { exitCode, stderr, truncated } = await writeRuntimeCommandOutputToLocalFile({
    runtime: params.runtime,
    command: diffCommand,
    cwd: params.repoCwd,
    timeout: 120,
    filePath: params.localPatchPath,
    maxBytes: params.maxBytes,
  });

  // Check truncation before the exit code: cancelling the stdout stream can
  // make the diff command exit non-zero (EPIPE), and the size skip is the
  // more accurate report in that case.
  if (truncated) {
    await fsPromises.rm(params.localPatchPath, { force: true });
    return {
      hadUncommittedChanges: true,
      worktreePatchSkippedReason: `Uncommitted worktree diff exceeds the ${params.maxBytes}-byte capture cap; the uncommitted changes were not captured.`,
    };
  }

  if (exitCode !== 0) {
    await fsPromises.rm(params.localPatchPath, { force: true });
    return {
      hadUncommittedChanges: true,
      worktreePatchSkippedReason: `git diff for uncommitted changes failed (exitCode=${exitCode}): ${stderr.trim() || "unknown error"}`,
    };
  }

  const stat = await fsPromises.stat(params.localPatchPath);
  if (stat.size === 0) {
    await fsPromises.rm(params.localPatchPath, { force: true });
    return {
      hadUncommittedChanges: true,
      worktreePatchSkippedReason:
        submoduleSkipReason ??
        "Worktree reported uncommitted changes but the diff against HEAD was empty.",
    };
  }

  return {
    hadUncommittedChanges: true,
    worktreePatchPath: params.localPatchPath,
    worktreePatchBytes: stat.size,
    // Partial capture: the superproject patch exists, but dirty submodule
    // contents are still lost; surface that alongside the patch.
    ...(submoduleSkipReason != null ? { worktreePatchSkippedReason: submoduleSkipReason } : {}),
  };
}

function getPrimaryProjectName(projectPath: string, projects?: ProjectRef[]): string {
  const matchingProjectName = projects
    ?.find((project) => project.projectPath.trim() === projectPath.trim())
    ?.projectName?.trim();
  return matchingProjectName && matchingProjectName.length > 0
    ? matchingProjectName
    : PlatformPaths.getProjectName(projectPath).trim();
}

function createAgentDiscoveryContext(
  entry: ReturnType<typeof findWorkspaceEntry>
): WorkspaceRuntimeContext | undefined {
  const workspace = entry?.workspace;
  const workspacePath = coerceNonEmptyString(workspace?.path);
  const workspaceName =
    coerceNonEmptyString(workspace?.name) ??
    (workspacePath == null ? undefined : PlatformPaths.getProjectName(workspacePath));
  if (entry == null || workspace == null || workspaceName == null) {
    return undefined;
  }

  const metadata = {
    runtimeConfig: workspace.runtimeConfig ?? DEFAULT_RUNTIME_CONFIG,
    projectPath: entry.projectPath,
    name: workspaceName,
    namedWorkspacePath: workspacePath,
  };

  try {
    return createRuntimeContextForWorkspace(metadata);
  } catch {
    // Older task records/tests can pair a project-dir local runtime with a child worktree path.
    // Fall back to the pre-existing persisted-path behavior rather than blocking patch cleanup.
    const runtime = createRuntimeForWorkspace(metadata);
    return {
      runtime,
      workspacePath: workspacePath ?? runtime.getWorkspacePath(entry.projectPath, workspaceName),
    };
  }
}

async function resolveAgentEditingCapability(args: {
  discoveryContexts: readonly WorkspaceRuntimeContext[];
  agentId: string;
  workspaceId: string;
}): Promise<{ editingCapable: boolean; projectScoped: boolean } | undefined> {
  const parsedAgentId = AgentIdSchema.safeParse(args.agentId);
  if (!parsedAgentId.success) {
    return undefined;
  }

  let fallbackChain: Awaited<ReturnType<typeof resolveAgentInheritanceChain>> | undefined;

  for (const discovery of args.discoveryContexts) {
    try {
      const agentDefinition = await readAgentDefinition(
        discovery.runtime,
        discovery.workspacePath,
        parsedAgentId.data
      );
      const chain = await resolveAgentInheritanceChain({
        runtime: discovery.runtime,
        workspacePath: discovery.workspacePath,
        agentId: agentDefinition.id,
        agentDefinition,
        workspaceId: args.workspaceId,
      });

      if (agentDefinition.scope === "project") {
        return {
          editingCapable: isExecLikeEditingCapableInResolvedChain(chain),
          projectScoped: true,
        };
      }
      fallbackChain ??= chain;
    } catch {
      // Try the next discovery context before falling back to global/built-in definitions.
    }
  }

  return fallbackChain == null
    ? undefined
    : {
        editingCapable: isExecLikeEditingCapableInResolvedChain(fallbackChain),
        projectScoped: false,
      };
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

  return getWorkspaceProjectStorageKeys({
    projectPath: params.projectPath,
    projectName: getPrimaryProjectName(params.projectPath),
    projects: projectRefs,
  }).map(
    (project) =>
      ({
        projectPath: project.projectPath,
        projectName: project.projectName,
        storageKey: project.storageKey,
        status: "pending",
        baseCommitSha: baseCommitShaByProjectPath[project.projectPath] || undefined,
      }) satisfies SubagentGitProjectPatchArtifact
  );
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

  constructor(
    private readonly config: Config,
    private readonly worktreePatchMaxBytes: number = SUBAGENT_WORKTREE_PATCH_MAX_BYTES,
    private readonly worktreePatchMaxStagedBytes: number = SUBAGENT_WORKTREE_PATCH_MAX_STAGED_BYTES
  ) {}

  /**
   * Whether this child task is expected to produce a patch artifact. Only
   * exec-like subagents are expected to make commits that should be handed
   * back to the parent. NOTE: Custom agents can inherit from exec
   * (base: exec). Those should also generate patches, but read-only
   * subagents (e.g. explore) should not. Cleanup uses the same predicate:
   * a patch-eligible task with NO artifact on disk means the pending-marker
   * write failed, and deleting the workspace would destroy unrecorded work.
   */
  async shouldGeneratePatchForTask(
    parentWorkspaceId: string,
    childWorkspaceId: string
  ): Promise<boolean> {
    const cfg = this.config.loadConfigOrDefault();
    const childEntry = findWorkspaceEntry(cfg, childWorkspaceId);

    if (!childEntry || childEntry.workspace.kind === "scratch") {
      return false;
    }

    const childAgentIds = resolvePersistedAgentIdCandidates(childEntry.workspace);
    if (childAgentIds.length === 0) {
      return false;
    }

    const discoveryContexts = [
      createAgentDiscoveryContext(childEntry),
      createAgentDiscoveryContext(findWorkspaceEntry(cfg, parentWorkspaceId)),
    ].filter((context): context is WorkspaceRuntimeContext => context != null);

    for (const childAgentId of childAgentIds) {
      const editingCapability = await resolveAgentEditingCapability({
        discoveryContexts,
        agentId: childAgentId,
        workspaceId: childWorkspaceId,
      });
      if (editingCapability == null) {
        continue;
      }
      return editingCapability.editingCapable;
    }
    return false;
  }

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

    if (
      !childEntry ||
      !(await this.shouldGeneratePatchForTask(parentWorkspaceId, childWorkspaceId))
    ) {
      return;
    }

    const pendingProjectArtifacts = buildPendingProjectArtifacts({
      projectPath: childEntry.projectPath,
      projects: childEntry.workspace.projects,
      taskBaseCommitSha: coerceNonEmptyString(childEntry.workspace.taskBaseCommitSha) ?? undefined,
      taskBaseCommitShaByProjectPath: childEntry.workspace.taskBaseCommitShaByProjectPath,
    });

    // The pending marker is what defers cleanup while generation runs, and
    // it is the index entry every later metadata write updates. If it never
    // lands on disk, generation must not proceed: capture would write files
    // no index entry references, and cleanup would read "no artifact" and
    // delete the child workspace with its work unrecorded. Propagate the
    // failure so callers log it and cleanup stays deferred (the eligibility
    // gate in canCleanupReportedTask fails closed on a missing artifact).
    const artifact = await upsertSubagentGitPatchArtifact({
      workspaceId: parentWorkspaceId,
      workspaceSessionDir: parentSessionDir,
      childTaskId: childWorkspaceId,
      propagateWriteErrors: true,
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
        // Hoisted so failure branches below still surface dirty-worktree metadata.
        let worktreeCapture: WorktreeCaptureFields = {};
        try {
          // Capture dirty work FIRST: commit-metadata resolution below can
          // fail, and cleanup runs after generate() regardless, so a failed
          // artifact must still record (and preserve) uncommitted changes.
          const worktreePatchPath = getSubagentGitPatchWorktreePatchPath(
            parentSessionDir,
            childWorkspaceId,
            projectRepo.storageKey
          );
          worktreeCapture = isPathInsideDir(parentSessionDir, worktreePatchPath)
            ? await captureWorktreeDiff({
                runtime,
                repoCwd: projectRepo.repoCwd,
                localPatchPath: worktreePatchPath,
                maxBytes: this.worktreePatchMaxBytes,
                maxStagedBytes: this.worktreePatchMaxStagedBytes,
              })
            : {};

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
                ...worktreeCapture,
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
                ...worktreeCapture,
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
              ...worktreeCapture,
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
              ...worktreeCapture,
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
              ...worktreeCapture,
            });
            continue;
          }

          if (commitCount === 0) {
            await ensureProjectArtifact({
              projectPath: projectRepo.projectPath,
              projectName: projectRepo.projectName,
              storageKey: projectRepo.storageKey,
              status: worktreeCapture.worktreePatchPath != null ? "ready" : "skipped",
              baseCommitSha,
              headCommitSha,
              commitCount,
              ...worktreeCapture,
            });
            continue;
          }

          const patchPath = getSubagentGitPatchMboxPath(
            parentSessionDir,
            childWorkspaceId,
            projectRepo.storageKey
          );

          if (!isPathInsideDir(parentSessionDir, patchPath)) {
            await ensureProjectArtifact({
              projectPath: projectRepo.projectPath,
              projectName: projectRepo.projectName,
              storageKey: projectRepo.storageKey,
              status: "failed",
              baseCommitSha,
              headCommitSha,
              commitCount,
              error: `Refusing to write patch outside session dir for storage key ${projectRepo.storageKey}.`,
              ...worktreeCapture,
            });
            continue;
          }

          const { exitCode, stderr } = await writeRuntimeCommandOutputToLocalFile({
            runtime,
            command: `git format-patch --stdout --binary ${baseCommitSha}..${headCommitSha}`,
            cwd: projectRepo.repoCwd,
            timeout: 120,
            filePath: patchPath,
          });

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
              ...worktreeCapture,
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
            ...worktreeCapture,
          });
        } catch (error: unknown) {
          await ensureProjectArtifact({
            projectPath: projectRepo.projectPath,
            projectName: projectRepo.projectName,
            storageKey: projectRepo.storageKey,
            status: "failed",
            error: getErrorMessage(error),
            ...worktreeCapture,
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

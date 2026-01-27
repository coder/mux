import * as fsPromises from "fs/promises";
import * as path from "node:path";

import writeFileAtomic from "write-file-atomic";

import type { SubagentGitPatchArtifact } from "@/common/utils/tools/toolDefinitions";
import { log } from "@/node/services/log";
import { workspaceFileLocks } from "@/node/utils/concurrency/workspaceFileLocks";

export interface SubagentGitPatchArtifactsFile {
  version: 1;
  artifactsByChildTaskId: Record<string, SubagentGitPatchArtifact>;
}

const SUBAGENT_GIT_PATCH_ARTIFACTS_FILE_VERSION = 1 as const;

const SUBAGENT_GIT_PATCH_ARTIFACTS_FILE_NAME = "subagent-patches.json";
const SUBAGENT_GIT_PATCH_DIR_NAME = "subagent-patches";
const SUBAGENT_GIT_PATCH_MBOX_FILE_NAME = "series.mbox";

export function getSubagentGitPatchArtifactsFilePath(workspaceSessionDir: string): string {
  return path.join(workspaceSessionDir, SUBAGENT_GIT_PATCH_ARTIFACTS_FILE_NAME);
}

export function getSubagentGitPatchMboxPath(
  workspaceSessionDir: string,
  childTaskId: string
): string {
  return path.join(
    workspaceSessionDir,
    SUBAGENT_GIT_PATCH_DIR_NAME,
    childTaskId,
    SUBAGENT_GIT_PATCH_MBOX_FILE_NAME
  );
}

export async function readSubagentGitPatchArtifactsFile(
  workspaceSessionDir: string
): Promise<SubagentGitPatchArtifactsFile> {
  try {
    const filePath = getSubagentGitPatchArtifactsFilePath(workspaceSessionDir);
    const raw = await fsPromises.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;

    if (!parsed || typeof parsed !== "object") {
      return { version: SUBAGENT_GIT_PATCH_ARTIFACTS_FILE_VERSION, artifactsByChildTaskId: {} };
    }

    const obj = parsed as {
      version?: unknown;
      artifactsByChildTaskId?: unknown;
    };

    const version = obj.version;
    const artifactsByChildTaskId = obj.artifactsByChildTaskId;

    if (version !== SUBAGENT_GIT_PATCH_ARTIFACTS_FILE_VERSION) {
      // Unknown version; treat as empty.
      return { version: SUBAGENT_GIT_PATCH_ARTIFACTS_FILE_VERSION, artifactsByChildTaskId: {} };
    }

    if (!artifactsByChildTaskId || typeof artifactsByChildTaskId !== "object") {
      return { version: SUBAGENT_GIT_PATCH_ARTIFACTS_FILE_VERSION, artifactsByChildTaskId: {} };
    }

    return {
      version: SUBAGENT_GIT_PATCH_ARTIFACTS_FILE_VERSION,
      artifactsByChildTaskId: artifactsByChildTaskId as Record<string, SubagentGitPatchArtifact>,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { version: SUBAGENT_GIT_PATCH_ARTIFACTS_FILE_VERSION, artifactsByChildTaskId: {} };
    }

    log.error("Failed to read subagent git patch artifacts file", { error });
    return { version: SUBAGENT_GIT_PATCH_ARTIFACTS_FILE_VERSION, artifactsByChildTaskId: {} };
  }
}

export async function readSubagentGitPatchArtifact(
  workspaceSessionDir: string,
  childTaskId: string
): Promise<SubagentGitPatchArtifact | null> {
  const file = await readSubagentGitPatchArtifactsFile(workspaceSessionDir);
  return file.artifactsByChildTaskId[childTaskId] ?? null;
}

export async function updateSubagentGitPatchArtifactsFile(params: {
  workspaceId: string;
  workspaceSessionDir: string;
  update: (file: SubagentGitPatchArtifactsFile) => void;
}): Promise<SubagentGitPatchArtifactsFile> {
  return workspaceFileLocks.withLock(params.workspaceId, async () => {
    const file = await readSubagentGitPatchArtifactsFile(params.workspaceSessionDir);
    params.update(file);
    try {
      await fsPromises.mkdir(params.workspaceSessionDir, { recursive: true });
      const filePath = getSubagentGitPatchArtifactsFilePath(params.workspaceSessionDir);
      await writeFileAtomic(filePath, JSON.stringify(file, null, 2));
    } catch (error) {
      log.error("Failed to write subagent git patch artifacts file", { error });
    }
    return file;
  });
}

export async function upsertSubagentGitPatchArtifact(params: {
  workspaceId: string;
  workspaceSessionDir: string;
  childTaskId: string;
  updater: (existing: SubagentGitPatchArtifact | null) => SubagentGitPatchArtifact;
}): Promise<SubagentGitPatchArtifact> {
  let updated: SubagentGitPatchArtifact | null = null;

  await updateSubagentGitPatchArtifactsFile({
    workspaceId: params.workspaceId,
    workspaceSessionDir: params.workspaceSessionDir,
    update: (file) => {
      const existing = file.artifactsByChildTaskId[params.childTaskId] ?? null;
      updated = params.updater(existing);
      file.artifactsByChildTaskId[params.childTaskId] = updated;
    },
  });

  if (!updated) {
    throw new Error("upsertSubagentGitPatchArtifact: updater returned no artifact");
  }

  return updated;
}

export async function markSubagentGitPatchArtifactApplied(params: {
  workspaceId: string;
  workspaceSessionDir: string;
  childTaskId: string;
  appliedAtMs: number;
}): Promise<SubagentGitPatchArtifact | null> {
  let updated: SubagentGitPatchArtifact | null = null;

  await updateSubagentGitPatchArtifactsFile({
    workspaceId: params.workspaceId,
    workspaceSessionDir: params.workspaceSessionDir,
    update: (file) => {
      const existing = file.artifactsByChildTaskId[params.childTaskId] ?? null;
      if (!existing) {
        updated = null;
        return;
      }

      updated = {
        ...existing,
        appliedAtMs: params.appliedAtMs,
        updatedAtMs: params.appliedAtMs,
      };
      file.artifactsByChildTaskId[params.childTaskId] = updated;
    },
  });

  return updated;
}

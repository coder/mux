import assert from "node:assert/strict";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { CHAT_FILE_NAME } from "./etl";

const SUBAGENT_TRANSCRIPTS_DIR_NAME = "subagent-transcripts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  if (value.trim().length === 0) {
    return null;
  }

  return value;
}

export async function listSessionWorkspaceIdsWithHistory(sessionsDir: string): Promise<string[]> {
  assert(
    sessionsDir.trim().length > 0,
    "listSessionWorkspaceIdsWithHistory requires a non-empty sessionsDir"
  );

  let entries: Dirent[];

  try {
    entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const sessionWorkspaceIds: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const chatPath = path.join(sessionsDir, entry.name, CHAT_FILE_NAME);

    try {
      const chatStat = await fs.stat(chatPath);
      if (chatStat.isFile()) {
        const workspaceId = parseNonEmptyString(entry.name);
        assert(
          workspaceId !== null,
          "listSessionWorkspaceIdsWithHistory expected workspace directory names to be non-empty"
        );
        sessionWorkspaceIds.push(workspaceId);
      }
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") {
        continue;
      }

      throw error;
    }
  }

  return sessionWorkspaceIds;
}

export async function listArchivedSubagentWorkspaceIds(
  sessionsDir: string,
  parentWorkspaceIds: readonly string[]
): Promise<string[]> {
  assert(
    sessionsDir.trim().length > 0,
    "listArchivedSubagentWorkspaceIds requires a non-empty sessionsDir"
  );

  const archivedWorkspaceIds = new Set<string>();

  for (const parentWorkspaceId of parentWorkspaceIds) {
    const normalizedParentWorkspaceId = parseNonEmptyString(parentWorkspaceId);
    assert(
      normalizedParentWorkspaceId !== null,
      "listArchivedSubagentWorkspaceIds expected non-empty parent workspace IDs"
    );

    const transcriptsDir = path.join(
      sessionsDir,
      normalizedParentWorkspaceId,
      SUBAGENT_TRANSCRIPTS_DIR_NAME
    );

    let entries: Dirent[];
    try {
      entries = await fs.readdir(transcriptsDir, { withFileTypes: true });
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") {
        continue;
      }

      log.warn("[analytics-worker] Failed to read archived sub-agent transcript directory", {
        transcriptsDir,
        parentWorkspaceId: normalizedParentWorkspaceId,
        error: getErrorMessage(error),
      });
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const workspaceId = parseNonEmptyString(entry.name);
      assert(
        workspaceId !== null,
        "listArchivedSubagentWorkspaceIds expected archived workspace IDs to be non-empty"
      );

      const chatPath = path.join(transcriptsDir, workspaceId, CHAT_FILE_NAME);

      try {
        const chatStat = await fs.stat(chatPath);
        if (chatStat.isFile()) {
          archivedWorkspaceIds.add(workspaceId);
        }
      } catch (error) {
        if (isRecord(error) && error.code === "ENOENT") {
          continue;
        }

        log.warn("[analytics-worker] Failed to stat archived sub-agent transcript chat file", {
          chatPath,
          archivedWorkspaceId: workspaceId,
          parentWorkspaceId: normalizedParentWorkspaceId,
          error: getErrorMessage(error),
        });
        continue;
      }
    }
  }

  return [...archivedWorkspaceIds];
}

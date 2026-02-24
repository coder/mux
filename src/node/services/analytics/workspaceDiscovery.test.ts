import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { log } from "@/node/services/log";
import { CHAT_FILE_NAME } from "./etl";
import {
  listArchivedSubagentWorkspaceIds,
  listSessionWorkspaceIdsWithHistory,
} from "./workspaceDiscovery";

const SUBAGENT_TRANSCRIPTS_DIR_NAME = "subagent-transcripts";
const tempDirsToClean: string[] = [];

async function createTempSessionsDir(): Promise<string> {
  const sessionsDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "mux-analytics-workspace-discovery-")
  );
  tempDirsToClean.push(sessionsDir);
  return sessionsDir;
}

async function writeChatJsonl(sessionDir: string): Promise<void> {
  await fs.writeFile(path.join(sessionDir, CHAT_FILE_NAME), "{}\n");
}

afterEach(async () => {
  await Promise.all(
    tempDirsToClean.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

describe("listSessionWorkspaceIdsWithHistory", () => {
  test("returns only top-level workspace directories with chat.jsonl", async () => {
    const sessionsDir = await createTempSessionsDir();
    const workspaceWithHistory = "workspace-a";

    const workspaceWithHistoryDir = path.join(sessionsDir, workspaceWithHistory);
    await fs.mkdir(workspaceWithHistoryDir, { recursive: true });
    await writeChatJsonl(workspaceWithHistoryDir);

    await fs.mkdir(path.join(sessionsDir, "workspace-without-history"), { recursive: true });
    await fs.writeFile(path.join(sessionsDir, "README.txt"), "not a workspace directory");

    expect(await listSessionWorkspaceIdsWithHistory(sessionsDir)).toEqual([workspaceWithHistory]);
  });

  test("returns an empty list when sessionsDir does not exist", async () => {
    const missingSessionsDir = path.join(
      os.tmpdir(),
      `mux-analytics-workspace-discovery-missing-${process.pid}-${randomUUID()}`
    );

    expect(await listSessionWorkspaceIdsWithHistory(missingSessionsDir)).toEqual([]);
  });
});

describe("listArchivedSubagentWorkspaceIds", () => {
  test("discovers archived child workspace IDs under each parent workspace", async () => {
    const sessionsDir = await createTempSessionsDir();
    const parentWorkspaceId = "parent-a";
    const childWorkspaceId = "child-a";

    const parentSessionDir = path.join(sessionsDir, parentWorkspaceId);
    await fs.mkdir(parentSessionDir, { recursive: true });
    await writeChatJsonl(parentSessionDir);

    const archivedChildDir = path.join(
      parentSessionDir,
      SUBAGENT_TRANSCRIPTS_DIR_NAME,
      childWorkspaceId
    );
    await fs.mkdir(archivedChildDir, { recursive: true });
    await writeChatJsonl(archivedChildDir);

    const sessionWorkspaceIds = await listSessionWorkspaceIdsWithHistory(sessionsDir);
    expect(sessionWorkspaceIds).toEqual([parentWorkspaceId]);

    const archivedWorkspaceIds = await listArchivedSubagentWorkspaceIds(
      sessionsDir,
      sessionWorkspaceIds
    );
    expect(archivedWorkspaceIds).toEqual([childWorkspaceId]);

    // This mirrors the startup backfill check: archived child workspace IDs must
    // count as known so their watermark rows do not trigger rebuildAll loops.
    const knownWorkspaceIdSet = new Set([...sessionWorkspaceIds, ...archivedWorkspaceIds]);
    expect(knownWorkspaceIdSet.has(childWorkspaceId)).toBe(true);
  });

  test("skips unreadable archived transcript directories instead of throwing", async () => {
    const sessionsDir = await createTempSessionsDir();
    const parentWorkspaceId = "parent-a";

    const parentSessionDir = path.join(sessionsDir, parentWorkspaceId);
    await fs.mkdir(parentSessionDir, { recursive: true });
    await writeChatJsonl(parentSessionDir);

    const transcriptsDir = path.join(parentSessionDir, SUBAGENT_TRANSCRIPTS_DIR_NAME);
    await fs.mkdir(transcriptsDir, { recursive: true });

    const originalReaddir = fs.readdir;
    const readdirSpy = spyOn(fs, "readdir").mockImplementation(((...args: unknown[]) => {
      const [targetPath] = args;
      if (String(targetPath) === transcriptsDir) {
        const permissionError = Object.assign(new Error("permission denied"), {
          code: "EACCES",
        });
        return Promise.reject(permissionError);
      }

      return (originalReaddir as (...readdirArgs: unknown[]) => Promise<unknown>)(...args);
    }) as unknown as typeof fs.readdir);
    const warnSpy = spyOn(log, "warn").mockImplementation(() => undefined);

    try {
      const archivedWorkspaceIds = await listArchivedSubagentWorkspaceIds(sessionsDir, [
        parentWorkspaceId,
      ]);
      expect(archivedWorkspaceIds).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      readdirSpy.mockRestore();
    }
  });

  test("ignores archived sub-agent directories without chat.jsonl", async () => {
    const sessionsDir = await createTempSessionsDir();
    const parentWorkspaceId = "parent-a";

    const parentSessionDir = path.join(sessionsDir, parentWorkspaceId);
    await fs.mkdir(parentSessionDir, { recursive: true });
    await writeChatJsonl(parentSessionDir);

    const archivedWithoutHistoryDir = path.join(
      parentSessionDir,
      SUBAGENT_TRANSCRIPTS_DIR_NAME,
      "child-without-history"
    );
    await fs.mkdir(archivedWithoutHistoryDir, { recursive: true });

    expect(await listArchivedSubagentWorkspaceIds(sessionsDir, [parentWorkspaceId])).toEqual([]);
  });
});

import * as path from "path";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import { spawn } from "child_process";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import {
  shouldRunIntegrationTests,
  createTestEnvironment,
  createTestEnvironmentFromRootDir,
  cleanupTestEnvironment,
} from "./setup";
import {
  createTempGitRepo,
  cleanupTempGitRepo,
  createWorkspace,
  generateBranchName,
} from "./helpers";
import { HistoryService } from "../../src/node/services/historyService";
import { createMuxMessage } from "../../src/common/types/message";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

function isChatMessage(event: WorkspaceChatMessage): event is WorkspaceChatMessage & {
  type: "message";
  role: "user" | "assistant";
  metadata?: { compacted?: unknown };
} {
  return (
    typeof event === "object" &&
    event !== null &&
    "type" in event &&
    (event as { type?: unknown }).type === "message" &&
    "role" in event
  );
}

async function waitForChatJsonlTmpFile(sessionDir: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  const hasTmp = async (): Promise<boolean> => {
    const names = await fs.readdir(sessionDir).catch(() => [] as string[]);
    return names.some((name) => name.startsWith("chat.jsonl."));
  };

  if (await hasTmp()) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(poller);
      clearTimeout(timeout);
      try {
        watcher.close();
      } catch {
        // ignore
      }
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const timeout = setTimeout(
      () => {
        finish(new Error(`Timed out waiting for write-file-atomic tmpfile in ${sessionDir}`));
      },
      Math.max(0, deadline - Date.now())
    );

    // Polling + fs.watch: watch is fast when it works; polling is the fallback.
    const poller = setInterval(() => {
      void hasTmp().then((ok) => {
        if (ok) finish();
      });
    }, 5);

    const watcher = fsSync.watch(sessionDir, { persistent: false }, (_event, filename) => {
      if (filename && filename.startsWith("chat.jsonl.")) {
        finish();
        return;
      }
      void hasTmp().then((ok) => {
        if (ok) finish();
      });
    });
  });
}

describeIntegration("compaction durability", () => {
  test.concurrent(
    "should not lose history if process is SIGKILLed during atomic replaceChatHistory",
    async () => {
      if (process.platform === "win32") {
        // SIGKILL isn't supported on Windows.
        return;
      }

      const tempGitRepo = await createTempGitRepo();
      const env1 = await createTestEnvironment();

      try {
        const branchName = generateBranchName("atomic-replace");
        const createResult = await createWorkspace(env1, tempGitRepo, branchName);
        expect(createResult.success).toBe(true);
        if (!createResult.success) {
          throw new Error(createResult.error);
        }

        const workspaceId = createResult.metadata.id;
        if (!workspaceId) {
          throw new Error("Workspace ID not returned from creation");
        }

        // Seed history (no LLM): create a small, valid chat.jsonl we can later replay via ORPC.
        const historyService = new HistoryService(env1.config);
        const seededMessages = [
          createMuxMessage("seed-1", "user", "hello", {}),
          createMuxMessage("seed-2", "assistant", "hi", {}),
          createMuxMessage("seed-3", "user", "how are you", {}),
          createMuxMessage("seed-4", "assistant", "fine", {}),
        ];

        for (const msg of seededMessages) {
          const result = await historyService.appendToHistory(workspaceId, msg);
          expect(result.success).toBe(true);
          if (!result.success) {
            throw new Error(result.error);
          }
        }

        // Stop the in-process backend, but keep rootDir on disk.
        await env1.services.dispose();
        await env1.services.shutdown();

        const rootDir = env1.tempDir;
        const sessionDir = path.join(rootDir, "sessions", workspaceId);
        const workerScript = path.join(__dirname, "workers", "replaceChatHistoryWorker.ts");

        const worker = spawn("bun", [workerScript], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            MUX_TEST_ROOT_DIR: rootDir,
            MUX_TEST_WORKSPACE_ID: workspaceId,
            // Keep the atomic write busy long enough to observe the tmp file.
            MUX_TEST_SUMMARY_BYTES: "50000000",
          },
          stdio: ["ignore", "ignore", "pipe"],
        });

        let workerStderr = "";
        worker.stderr?.on("data", (chunk) => {
          workerStderr += chunk.toString();
        });

        const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) => {
            worker.once("exit", (code, signal) => resolve({ code, signal }));
          }
        );

        const race = await Promise.race([
          waitForChatJsonlTmpFile(sessionDir, 20000).then(() => "tmp" as const),
          exited.then(() => "exit" as const),
        ]);

        if (race === "tmp") {
          // Simulate an abrupt crash.
          worker.kill("SIGKILL");
        }

        const exitInfo = await exited;
        if (exitInfo.code !== 0 && exitInfo.signal !== "SIGKILL") {
          throw new Error(
            `Worker failed: code=${exitInfo.code} signal=${exitInfo.signal}\n${workerStderr}`
          );
        }

        // Restart backend and assert behaviorally via ORPC history replay.
        const env2 = await createTestEnvironmentFromRootDir(rootDir);
        try {
          const replay = await env2.orpc.workspace.getFullReplay({ workspaceId });
          const replayedMessages = replay.filter(isChatMessage);

          expect([seededMessages.length, 1]).toContain(replayedMessages.length);

          if (replayedMessages.length === 1) {
            expect(replayedMessages[0].metadata?.compacted).toBeTruthy();
          }
        } finally {
          // Best-effort: remove workspace before tearing down rootDir.
          try {
            await env2.orpc.workspace.remove({ workspaceId, options: { force: true } });
          } catch {
            // ignore
          }
          await cleanupTestEnvironment(env2);
        }
      } finally {
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    60000
  );
});

import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { buildCompactionPrompt } from "../../src/common/constants/ui";
import type { MuxFrontendMetadata } from "../../src/common/types/message";
import { createMuxMessage } from "../../src/common/types/message";
import { HistoryService } from "../../src/node/services/historyService";
import {
  createTestEnvironment,
  createTestEnvironmentFromRootDir,
  cleanupTestEnvironment,
  setupProviders,
  shouldRunIntegrationTests,
  validateApiKeys,
  getApiKey,
} from "./setup";
import {
  cleanupTempGitRepo,
  createTempGitRepo,
  createWorkspace,
  createStreamCollector,
  generateBranchName,
  resolveOrpcClient,
  waitFor,
  configureTestRetries,
} from "./helpers";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

const PROVIDER = "anthropic";
const MODEL = "anthropic:claude-haiku-4-5";

describeIntegration("compaction restart retry", () => {
  configureTestRetries(3);

  test.concurrent(
    "should re-run compaction after restart and still auto-send continueMessage",
    async () => {
      const tempGitRepo = await createTempGitRepo();
      const env1 = await createTestEnvironment();
      let env2: Awaited<ReturnType<typeof createTestEnvironmentFromRootDir>> | null = null;
      let workspaceId: string | undefined;

      try {
        // Provider setup (persists into config.json under env1.tempDir)
        await setupProviders(env1, {
          [PROVIDER]: {
            apiKey: getApiKey("ANTHROPIC_API_KEY"),
          },
        });

        const branchName = generateBranchName("compaction-restart");
        const createResult = await createWorkspace(env1, tempGitRepo, branchName);
        expect(createResult.success).toBe(true);
        if (!createResult.success) {
          throw new Error(createResult.error);
        }

        workspaceId = createResult.metadata.id;
        if (!workspaceId) {
          throw new Error("Workspace ID not returned from creation");
        }

        // Seed some history without LLM calls.
        const historyService = new HistoryService(env1.config);
        const seedMessages = [
          createMuxMessage("seed-u1", "user", "We are testing compaction.", {}),
          createMuxMessage("seed-a1", "assistant", "Acknowledged.", {}),
          createMuxMessage("seed-u2", "user", "We will compact and then continue.", {}),
          createMuxMessage("seed-a2", "assistant", "Understood.", {}),
        ];
        for (const msg of seedMessages) {
          const result = await historyService.appendToHistory(workspaceId, msg);
          expect(result.success).toBe(true);
          if (!result.success) {
            throw new Error(result.error);
          }
        }

        // Send a compaction request with a queued continue message.
        const continueText = "Reply with the single word BANANA and nothing else.";
        const muxMetadata: MuxFrontendMetadata = {
          type: "compaction-request",
          rawCommand: `/compact\n${continueText}`,
          parsed: {
            model: MODEL,
            maxOutputTokens: 256,
            continueMessage: {
              text: continueText,
            },
          },
        };

        const collector1 = createStreamCollector(env1.orpc, workspaceId);
        collector1.start();
        await collector1.waitForSubscription(5000);

        const compactionPrompt = buildCompactionPrompt(200);
        const sendResult = await env1.orpc.workspace.sendMessage({
          workspaceId,
          message: compactionPrompt,
          options: {
            model: MODEL,
            mode: "compact",
            maxOutputTokens: 256,
            toolPolicy: [{ regex_match: ".*", action: "disable" }],
            muxMetadata,
          },
        });
        expect(sendResult.success).toBe(true);

        // Wait for stream to start.
        const streamStart = await collector1.waitForEvent("stream-start", 20000);
        expect(streamStart).toBeDefined();

        // Capture the compaction-request message id (persisted user message).
        const gotCompactionRequestId = await waitFor(() => {
          const userMsg = collector1
            .getEvents()
            .find(
              (e: WorkspaceChatMessage) =>
                "type" in e &&
                e.type === "message" &&
                "role" in e &&
                e.role === "user" &&
                (e as { metadata?: { muxMetadata?: { type?: string } } }).metadata?.muxMetadata
                  ?.type === "compaction-request"
            ) as (WorkspaceChatMessage & { id?: string }) | undefined;
          return Boolean(userMsg?.id);
        }, 5000);
        expect(gotCompactionRequestId).toBe(true);

        const compactionRequestMsg = collector1
          .getEvents()
          .find(
            (e: WorkspaceChatMessage) =>
              "type" in e &&
              e.type === "message" &&
              "role" in e &&
              e.role === "user" &&
              (e as { metadata?: { muxMetadata?: { type?: string } } }).metadata?.muxMetadata
                ?.type === "compaction-request"
          ) as WorkspaceChatMessage & { id: string };

        const compactionRequestId = compactionRequestMsg.id;
        expect(compactionRequestId).toBeTruthy();

        // Crash-like interruption: force a stream error while compaction is running.
        const client1 = resolveOrpcClient(env1);
        const triggered = await client1.debug.triggerStreamError({
          workspaceId,
          errorMessage: "Test-triggered compaction stream error",
        });
        expect(triggered).toBe(true);

        const streamError = await collector1.waitForEvent("stream-error", 20000);
        expect(streamError).toBeDefined();
        collector1.stop();

        // Simulate backend restart (preserve rootDir on disk).
        await env1.services.dispose();
        await env1.services.shutdown();

        env2 = await createTestEnvironmentFromRootDir(env1.tempDir);

        const collector2 = createStreamCollector(env2.orpc, workspaceId);
        collector2.start();
        await collector2.waitForSubscription(5000);

        // Mimic the renderer's recovery action: retry compaction via sendMessage(editMessageId)
        // so that continueMessage is queued again after restart.
        const retryResult = await env2.orpc.workspace.sendMessage({
          workspaceId,
          message: compactionPrompt,
          options: {
            model: MODEL,
            mode: "compact",
            maxOutputTokens: 256,
            toolPolicy: [{ regex_match: ".*", action: "disable" }],
            muxMetadata,
            editMessageId: compactionRequestId,
          },
        });
        expect(retryResult.success).toBe(true);

        // Behavioral assertions via the real chat event stream:
        // 1) Compaction completes (we see an assistant summary with metadata.compacted)
        const sawCompactedSummary = await waitFor(() => {
          return collector2.getEvents().some((e: WorkspaceChatMessage) => {
            return (
              "type" in e &&
              e.type === "message" &&
              "role" in e &&
              e.role === "assistant" &&
              Boolean((e as { metadata?: { compacted?: unknown } }).metadata?.compacted)
            );
          });
        }, 60000);
        expect(sawCompactedSummary).toBe(true);

        // 2) The queued continue message is auto-sent (we see the user message)
        const sawContinueUserMessage = await waitFor(() => {
          return collector2.getEvents().some((e: WorkspaceChatMessage) => {
            if (!("type" in e) || e.type !== "message" || !("role" in e) || e.role !== "user") {
              return false;
            }
            const parts = (e as { parts?: Array<{ type: string; text?: string }> }).parts;
            const text =
              parts
                ?.filter((p) => p.type === "text")
                .map((p) => p.text ?? "")
                .join("") ?? "";
            return text.includes(continueText);
          });
        }, 60000);
        expect(sawContinueUserMessage).toBe(true);

        // 3) The follow-up assistant stream completes with BANANA
        const sawBanana = await waitFor(() => {
          return collector2.getEvents().some((e: WorkspaceChatMessage) => {
            if (!("type" in e) || e.type !== "stream-end") {
              return false;
            }
            const parts = (e as { parts?: Array<{ type: string; text?: string }> }).parts;
            const text =
              parts
                ?.filter((p) => p.type === "text")
                .map((p) => p.text ?? "")
                .join("") ?? "";
            return text.includes("BANANA");
          });
        }, 60000);
        expect(sawBanana).toBe(true);

        collector2.stop();
      } finally {
        if (env2) {
          if (workspaceId) {
            try {
              // Best-effort: remove workspace to stop MCP servers and clean up worktrees/sessions.
              await env2.orpc.workspace.remove({ workspaceId, options: { force: true } });
            } catch {
              // ignore
            }
          }

          await cleanupTestEnvironment(env2);
        } else {
          await cleanupTestEnvironment(env1);
        }

        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    240000
  );
});

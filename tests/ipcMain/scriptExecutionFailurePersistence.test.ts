import { createTestEnvironment, cleanupTestEnvironment } from "./setup";
import { createTempGitRepo, cleanupTempGitRepo, createWorkspace, readChatHistory } from "./helpers";
import { IPC_CHANNELS, getChatChannel } from "../../src/common/constants/ipc-constants";
import type { MuxMessage } from "../../src/common/types/message";

const TEST_TIMEOUT_MS = 20000;

describe("WORKSPACE_EXECUTE_SCRIPT failure handling", () => {
  test(
    "persists a failure result when runWorkspaceScript returns an error",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();
      let workspaceId: string | null = null;
      const missingScriptName = "missing-script";

      try {
        const createResult = await createWorkspace(
          env.mockIpcRenderer,
          tempGitRepo,
          "script-failure"
        );

        if (!createResult.success) {
          throw new Error(`Workspace creation failed: ${createResult.error}`);
        }

        workspaceId = createResult.metadata.id;
        expect(workspaceId).toBeTruthy();

        const invocationResult = await env.mockIpcRenderer.invoke(
          IPC_CHANNELS.WORKSPACE_EXECUTE_SCRIPT,
          workspaceId,
          missingScriptName
        );

        expect(invocationResult.success).toBe(false);
        if (invocationResult.success) {
          throw new Error("Expected script execution to fail");
        }
        expect(invocationResult.error).toContain("Script not found");

        const chatChannel = getChatChannel(workspaceId);
        const scriptMessages = env.sentEvents
          .filter((event) => event.channel === chatChannel)
          .map((event) => event.data as MuxMessage)
          .filter(
            (message) =>
              message.metadata?.muxMetadata?.type === "script-execution" &&
              message.metadata?.muxMetadata?.command?.includes(missingScriptName)
          );

        expect(scriptMessages.length).toBeGreaterThan(0);
        const finalScriptMessage = scriptMessages[scriptMessages.length - 1];
        const finalMetadata = finalScriptMessage.metadata?.muxMetadata;
        expect(finalMetadata?.type).toBe("script-execution");
        if (!finalMetadata || finalMetadata.type !== "script-execution") {
          throw new Error("Expected script-execution metadata on final message");
        }
        const finalResult = finalMetadata.result;
        expect(finalResult).toBeDefined();
        if (!finalResult) {
          throw new Error("Expected script execution result on final message");
        }
        expect(finalResult.success).toBe(false);
        if (finalResult.success !== false) {
          throw new Error("Expected script execution to fail");
        }
        expect(finalResult.error).toContain("Script not found");

        const history = (await readChatHistory(env.tempDir, workspaceId)) as Array<
          Record<string, any>
        >;
        const persistedScriptMessage = history
          .filter(
            (message) =>
              message.metadata?.muxMetadata?.type === "script-execution" &&
              message.metadata?.muxMetadata?.command?.includes(missingScriptName)
          )
          .pop();

        expect(persistedScriptMessage).toBeDefined();
        if (!persistedScriptMessage) {
          throw new Error("Expected script execution message to be persisted");
        }
        const persistedMetadata = persistedScriptMessage.metadata?.muxMetadata;
        expect(persistedMetadata?.type).toBe("script-execution");
        if (!persistedMetadata || persistedMetadata.type !== "script-execution") {
          throw new Error("Expected script-execution metadata in history");
        }
        const persistedResult = persistedMetadata.result;
        expect(persistedResult).toBeDefined();
        if (!persistedResult) {
          throw new Error("Expected script execution result in history");
        }
        expect(persistedResult.success).toBe(false);
        if (persistedResult.success !== false) {
          throw new Error("Expected history result to indicate failure");
        }
        expect(persistedResult.error).toContain("Script not found");
      } finally {
        if (workspaceId) {
          await env.mockIpcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REMOVE, workspaceId);
        }
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    TEST_TIMEOUT_MS
  );
});

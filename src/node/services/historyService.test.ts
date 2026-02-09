import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { HistoryService } from "./historyService";
import { Config } from "@/node/config";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import assert from "node:assert";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

/** Collect all messages via iterateFullHistory (replaces removed getFullHistory). */
async function collectFullHistory(service: HistoryService, workspaceId: string) {
  const messages: MuxMessage[] = [];
  const result = await service.iterateFullHistory(workspaceId, "forward", (chunk) => {
    messages.push(...chunk);
  });
  assert(result.success, `collectFullHistory failed: ${result.success ? "" : result.error}`);
  return messages;
}

describe("HistoryService", () => {
  let service: HistoryService;
  let config: Config;
  let tempDir: string;

  beforeEach(async () => {
    // Create a temporary directory for test files
    tempDir = path.join(os.tmpdir(), `mux-test-${Date.now()}-${Math.random()}`);
    await fs.mkdir(tempDir, { recursive: true });

    // Create a Config with the temp directory
    config = new Config(tempDir);
    service = new HistoryService(config);
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("getHistory", () => {
    it("should return empty array when no history exists", async () => {
      const messages = await collectFullHistory(service, "workspace1");
      expect(messages).toEqual([]);
    });

    it("should read messages from chat.jsonl", async () => {
      const workspaceId = "workspace1";
      const workspaceDir = config.getSessionDir(workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });

      const msg1 = createMuxMessage("msg1", "user", "Hello", { historySequence: 0 });
      const msg2 = createMuxMessage("msg2", "assistant", "Hi there", {
        historySequence: 1,
      });

      const chatPath = path.join(workspaceDir, "chat.jsonl");
      await fs.writeFile(
        chatPath,
        JSON.stringify({ ...msg1, workspaceId }) +
          "\n" +
          JSON.stringify({ ...msg2, workspaceId }) +
          "\n"
      );

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages).toHaveLength(2);
      expect(messages[0].id).toBe("msg1");
      expect(messages[1].id).toBe("msg2");
    });

    it("should skip malformed JSON lines", async () => {
      const workspaceId = "workspace1";
      const workspaceDir = config.getSessionDir(workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });

      const msg1 = createMuxMessage("msg1", "user", "Hello", { historySequence: 0 });

      const chatPath = path.join(workspaceDir, "chat.jsonl");
      await fs.writeFile(
        chatPath,
        JSON.stringify({ ...msg1, workspaceId }) +
          "\n" +
          "invalid json line\n" +
          JSON.stringify({
            ...createMuxMessage("msg2", "user", "World", { historySequence: 1 }),
            workspaceId,
          }) +
          "\n"
      );

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages).toHaveLength(2);
      expect(messages[0].id).toBe("msg1");
      expect(messages[1].id).toBe("msg2");
    });

    it("hydrates legacy cmuxMetadata entries", async () => {
      const workspaceId = "workspace-legacy";
      const workspaceDir = config.getSessionDir(workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });

      const legacyMessage = createMuxMessage("msg-legacy", "user", "legacy", {
        historySequence: 0,
      });
      (legacyMessage.metadata as Record<string, unknown>).cmuxMetadata = { type: "normal" };

      const chatPath = path.join(workspaceDir, "chat.jsonl");
      await fs.writeFile(chatPath, JSON.stringify({ ...legacyMessage, workspaceId }) + "\n");

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages[0].metadata?.muxMetadata?.type).toBe("normal");
    });
    it("should handle empty lines in history file", async () => {
      const workspaceId = "workspace1";
      const workspaceDir = config.getSessionDir(workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });

      const msg1 = createMuxMessage("msg1", "user", "Hello", { historySequence: 0 });

      const chatPath = path.join(workspaceDir, "chat.jsonl");
      await fs.writeFile(
        chatPath,
        JSON.stringify({ ...msg1, workspaceId }) + "\n\n\n" // Extra empty lines
      );

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("msg1");
    });
  });

  describe("appendToHistory", () => {
    it("should create workspace directory if it doesn't exist", async () => {
      const workspaceId = "workspace1";
      const msg = createMuxMessage("msg1", "user", "Hello");

      const result = await service.appendToHistory(workspaceId, msg);

      expect(result.success).toBe(true);
      const workspaceDir = config.getSessionDir(workspaceId);
      const exists = await fs
        .access(workspaceDir)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });

    it("should assign historySequence to message without metadata", async () => {
      const workspaceId = "workspace1";
      const msg = createMuxMessage("msg1", "user", "Hello");

      const result = await service.appendToHistory(workspaceId, msg);

      expect(result.success).toBe(true);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages[0].metadata?.historySequence).toBe(0);
    });

    it("should assign sequential historySequence numbers", async () => {
      const workspaceId = "workspace1";
      const msg1 = createMuxMessage("msg1", "user", "Hello");
      const msg2 = createMuxMessage("msg2", "assistant", "Hi");
      const msg3 = createMuxMessage("msg3", "user", "How are you?");

      await service.appendToHistory(workspaceId, msg1);
      await service.appendToHistory(workspaceId, msg2);
      await service.appendToHistory(workspaceId, msg3);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages).toHaveLength(3);
      expect(messages[0].metadata?.historySequence).toBe(0);
      expect(messages[1].metadata?.historySequence).toBe(1);
      expect(messages[2].metadata?.historySequence).toBe(2);
    });

    it("should preserve existing historySequence if provided", async () => {
      const workspaceId = "workspace1";
      const msg = createMuxMessage("msg1", "user", "Hello", { historySequence: 5 });

      const result = await service.appendToHistory(workspaceId, msg);

      expect(result.success).toBe(true);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages[0].metadata?.historySequence).toBe(5);
    });

    it("should reject malformed provided historySequence values", async () => {
      const workspaceId = "workspace1";
      const msg = createMuxMessage("msg1", "user", "Hello", { historySequence: 5.5 });

      const result = await service.appendToHistory(workspaceId, msg);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("non-negative integer");
      }
    });

    it("should update sequence counter when message has higher sequence", async () => {
      const workspaceId = "workspace1";
      const msg1 = createMuxMessage("msg1", "user", "Hello", { historySequence: 10 });
      const msg2 = createMuxMessage("msg2", "user", "World");

      await service.appendToHistory(workspaceId, msg1);
      await service.appendToHistory(workspaceId, msg2);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages[0].metadata?.historySequence).toBe(10);
      expect(messages[1].metadata?.historySequence).toBe(11);
    });

    it("should preserve other metadata fields", async () => {
      const workspaceId = "workspace1";
      const msg = createMuxMessage("msg1", "user", "Hello", {
        timestamp: 123456,
        model: "claude-opus-4",
        providerMetadata: { test: "data" },
      });

      await service.appendToHistory(workspaceId, msg);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages[0].metadata?.timestamp).toBe(123456);
      expect(messages[0].metadata?.model).toBe("claude-opus-4");
      expect(messages[0].metadata?.providerMetadata).toEqual({ test: "data" });
      expect(messages[0].metadata?.historySequence).toBeDefined();
    });

    it("should include workspaceId in persisted message", async () => {
      const workspaceId = "workspace1";
      const msg = createMuxMessage("msg1", "user", "Hello");

      await service.appendToHistory(workspaceId, msg);

      const workspaceDir = config.getSessionDir(workspaceId);
      const chatPath = path.join(workspaceDir, "chat.jsonl");
      const content = await fs.readFile(chatPath, "utf-8");
      const persisted = JSON.parse(content.trim()) as {
        workspaceId: string;
        id: string;
        role: string;
      };

      expect(persisted.workspaceId).toBe(workspaceId);
    });
  });

  describe("updateHistory", () => {
    it("should update message by historySequence", async () => {
      const workspaceId = "workspace1";
      const msg1 = createMuxMessage("msg1", "user", "Hello");
      const msg2 = createMuxMessage("msg2", "assistant", "Hi");

      await service.appendToHistory(workspaceId, msg1);
      await service.appendToHistory(workspaceId, msg2);

      const messages = await collectFullHistory(service, workspaceId);
      const updatedMsg = createMuxMessage("msg1", "user", "Updated Hello", {
        historySequence: messages[0].metadata?.historySequence,
      });

      const result = await service.updateHistory(workspaceId, updatedMsg);
      expect(result.success).toBe(true);

      const newMessages = await collectFullHistory(service, workspaceId);
      expect(newMessages[0].parts[0]).toMatchObject({
        type: "text",
        text: "Updated Hello",
      });
      expect(newMessages[0].metadata?.historySequence).toBe(0);
    });

    it("should return error if message has no historySequence", async () => {
      const workspaceId = "workspace1";
      const msg = createMuxMessage("msg1", "user", "Hello");

      const result = await service.updateHistory(workspaceId, msg);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("without historySequence");
      }
    });

    it("should return error if message with historySequence not found", async () => {
      const workspaceId = "workspace1";
      const msg1 = createMuxMessage("msg1", "user", "Hello");

      await service.appendToHistory(workspaceId, msg1);

      const msg2 = createMuxMessage("msg2", "user", "Not found", { historySequence: 99 });
      const result = await service.updateHistory(workspaceId, msg2);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("No message found");
      }
    });

    it("should preserve historySequence when updating", async () => {
      const workspaceId = "workspace1";
      const msg = createMuxMessage("msg1", "user", "Hello");

      await service.appendToHistory(workspaceId, msg);

      const messages = await collectFullHistory(service, workspaceId);
      const originalSequence = messages[0].metadata?.historySequence;
      const updatedMsg = createMuxMessage("msg1", "user", "Updated", {
        historySequence: originalSequence,
      });

      await service.updateHistory(workspaceId, updatedMsg);

      const newMessages = await collectFullHistory(service, workspaceId);
      expect(newMessages[0].metadata?.historySequence).toBe(originalSequence);
    });

    it("preserves durable compaction metadata across late in-place rewrites", async () => {
      const workspaceId = "workspace1";
      const placeholder = createMuxMessage("summary-msg", "assistant", "", {
        model: "openai:gpt-5",
      });

      await service.appendToHistory(workspaceId, placeholder);

      const messagesAfterAppend = await collectFullHistory(service, workspaceId);

      const sequence = messagesAfterAppend[0]?.metadata?.historySequence;
      expect(typeof sequence).toBe("number");
      if (typeof sequence !== "number") {
        return;
      }

      // Simulate compaction finishing first and upgrading the streamed placeholder in place.
      const compactionSummary = createMuxMessage("summary-msg", "assistant", "Compacted summary", {
        historySequence: sequence,
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
        muxMetadata: { type: "compaction-summary" },
      });
      const compactionUpdateResult = await service.updateHistory(workspaceId, compactionSummary);
      expect(compactionUpdateResult.success).toBe(true);

      // Simulate a late stream rewrite (e.g., simulateToolPolicyNoop path) that omits
      // compaction metadata. The durable boundary markers must survive this rewrite.
      const lateRewrite = createMuxMessage(
        "summary-msg",
        "assistant",
        "Tool execution skipped because the requested tool is disabled by policy.",
        {
          historySequence: sequence,
          model: "openai:gpt-5",
        }
      );
      const lateRewriteResult = await service.updateHistory(workspaceId, lateRewrite);
      expect(lateRewriteResult.success).toBe(true);

      const finalMessages = await collectFullHistory(service, workspaceId);
      expect(finalMessages).toHaveLength(1);
      const finalMessage = finalMessages[0];
      expect(finalMessage.parts[0]).toMatchObject({
        type: "text",
        text: "Tool execution skipped because the requested tool is disabled by policy.",
      });
      expect(finalMessage.metadata?.compacted).toBe("user");
      expect(finalMessage.metadata?.compactionBoundary).toBe(true);
      expect(finalMessage.metadata?.compactionEpoch).toBe(1);
      expect(finalMessage.metadata?.muxMetadata).toEqual({ type: "compaction-summary" });
    });

    it("self-heals by not preserving malformed compaction boundary metadata", async () => {
      const workspaceId = "workspace1";
      const placeholder = createMuxMessage("summary-msg", "assistant", "", {
        model: "openai:gpt-5",
      });

      await service.appendToHistory(workspaceId, placeholder);

      const messagesAfterAppend = await collectFullHistory(service, workspaceId);

      const sequence = messagesAfterAppend[0]?.metadata?.historySequence;
      expect(typeof sequence).toBe("number");
      if (typeof sequence !== "number") {
        return;
      }

      // Simulate malformed persisted boundary metadata (invalid epoch).
      const malformedCompactionSummary = createMuxMessage(
        "summary-msg",
        "assistant",
        "Compacted summary",
        {
          historySequence: sequence,
          compacted: "user",
          compactionBoundary: true,
          compactionEpoch: 0,
        }
      );
      const malformedUpdateResult = await service.updateHistory(
        workspaceId,
        malformedCompactionSummary
      );
      expect(malformedUpdateResult.success).toBe(true);

      const lateRewrite = createMuxMessage("summary-msg", "assistant", "Late rewrite", {
        historySequence: sequence,
        model: "openai:gpt-5",
      });
      const lateRewriteResult = await service.updateHistory(workspaceId, lateRewrite);
      expect(lateRewriteResult.success).toBe(true);

      const finalMessages = await collectFullHistory(service, workspaceId);
      const finalMessage = finalMessages[0];
      expect(finalMessage.metadata?.compactionBoundary).toBeUndefined();
      expect(finalMessage.metadata?.compactionEpoch).toBeUndefined();
    });

    it("self-heals by not preserving malformed compacted markers in compaction boundaries", async () => {
      const workspaceId = "workspace1";
      const placeholder = createMuxMessage("summary-msg", "assistant", "", {
        model: "openai:gpt-5",
      });

      await service.appendToHistory(workspaceId, placeholder);

      const messagesAfterAppend = await collectFullHistory(service, workspaceId);

      const sequence = messagesAfterAppend[0]?.metadata?.historySequence;
      expect(typeof sequence).toBe("number");
      if (typeof sequence !== "number") {
        return;
      }

      const malformedCompactionSummary = createMuxMessage(
        "summary-msg",
        "assistant",
        "Compacted summary",
        {
          historySequence: sequence,
          compactionBoundary: true,
          compactionEpoch: 1,
        }
      );
      if (malformedCompactionSummary.metadata) {
        (malformedCompactionSummary.metadata as Record<string, unknown>).compacted = "corrupt";
      }

      const malformedUpdateResult = await service.updateHistory(
        workspaceId,
        malformedCompactionSummary
      );
      expect(malformedUpdateResult.success).toBe(true);

      const lateRewrite = createMuxMessage("summary-msg", "assistant", "Late rewrite", {
        historySequence: sequence,
        model: "openai:gpt-5",
      });
      const lateRewriteResult = await service.updateHistory(workspaceId, lateRewrite);
      expect(lateRewriteResult.success).toBe(true);

      const finalMessages = await collectFullHistory(service, workspaceId);
      const finalMessage = finalMessages[0];
      expect(finalMessage.metadata?.compacted).toBeUndefined();
      expect(finalMessage.metadata?.compactionBoundary).toBeUndefined();
      expect(finalMessage.metadata?.compactionEpoch).toBeUndefined();
    });
  });

  describe("deleteMessage", () => {
    it("should remove only the targeted message and preserve subsequent messages", async () => {
      const workspaceId = "workspace1";
      const msg1 = createMuxMessage("msg1", "user", "First");
      const msg2 = createMuxMessage("msg2", "assistant", "Second");
      const msg3 = createMuxMessage("msg3", "user", "Third");

      await service.appendToHistory(workspaceId, msg1);
      await service.appendToHistory(workspaceId, msg2);
      await service.appendToHistory(workspaceId, msg3);

      const result = await service.deleteMessage(workspaceId, "msg2");
      expect(result.success).toBe(true);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages).toHaveLength(2);
      expect(messages.map((message) => message.id)).toEqual(["msg1", "msg3"]);

      const msg4 = createMuxMessage("msg4", "assistant", "Fourth");
      await service.appendToHistory(workspaceId, msg4);

      const messagesAfterAppend = await collectFullHistory(service, workspaceId);
      const msg3Seq = messagesAfterAppend.find((message) => message.id === "msg3")?.metadata
        ?.historySequence;
      const msg4Seq = messagesAfterAppend.find((message) => message.id === "msg4")?.metadata
        ?.historySequence;

      expect(msg3Seq).toBeDefined();
      expect(msg4Seq).toBeDefined();
      expect(msg4Seq).toBeGreaterThan(msg3Seq ?? -1);
    });

    it("should return error if message not found", async () => {
      const workspaceId = "workspace1";
      const msg = createMuxMessage("msg1", "user", "Hello");

      await service.appendToHistory(workspaceId, msg);

      const result = await service.deleteMessage(workspaceId, "nonexistent");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("not found");
      }
    });
  });

  describe("truncateAfterMessage", () => {
    it("should remove message and all subsequent messages", async () => {
      const workspaceId = "workspace1";
      const msg1 = createMuxMessage("msg1", "user", "First");
      const msg2 = createMuxMessage("msg2", "assistant", "Second");
      const msg3 = createMuxMessage("msg3", "user", "Third");
      const msg4 = createMuxMessage("msg4", "assistant", "Fourth");

      await service.appendToHistory(workspaceId, msg1);
      await service.appendToHistory(workspaceId, msg2);
      await service.appendToHistory(workspaceId, msg3);
      await service.appendToHistory(workspaceId, msg4);

      const result = await service.truncateAfterMessage(workspaceId, "msg2");

      expect(result.success).toBe(true);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("msg1");
    });

    it("should update sequence counter after truncation", async () => {
      const workspaceId = "workspace1";
      const msg1 = createMuxMessage("msg1", "user", "First");
      const msg2 = createMuxMessage("msg2", "assistant", "Second");
      const msg3 = createMuxMessage("msg3", "user", "Third");

      await service.appendToHistory(workspaceId, msg1);
      await service.appendToHistory(workspaceId, msg2);
      await service.appendToHistory(workspaceId, msg3);

      await service.truncateAfterMessage(workspaceId, "msg2");

      // Append a new message and check its sequence
      const msg4 = createMuxMessage("msg4", "user", "New message");
      await service.appendToHistory(workspaceId, msg4);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages).toHaveLength(2);
      expect(messages[0].metadata?.historySequence).toBe(0);
      expect(messages[1].metadata?.historySequence).toBe(1);
    });

    it("should reset sequence counter when truncating all messages", async () => {
      const workspaceId = "workspace1";
      const msg1 = createMuxMessage("msg1", "user", "First");
      const msg2 = createMuxMessage("msg2", "assistant", "Second");

      await service.appendToHistory(workspaceId, msg1);
      await service.appendToHistory(workspaceId, msg2);

      await service.truncateAfterMessage(workspaceId, "msg1");

      const msg3 = createMuxMessage("msg3", "user", "New");
      await service.appendToHistory(workspaceId, msg3);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages).toHaveLength(1);
      expect(messages[0].metadata?.historySequence).toBe(0);
    });

    it("should return error if message not found", async () => {
      const workspaceId = "workspace1";
      const msg = createMuxMessage("msg1", "user", "Hello");

      await service.appendToHistory(workspaceId, msg);

      const result = await service.truncateAfterMessage(workspaceId, "nonexistent");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("not found");
      }
    });
  });

  describe("clearHistory", () => {
    it("should delete chat.jsonl file", async () => {
      const workspaceId = "workspace1";
      const msg = createMuxMessage("msg1", "user", "Hello");

      await service.appendToHistory(workspaceId, msg);

      const result = await service.clearHistory(workspaceId);

      expect(result.success).toBe(true);

      const workspaceDir = config.getSessionDir(workspaceId);
      const chatPath = path.join(workspaceDir, "chat.jsonl");
      const exists = await fs
        .access(chatPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });

    it("should reset sequence counter", async () => {
      const workspaceId = "workspace1";
      const msg1 = createMuxMessage("msg1", "user", "Hello");

      await service.appendToHistory(workspaceId, msg1);
      await service.clearHistory(workspaceId);

      const msg2 = createMuxMessage("msg2", "user", "New message");
      await service.appendToHistory(workspaceId, msg2);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages[0].metadata?.historySequence).toBe(0);
    });

    it("should succeed when clearing non-existent history", async () => {
      const workspaceId = "workspace-no-history";

      const result = await service.clearHistory(workspaceId);

      expect(result.success).toBe(true);
    });

    it("should reset sequence counter even when file doesn't exist", async () => {
      const workspaceId = "workspace-no-history";

      await service.clearHistory(workspaceId);

      const msg = createMuxMessage("msg1", "user", "First");
      await service.appendToHistory(workspaceId, msg);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages[0].metadata?.historySequence).toBe(0);
    });
  });

  describe("sequence number initialization", () => {
    it("should initialize sequence from existing history", async () => {
      const workspaceId = "workspace1";
      const workspaceDir = config.getSessionDir(workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });

      // Manually create history with specific sequences
      const msg1 = createMuxMessage("msg1", "user", "Hello", { historySequence: 0 });
      const msg2 = createMuxMessage("msg2", "assistant", "Hi", { historySequence: 1 });

      const chatPath = path.join(workspaceDir, "chat.jsonl");
      await fs.writeFile(
        chatPath,
        JSON.stringify({ ...msg1, workspaceId }) +
          "\n" +
          JSON.stringify({ ...msg2, workspaceId }) +
          "\n"
      );

      // Create new service instance to ensure fresh initialization
      const newService = new HistoryService(config);

      // Append a new message - should get sequence 2
      const msg3 = createMuxMessage("msg3", "user", "How are you?");
      await newService.appendToHistory(workspaceId, msg3);

      const messages = await collectFullHistory(newService, workspaceId);
      expect(messages).toHaveLength(3);
      expect(messages[2].metadata?.historySequence).toBe(2);
    });

    it("should ignore malformed persisted numeric sequences when initializing counters", async () => {
      const workspaceId = "workspace-with-malformed-sequences";
      const workspaceDir = config.getSessionDir(workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });

      const validMessage = createMuxMessage("msg-valid", "user", "Hello", { historySequence: 3 });
      const malformedMessage = createMuxMessage("msg-malformed", "assistant", "Hi", {
        historySequence: 42,
      });
      if (malformedMessage.metadata) {
        (malformedMessage.metadata as Record<string, unknown>).historySequence = 99.5;
      }

      const chatPath = path.join(workspaceDir, "chat.jsonl");
      await fs.writeFile(
        chatPath,
        JSON.stringify({ ...validMessage, workspaceId }) +
          "\n" +
          JSON.stringify({ ...malformedMessage, workspaceId }) +
          "\n"
      );

      const newService = new HistoryService(config);
      const msg3 = createMuxMessage("msg3", "user", "How are you?");
      const appendResult = await newService.appendToHistory(workspaceId, msg3);
      expect(appendResult.success).toBe(true);

      const messages = await collectFullHistory(newService, workspaceId);
      expect(messages).toHaveLength(3);
      const appended = messages.find((msg) => msg.id === "msg3");
      expect(appended?.metadata?.historySequence).toBe(4);
    });

    it("should start from 0 for new workspace", async () => {
      const workspaceId = "new-workspace";
      const msg = createMuxMessage("msg1", "user", "First message");

      await service.appendToHistory(workspaceId, msg);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages[0].metadata?.historySequence).toBe(0);
    });
  });

  // ── Optimized read path tests ──────────────────────────────────────────────

  /**
   * Helper: write a chat.jsonl file with messages that include a compaction boundary.
   * Returns { preBoundaryIds, boundaryId, postBoundaryIds }.
   */
  async function writeChatWithBoundary(
    cfg: Config,
    workspaceId: string,
    opts: { preBoundaryCount: number; postBoundaryCount: number; epoch?: number }
  ) {
    const workspaceDir = cfg.getSessionDir(workspaceId);
    await fs.mkdir(workspaceDir, { recursive: true });

    const epoch = opts.epoch ?? 1;
    const lines: string[] = [];
    const preBoundaryIds: string[] = [];
    const postBoundaryIds: string[] = [];
    let seq = 0;

    // Pre-boundary messages
    for (let i = 0; i < opts.preBoundaryCount; i++) {
      const id = `pre-${i}`;
      preBoundaryIds.push(id);
      lines.push(
        JSON.stringify({
          ...createMuxMessage(id, "user", `message ${i}`, { historySequence: seq++ }),
          workspaceId,
        })
      );
    }

    // Compaction boundary message
    const boundaryId = `boundary-${epoch}`;
    lines.push(
      JSON.stringify({
        ...createMuxMessage(boundaryId, "assistant", "Compaction summary", {
          historySequence: seq++,
          compactionBoundary: true,
          compacted: "user",
          compactionEpoch: epoch,
        }),
        workspaceId,
      })
    );

    // Post-boundary messages
    for (let i = 0; i < opts.postBoundaryCount; i++) {
      const id = `post-${i}`;
      postBoundaryIds.push(id);
      lines.push(
        JSON.stringify({
          ...createMuxMessage(id, "user", `post message ${i}`, { historySequence: seq++ }),
          workspaceId,
        })
      );
    }

    await fs.writeFile(path.join(workspaceDir, "chat.jsonl"), lines.join("\n") + "\n");
    return { preBoundaryIds, boundaryId, postBoundaryIds };
  }

  describe("getHistoryFromLatestBoundary", () => {
    it("should return full history when no boundary exists", async () => {
      const workspaceId = "ws-no-boundary";
      const workspaceDir = config.getSessionDir(workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });

      const msg1 = createMuxMessage("msg1", "user", "Hello", { historySequence: 0 });
      const msg2 = createMuxMessage("msg2", "assistant", "Hi", { historySequence: 1 });
      await fs.writeFile(
        path.join(workspaceDir, "chat.jsonl"),
        JSON.stringify({ ...msg1, workspaceId }) +
          "\n" +
          JSON.stringify({ ...msg2, workspaceId }) +
          "\n"
      );

      const result = await service.getHistoryFromLatestBoundary(workspaceId);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(2);
        expect(result.data[0].id).toBe("msg1");
        expect(result.data[1].id).toBe("msg2");
      }
    });

    it("should return empty array when no history exists", async () => {
      const result = await service.getHistoryFromLatestBoundary("nonexistent");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual([]);
      }
    });

    it("should return only messages from the latest boundary onward", async () => {
      const workspaceId = "ws-with-boundary";
      const { boundaryId, postBoundaryIds } = await writeChatWithBoundary(config, workspaceId, {
        preBoundaryCount: 5,
        postBoundaryCount: 3,
      });

      const result = await service.getHistoryFromLatestBoundary(workspaceId);
      expect(result.success).toBe(true);
      if (result.success) {
        // Should include boundary + post-boundary messages
        expect(result.data).toHaveLength(4); // 1 boundary + 3 post
        expect(result.data[0].id).toBe(boundaryId);
        for (let i = 0; i < postBoundaryIds.length; i++) {
          expect(result.data[i + 1].id).toBe(postBoundaryIds[i]);
        }
      }
    });

    it("should find the latest boundary with multiple compaction epochs", async () => {
      const workspaceId = "ws-multi-epoch";
      const workspaceDir = config.getSessionDir(workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });

      const lines: string[] = [];
      let seq = 0;

      // Epoch 1 messages + boundary
      lines.push(
        JSON.stringify({
          ...createMuxMessage("e1-user", "user", "msg", { historySequence: seq++ }),
          workspaceId,
        })
      );
      lines.push(
        JSON.stringify({
          ...createMuxMessage("e1-boundary", "assistant", "Summary 1", {
            historySequence: seq++,
            compactionBoundary: true,
            compacted: "user",
            compactionEpoch: 1,
          }),
          workspaceId,
        })
      );

      // Epoch 2 messages + boundary
      lines.push(
        JSON.stringify({
          ...createMuxMessage("e2-user", "user", "msg", { historySequence: seq++ }),
          workspaceId,
        })
      );
      lines.push(
        JSON.stringify({
          ...createMuxMessage("e2-boundary", "assistant", "Summary 2", {
            historySequence: seq++,
            compactionBoundary: true,
            compacted: "idle",
            compactionEpoch: 2,
          }),
          workspaceId,
        })
      );

      // Post-epoch-2 message
      lines.push(
        JSON.stringify({
          ...createMuxMessage("post-e2", "user", "after both", { historySequence: seq++ }),
          workspaceId,
        })
      );

      await fs.writeFile(path.join(workspaceDir, "chat.jsonl"), lines.join("\n") + "\n");

      // Default skip=0: reads from the latest boundary
      const result = await service.getHistoryFromLatestBoundary(workspaceId);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(2); // epoch-2 boundary + post message
        expect(result.data[0].id).toBe("e2-boundary");
        expect(result.data[1].id).toBe("post-e2");
      }

      // skip=1: reads from the penultimate boundary
      const penultimate = await service.getHistoryFromLatestBoundary(workspaceId, 1);
      expect(penultimate.success).toBe(true);
      if (penultimate.success) {
        expect(penultimate.data).toHaveLength(4);
        expect(penultimate.data[0].id).toBe("e1-boundary");
        expect(penultimate.data[1].id).toBe("e2-user");
        expect(penultimate.data[2].id).toBe("e2-boundary");
        expect(penultimate.data[3].id).toBe("post-e2");
      }
    });

    it("should skip malformed lines in boundary region", async () => {
      const workspaceId = "ws-malformed";
      const workspaceDir = config.getSessionDir(workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });

      const boundary = createMuxMessage("boundary", "assistant", "Summary", {
        historySequence: 0,
        compactionBoundary: true,
        compacted: "user",
        compactionEpoch: 1,
      });
      const post = createMuxMessage("post", "user", "after", { historySequence: 1 });

      await fs.writeFile(
        path.join(workspaceDir, "chat.jsonl"),
        JSON.stringify({ ...boundary, workspaceId }) +
          "\n" +
          "MALFORMED LINE\n" +
          JSON.stringify({ ...post, workspaceId }) +
          "\n"
      );

      const result = await service.getHistoryFromLatestBoundary(workspaceId);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(2); // boundary + post (malformed skipped)
        expect(result.data[0].id).toBe("boundary");
        expect(result.data[1].id).toBe("post");
      }
    });
  });

  describe("getLastMessages", () => {
    it("should return empty array when no history exists", async () => {
      const result = await service.getLastMessages("nonexistent", 5);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual([]);
      }
    });

    it("should return the last N messages in chronological order", async () => {
      const workspaceId = "ws-last-n";
      const workspaceDir = config.getSessionDir(workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });

      const lines: string[] = [];
      for (let i = 0; i < 10; i++) {
        lines.push(
          JSON.stringify({
            ...createMuxMessage(`msg-${i}`, "user", `message ${i}`, { historySequence: i }),
            workspaceId,
          })
        );
      }
      await fs.writeFile(path.join(workspaceDir, "chat.jsonl"), lines.join("\n") + "\n");

      const result = await service.getLastMessages(workspaceId, 3);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(3);
        expect(result.data[0].id).toBe("msg-7");
        expect(result.data[1].id).toBe("msg-8");
        expect(result.data[2].id).toBe("msg-9");
      }
    });

    it("should return all messages when N exceeds total count", async () => {
      const workspaceId = "ws-last-all";
      const workspaceDir = config.getSessionDir(workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });

      const lines: string[] = [];
      for (let i = 0; i < 3; i++) {
        lines.push(
          JSON.stringify({
            ...createMuxMessage(`msg-${i}`, "user", `message ${i}`, { historySequence: i }),
            workspaceId,
          })
        );
      }
      await fs.writeFile(path.join(workspaceDir, "chat.jsonl"), lines.join("\n") + "\n");

      const result = await service.getLastMessages(workspaceId, 100);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(3);
        expect(result.data[0].id).toBe("msg-0");
        expect(result.data[1].id).toBe("msg-1");
        expect(result.data[2].id).toBe("msg-2");
      }
    });

    it("should return exactly 1 message when requested", async () => {
      const workspaceId = "ws-last-1";
      const workspaceDir = config.getSessionDir(workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });

      const lines: string[] = [];
      for (let i = 0; i < 5; i++) {
        lines.push(
          JSON.stringify({
            ...createMuxMessage(`msg-${i}`, "user", `message ${i}`, { historySequence: i }),
            workspaceId,
          })
        );
      }
      await fs.writeFile(path.join(workspaceDir, "chat.jsonl"), lines.join("\n") + "\n");

      const result = await service.getLastMessages(workspaceId, 1);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].id).toBe("msg-4");
      }
    });

    it("should skip malformed lines", async () => {
      const workspaceId = "ws-last-malformed";
      const workspaceDir = config.getSessionDir(workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });

      const msg1 = createMuxMessage("msg1", "user", "Hello", { historySequence: 0 });
      const msg2 = createMuxMessage("msg2", "assistant", "Hi", { historySequence: 1 });

      await fs.writeFile(
        path.join(workspaceDir, "chat.jsonl"),
        JSON.stringify({ ...msg1, workspaceId }) +
          "\n" +
          "BAD LINE\n" +
          JSON.stringify({ ...msg2, workspaceId }) +
          "\n"
      );

      const result = await service.getLastMessages(workspaceId, 2);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(2);
        expect(result.data[0].id).toBe("msg1");
        expect(result.data[1].id).toBe("msg2");
      }
    });
  });

  describe("multi-byte UTF-8 handling", () => {
    it("should correctly find boundary and read messages with non-ASCII content", async () => {
      const workspaceId = "ws-utf8";
      const workspaceDir = config.getSessionDir(workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });

      // Use multi-byte UTF-8 characters (emoji, CJK) in message content
      // to verify byte offset calculations handle non-ASCII correctly.
      const lines: string[] = [];
      let seq = 0;

      // Pre-boundary: message with emoji (4-byte UTF-8 chars)
      lines.push(
        JSON.stringify({
          ...createMuxMessage("emoji-msg", "user", "Hello 🌍🔥💻 world", {
            historySequence: seq++,
          }),
          workspaceId,
        })
      );

      // Boundary with CJK characters (3-byte UTF-8 chars)
      lines.push(
        JSON.stringify({
          ...createMuxMessage("boundary-utf8", "assistant", "要約：会話の概要", {
            historySequence: seq++,
            compactionBoundary: true,
            compacted: "user",
            compactionEpoch: 1,
          }),
          workspaceId,
        })
      );

      // Post-boundary: message with mixed scripts
      lines.push(
        JSON.stringify({
          ...createMuxMessage("post-utf8", "user", "Ñoño café résumé über 日本語", {
            historySequence: seq++,
          }),
          workspaceId,
        })
      );

      await fs.writeFile(path.join(workspaceDir, "chat.jsonl"), lines.join("\n") + "\n");

      // getHistoryFromLatestBoundary should find the boundary correctly
      const boundaryResult = await service.getHistoryFromLatestBoundary(workspaceId);
      expect(boundaryResult.success).toBe(true);
      if (boundaryResult.success) {
        expect(boundaryResult.data).toHaveLength(2); // boundary + post
        expect(boundaryResult.data[0].id).toBe("boundary-utf8");
        expect(boundaryResult.data[1].id).toBe("post-utf8");
      }

      // getLastMessages should also handle multi-byte content correctly
      const lastResult = await service.getLastMessages(workspaceId, 2);
      expect(lastResult.success).toBe(true);
      if (lastResult.success) {
        expect(lastResult.data).toHaveLength(2);
        expect(lastResult.data[0].id).toBe("boundary-utf8");
        expect(lastResult.data[1].id).toBe("post-utf8");
      }
    });

    it("should handle messages where all content is multi-byte", async () => {
      const workspaceId = "ws-utf8-all";
      const workspaceDir = config.getSessionDir(workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });

      const lines: string[] = [];
      // Every message uses multi-byte characters exclusively
      for (let i = 0; i < 5; i++) {
        lines.push(
          JSON.stringify({
            ...createMuxMessage(`utf8-${i}`, "user", `メッセージ ${i} 🎯`, {
              historySequence: i,
            }),
            workspaceId,
          })
        );
      }
      await fs.writeFile(path.join(workspaceDir, "chat.jsonl"), lines.join("\n") + "\n");

      const result = await service.getLastMessages(workspaceId, 3);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(3);
        expect(result.data[0].id).toBe("utf8-2");
        expect(result.data[1].id).toBe("utf8-3");
        expect(result.data[2].id).toBe("utf8-4");
      }
    });
  });

  describe("hasHistory", () => {
    it("should return false when no history file exists", async () => {
      const result = await service.hasHistory("nonexistent");
      expect(result).toBe(false);
    });

    it("should return false for empty file", async () => {
      const workspaceId = "ws-empty";
      const workspaceDir = config.getSessionDir(workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "chat.jsonl"), "");

      const result = await service.hasHistory(workspaceId);
      expect(result).toBe(false);
    });

    it("should return true when history exists", async () => {
      const workspaceId = "ws-has-history";
      const workspaceDir = config.getSessionDir(workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });

      const msg = createMuxMessage("msg1", "user", "Hello", { historySequence: 0 });
      await fs.writeFile(
        path.join(workspaceDir, "chat.jsonl"),
        JSON.stringify({ ...msg, workspaceId }) + "\n"
      );

      const result = await service.hasHistory(workspaceId);
      expect(result).toBe(true);
    });
  });

  describe("iterateFullHistory", () => {
    const wsId = "workspace1";

    it("should iterate forward in chronological order", async () => {
      const msgs = Array.from({ length: 5 }, (_, i) =>
        createMuxMessage(`msg-${i}`, "user", `Message ${i}`)
      );
      for (const msg of msgs) {
        await service.appendToHistory(wsId, msg);
      }

      const collected: MuxMessage[] = [];
      const result = await service.iterateFullHistory(wsId, "forward", (chunk) => {
        collected.push(...chunk);
      });
      expect(result.success).toBe(true);
      expect(collected.length).toBe(5);
      expect(collected.map((m) => m.id)).toEqual(["msg-0", "msg-1", "msg-2", "msg-3", "msg-4"]);
    });

    it("should iterate backward with newest first", async () => {
      const msgs = Array.from({ length: 5 }, (_, i) =>
        createMuxMessage(`msg-${i}`, "user", `Message ${i}`)
      );
      for (const msg of msgs) {
        await service.appendToHistory(wsId, msg);
      }

      const collected: MuxMessage[] = [];
      const result = await service.iterateFullHistory(wsId, "backward", (chunk) => {
        collected.push(...chunk);
      });
      expect(result.success).toBe(true);
      expect(collected.length).toBe(5);
      // Backward: newest first
      expect(collected.map((m) => m.id)).toEqual(["msg-4", "msg-3", "msg-2", "msg-1", "msg-0"]);
    });

    it("should support early exit by returning false", async () => {
      const msgs = Array.from({ length: 10 }, (_, i) =>
        createMuxMessage(`msg-${i}`, "user", `Message ${i}`)
      );
      for (const msg of msgs) {
        await service.appendToHistory(wsId, msg);
      }

      let found: MuxMessage | undefined;
      await service.iterateFullHistory(wsId, "forward", (chunk) => {
        for (const msg of chunk) {
          if (msg.id === "msg-3") {
            found = msg;
            return false; // stop early
          }
        }
      });
      expect(found).toBeTruthy();
      expect(found!.id).toBe("msg-3");
    });

    it("should support early exit in backward direction", async () => {
      const msgs = Array.from({ length: 10 }, (_, i) =>
        createMuxMessage(`msg-${i}`, "user", `Message ${i}`)
      );
      for (const msg of msgs) {
        await service.appendToHistory(wsId, msg);
      }

      // Find the first message encountered when reading backward (should be msg-9)
      let firstSeen: MuxMessage | undefined;
      await service.iterateFullHistory(wsId, "backward", (chunk) => {
        firstSeen = chunk[0];
        return false; // stop after first chunk
      });
      expect(firstSeen).toBeTruthy();
      expect(firstSeen!.id).toBe("msg-9");
    });

    it("should return success for empty history", async () => {
      const collected: MuxMessage[] = [];
      const result = await service.iterateFullHistory(wsId, "forward", (chunk) => {
        collected.push(...chunk);
      });
      expect(result.success).toBe(true);
      expect(collected.length).toBe(0);
    });

    it("should skip malformed lines during iteration", async () => {
      const workspaceDir = config.getSessionDir(wsId);
      await fs.mkdir(workspaceDir, { recursive: true });

      const validMsg = createMuxMessage("valid-1", "user", "Valid message");
      const content = [
        "not valid json",
        JSON.stringify({ ...validMsg, workspaceId: wsId }),
        "{malformed",
      ].join("\n");

      await fs.writeFile(path.join(workspaceDir, "chat.jsonl"), content + "\n");

      const collected: MuxMessage[] = [];
      const result = await service.iterateFullHistory(wsId, "forward", (chunk) => {
        collected.push(...chunk);
      });
      expect(result.success).toBe(true);
      expect(collected.length).toBe(1);
      expect(collected[0].id).toBe("valid-1");
    });
  });
});

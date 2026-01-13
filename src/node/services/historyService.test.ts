import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { HistoryService } from "./historyService";
import { Config } from "@/node/config";
import { createMuxMessage } from "@/common/types/message";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

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
      const result = await service.getHistory("workspace1");

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual([]);
      }
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

      const result = await service.getHistory(workspaceId);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(2);
        expect(result.data[0].id).toBe("msg1");
        expect(result.data[1].id).toBe("msg2");
      }
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

      const result = await service.getHistory(workspaceId);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(2);
        expect(result.data[0].id).toBe("msg1");
        expect(result.data[1].id).toBe("msg2");
      }
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

      const result = await service.getHistory(workspaceId);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data[0].metadata?.muxMetadata?.type).toBe("normal");
      }
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

      const result = await service.getHistory(workspaceId);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].id).toBe("msg1");
      }
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

      const history = await service.getHistory(workspaceId);
      if (history.success) {
        expect(history.data[0].metadata?.historySequence).toBe(0);
      }
    });

    it("should assign sequential historySequence numbers", async () => {
      const workspaceId = "workspace1";
      const msg1 = createMuxMessage("msg1", "user", "Hello");
      const msg2 = createMuxMessage("msg2", "assistant", "Hi");
      const msg3 = createMuxMessage("msg3", "user", "How are you?");

      await service.appendToHistory(workspaceId, msg1);
      await service.appendToHistory(workspaceId, msg2);
      await service.appendToHistory(workspaceId, msg3);

      const history = await service.getHistory(workspaceId);
      if (history.success) {
        expect(history.data).toHaveLength(3);
        expect(history.data[0].metadata?.historySequence).toBe(0);
        expect(history.data[1].metadata?.historySequence).toBe(1);
        expect(history.data[2].metadata?.historySequence).toBe(2);
      }
    });

    it("should preserve existing historySequence if provided", async () => {
      const workspaceId = "workspace1";
      const msg = createMuxMessage("msg1", "user", "Hello", { historySequence: 5 });

      const result = await service.appendToHistory(workspaceId, msg);

      expect(result.success).toBe(true);

      const history = await service.getHistory(workspaceId);
      if (history.success) {
        expect(history.data[0].metadata?.historySequence).toBe(5);
      }
    });

    it("should update sequence counter when message has higher sequence", async () => {
      const workspaceId = "workspace1";
      const msg1 = createMuxMessage("msg1", "user", "Hello", { historySequence: 10 });
      const msg2 = createMuxMessage("msg2", "user", "World");

      await service.appendToHistory(workspaceId, msg1);
      await service.appendToHistory(workspaceId, msg2);

      const history = await service.getHistory(workspaceId);
      if (history.success) {
        expect(history.data[0].metadata?.historySequence).toBe(10);
        expect(history.data[1].metadata?.historySequence).toBe(11);
      }
    });

    it("should preserve other metadata fields", async () => {
      const workspaceId = "workspace1";
      const msg = createMuxMessage("msg1", "user", "Hello", {
        timestamp: 123456,
        model: "claude-opus-4",
        providerMetadata: { test: "data" },
      });

      await service.appendToHistory(workspaceId, msg);

      const history = await service.getHistory(workspaceId);
      if (history.success) {
        expect(history.data[0].metadata?.timestamp).toBe(123456);
        expect(history.data[0].metadata?.model).toBe("claude-opus-4");
        expect(history.data[0].metadata?.providerMetadata).toEqual({ test: "data" });
        expect(history.data[0].metadata?.historySequence).toBeDefined();
      }
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

      const history = await service.getHistory(workspaceId);
      if (history.success) {
        const updatedMsg = createMuxMessage("msg1", "user", "Updated Hello", {
          historySequence: history.data[0].metadata?.historySequence,
        });

        const result = await service.updateHistory(workspaceId, updatedMsg);
        expect(result.success).toBe(true);

        const newHistory = await service.getHistory(workspaceId);
        if (newHistory.success) {
          expect(newHistory.data[0].parts[0]).toMatchObject({
            type: "text",
            text: "Updated Hello",
          });
          expect(newHistory.data[0].metadata?.historySequence).toBe(0);
        }
      }
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

      const history = await service.getHistory(workspaceId);
      if (history.success) {
        const originalSequence = history.data[0].metadata?.historySequence;
        const updatedMsg = createMuxMessage("msg1", "user", "Updated", {
          historySequence: originalSequence,
        });

        await service.updateHistory(workspaceId, updatedMsg);

        const newHistory = await service.getHistory(workspaceId);
        if (newHistory.success) {
          expect(newHistory.data[0].metadata?.historySequence).toBe(originalSequence);
        }
      }
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

      const history = await service.getHistory(workspaceId);
      if (history.success) {
        expect(history.data).toHaveLength(2);
        expect(history.data.map((message) => message.id)).toEqual(["msg1", "msg3"]);
      }

      const msg4 = createMuxMessage("msg4", "assistant", "Fourth");
      await service.appendToHistory(workspaceId, msg4);

      const historyAfterAppend = await service.getHistory(workspaceId);
      if (historyAfterAppend.success) {
        const msg3Seq = historyAfterAppend.data.find((message) => message.id === "msg3")?.metadata
          ?.historySequence;
        const msg4Seq = historyAfterAppend.data.find((message) => message.id === "msg4")?.metadata
          ?.historySequence;

        expect(msg3Seq).toBeDefined();
        expect(msg4Seq).toBeDefined();
        expect(msg4Seq).toBeGreaterThan(msg3Seq ?? -1);
      }
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

      const history = await service.getHistory(workspaceId);
      if (history.success) {
        expect(history.data).toHaveLength(1);
        expect(history.data[0].id).toBe("msg1");
      }
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

      const history = await service.getHistory(workspaceId);
      if (history.success) {
        expect(history.data).toHaveLength(2);
        expect(history.data[0].metadata?.historySequence).toBe(0);
        expect(history.data[1].metadata?.historySequence).toBe(1);
      }
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

      const history = await service.getHistory(workspaceId);
      if (history.success) {
        expect(history.data).toHaveLength(1);
        expect(history.data[0].metadata?.historySequence).toBe(0);
      }
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

      const history = await service.getHistory(workspaceId);
      if (history.success) {
        expect(history.data[0].metadata?.historySequence).toBe(0);
      }
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

      const history = await service.getHistory(workspaceId);
      if (history.success) {
        expect(history.data[0].metadata?.historySequence).toBe(0);
      }
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

      const history = await newService.getHistory(workspaceId);
      if (history.success) {
        expect(history.data).toHaveLength(3);
        expect(history.data[2].metadata?.historySequence).toBe(2);
      }
    });

    it("should start from 0 for new workspace", async () => {
      const workspaceId = "new-workspace";
      const msg = createMuxMessage("msg1", "user", "First message");

      await service.appendToHistory(workspaceId, msg);

      const history = await service.getHistory(workspaceId);
      if (history.success) {
        expect(history.data[0].metadata?.historySequence).toBe(0);
      }
    });
  });
});

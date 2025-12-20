/* eslint-disable @typescript-eslint/unbound-method */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { PartialService } from "./partialService";
import type { HistoryService } from "./historyService";
import { Config } from "@/node/config";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// Mock Config
const createMockConfig = (): Config => {
  return {
    getSessionDir: mock((workspaceId: string) => `/tmp/test-sessions/${workspaceId}`),
  } as unknown as Config;
};

// Mock HistoryService
const createMockHistoryService = (): HistoryService => {
  return {
    appendToHistory: mock(() => Promise.resolve(Ok(undefined))),
    getHistory: mock(() => Promise.resolve(Ok([]))),
    updateHistory: mock(() => Promise.resolve(Ok(undefined))),
    truncateAfterMessage: mock(() => Promise.resolve(Ok(undefined))),
    clearHistory: mock(() => Promise.resolve(Ok(undefined))),
  } as unknown as HistoryService;
};

describe("PartialService - Error Recovery", () => {
  let partialService: PartialService;
  let mockConfig: Config;
  let mockHistoryService: HistoryService;

  beforeEach(() => {
    mockConfig = createMockConfig();
    mockHistoryService = createMockHistoryService();
    partialService = new PartialService(mockConfig, mockHistoryService);
  });

  test("commitToHistory should strip error metadata and commit parts from errored partial", async () => {
    const workspaceId = "test-workspace";
    const erroredPartial: MuxMessage = {
      id: "msg-1",
      role: "assistant",
      metadata: {
        historySequence: 1,
        timestamp: Date.now(),
        model: "test-model",
        partial: true,
        error: "Stream error occurred",
        errorType: "network",
      },
      parts: [
        { type: "text", text: "Hello, I was processing when" },
        { type: "text", text: " the error occurred" },
      ],
    };

    // Mock readPartial to return errored partial
    partialService.readPartial = mock(() => Promise.resolve(erroredPartial));

    // Mock deletePartial
    partialService.deletePartial = mock(() => Promise.resolve(Ok(undefined)));

    // Mock getHistory to return no existing messages
    mockHistoryService.getHistory = mock(() => Promise.resolve(Ok([])));

    // Call commitToHistory
    const result = await partialService.commitToHistory(workspaceId);

    // Should succeed
    expect(result.success).toBe(true);

    // Should have called appendToHistory with cleaned metadata (no error/errorType)
    const appendToHistory = mockHistoryService.appendToHistory as ReturnType<typeof mock>;
    expect(appendToHistory).toHaveBeenCalledTimes(1);
    const appendedMessage = appendToHistory.mock.calls[0][1] as MuxMessage;

    expect(appendedMessage.id).toBe("msg-1");
    expect(appendedMessage.parts).toEqual(erroredPartial.parts);
    expect(appendedMessage.metadata?.error).toBeUndefined();
    expect(appendedMessage.metadata?.errorType).toBeUndefined();
    expect(appendedMessage.metadata?.historySequence).toBe(1);

    // Should have deleted the partial after committing
    const deletePartial = partialService.deletePartial as ReturnType<typeof mock>;
    expect(deletePartial).toHaveBeenCalledWith(workspaceId);
  });

  test("commitToHistory should update existing placeholder when errored partial has more parts", async () => {
    const workspaceId = "test-workspace";
    const erroredPartial: MuxMessage = {
      id: "msg-1",
      role: "assistant",
      metadata: {
        historySequence: 1,
        timestamp: Date.now(),
        model: "test-model",
        partial: true,
        error: "Stream error occurred",
        errorType: "network",
      },
      parts: [
        { type: "text", text: "Accumulated content before error" },
        {
          type: "dynamic-tool",
          toolCallId: "call-1",
          toolName: "bash",
          state: "input-available",
          input: { script: "echo test", timeout_secs: 10, display_name: "Test" },
        },
      ],
    };

    const existingPlaceholder: MuxMessage = {
      id: "msg-1",
      role: "assistant",
      metadata: {
        historySequence: 1,
        timestamp: Date.now(),
        model: "test-model",
        partial: true,
      },
      parts: [], // Empty placeholder
    };

    // Mock readPartial to return errored partial
    partialService.readPartial = mock(() => Promise.resolve(erroredPartial));

    // Mock deletePartial
    partialService.deletePartial = mock(() => Promise.resolve(Ok(undefined)));

    // Mock getHistory to return existing placeholder
    mockHistoryService.getHistory = mock(() => Promise.resolve(Ok([existingPlaceholder])));

    // Call commitToHistory
    const result = await partialService.commitToHistory(workspaceId);

    // Should succeed
    expect(result.success).toBe(true);

    // Should have called updateHistory (not append) with cleaned metadata
    const updateHistory = mockHistoryService.updateHistory as ReturnType<typeof mock>;
    const appendToHistory = mockHistoryService.appendToHistory as ReturnType<typeof mock>;
    expect(updateHistory).toHaveBeenCalledTimes(1);
    expect(appendToHistory).not.toHaveBeenCalled();

    const updatedMessage = updateHistory.mock.calls[0][1] as MuxMessage;

    expect(updatedMessage.parts).toEqual(erroredPartial.parts);
    expect(updatedMessage.metadata?.error).toBeUndefined();
    expect(updatedMessage.metadata?.errorType).toBeUndefined();

    // Should have deleted the partial after updating
    const deletePartial = partialService.deletePartial as ReturnType<typeof mock>;
    expect(deletePartial).toHaveBeenCalledWith(workspaceId);
  });

  test("commitToHistory should skip tool-only incomplete partials", async () => {
    const workspaceId = "test-workspace";
    const toolOnlyPartial: MuxMessage = {
      id: "msg-1",
      role: "assistant",
      metadata: {
        historySequence: 1,
        timestamp: Date.now(),
        model: "test-model",
        partial: true,
        error: "Stream interrupted",
        errorType: "network",
      },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "call-1",
          toolName: "bash",
          state: "input-available",
          input: { script: "echo test", timeout_secs: 10, display_name: "Test" },
        },
      ],
    };

    partialService.readPartial = mock(() => Promise.resolve(toolOnlyPartial));
    partialService.deletePartial = mock(() => Promise.resolve(Ok(undefined)));
    mockHistoryService.getHistory = mock(() => Promise.resolve(Ok([])));

    const result = await partialService.commitToHistory(workspaceId);
    expect(result.success).toBe(true);

    const appendToHistory = mockHistoryService.appendToHistory as ReturnType<typeof mock>;
    const updateHistory = mockHistoryService.updateHistory as ReturnType<typeof mock>;
    expect(appendToHistory).not.toHaveBeenCalled();
    expect(updateHistory).not.toHaveBeenCalled();

    const deletePartial = partialService.deletePartial as ReturnType<typeof mock>;
    expect(deletePartial).toHaveBeenCalledWith(workspaceId);
  });
  test("commitToHistory should skip empty errored partial", async () => {
    const workspaceId = "test-workspace";
    const emptyErrorPartial: MuxMessage = {
      id: "msg-1",
      role: "assistant",
      metadata: {
        historySequence: 1,
        timestamp: Date.now(),
        model: "test-model",
        partial: true,
        error: "Network error",
        errorType: "network",
      },
      parts: [], // Empty - no content accumulated before error
    };

    // Mock readPartial to return empty errored partial
    partialService.readPartial = mock(() => Promise.resolve(emptyErrorPartial));

    // Mock deletePartial
    partialService.deletePartial = mock(() => Promise.resolve(Ok(undefined)));

    // Mock getHistory to return no existing messages
    mockHistoryService.getHistory = mock(() => Promise.resolve(Ok([])));

    // Call commitToHistory
    const result = await partialService.commitToHistory(workspaceId);

    // Should succeed
    expect(result.success).toBe(true);

    // Should NOT call appendToHistory for empty message (no value to preserve)
    const appendToHistory = mockHistoryService.appendToHistory as ReturnType<typeof mock>;
    expect(appendToHistory).not.toHaveBeenCalled();

    // Should still delete the partial (cleanup)
    const deletePartial = partialService.deletePartial as ReturnType<typeof mock>;
    expect(deletePartial).toHaveBeenCalledWith(workspaceId);
  });
});

describe("PartialService - Legacy compatibility", () => {
  let tempDir: string;
  let config: Config;
  let partialService: PartialService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-partial-legacy-"));
    config = new Config(tempDir);
    partialService = new PartialService(config, createMockHistoryService());
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("readPartial upgrades legacy cmuxMetadata", async () => {
    const workspaceId = "legacy-ws";
    const workspaceDir = config.getSessionDir(workspaceId);
    await fs.mkdir(workspaceDir, { recursive: true });

    const partialMessage = createMuxMessage("partial-1", "assistant", "legacy", {
      historySequence: 0,
    });
    (partialMessage.metadata as Record<string, unknown>).cmuxMetadata = { type: "normal" };

    const partialPath = path.join(workspaceDir, "partial.json");
    await fs.writeFile(partialPath, JSON.stringify(partialMessage));

    const result = await partialService.readPartial(workspaceId);
    expect(result?.metadata?.muxMetadata?.type).toBe("normal");
  });
});

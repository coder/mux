/* eslint-disable @typescript-eslint/unbound-method */
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { PartialService } from "./partialService";
import type { HistoryService } from "./historyService";
import type { Config } from "@/node/config";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import { createTestHistoryService } from "./testHistoryService";
import * as fs from "fs/promises";
import * as path from "path";

describe("PartialService - Error Recovery", () => {
  let partialService: PartialService;
  let config: Config;
  let historyService: HistoryService;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ config, historyService, cleanup } = await createTestHistoryService());
    partialService = new PartialService(config, historyService);
  });

  afterEach(async () => {
    await cleanup();
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

    // Spy on historyService methods to verify calls
    const appendSpy = spyOn(historyService, "appendToHistory");

    // Call commitToHistory
    const result = await partialService.commitToHistory(workspaceId);

    // Should succeed
    expect(result.success).toBe(true);

    // Should have called appendToHistory with cleaned metadata (no error/errorType)
    expect(appendSpy).toHaveBeenCalledTimes(1);
    const appendedMessage = appendSpy.mock.calls[0][1];

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

    // Seed existing placeholder into history so getHistoryFromLatestBoundary finds it
    await historyService.appendToHistory(workspaceId, existingPlaceholder);

    // Spy on historyService methods AFTER seeding to verify only commitToHistory calls
    const appendSpy = spyOn(historyService, "appendToHistory");
    const updateSpy = spyOn(historyService, "updateHistory");

    // Call commitToHistory
    const result = await partialService.commitToHistory(workspaceId);

    // Should succeed
    expect(result.success).toBe(true);

    // Should have called updateHistory (not append) with cleaned metadata
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).not.toHaveBeenCalled();

    const updatedMessage = updateSpy.mock.calls[0][1];

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

    // Spy on historyService methods to verify calls
    const appendSpy = spyOn(historyService, "appendToHistory");
    const updateSpy = spyOn(historyService, "updateHistory");

    const result = await partialService.commitToHistory(workspaceId);
    expect(result.success).toBe(true);

    expect(appendSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();

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

    // Spy on historyService methods to verify calls
    const appendSpy = spyOn(historyService, "appendToHistory");

    // Call commitToHistory
    const result = await partialService.commitToHistory(workspaceId);

    // Should succeed
    expect(result.success).toBe(true);

    // Should NOT call appendToHistory for empty message (no value to preserve)
    expect(appendSpy).not.toHaveBeenCalled();

    // Should still delete the partial (cleanup)
    const deletePartial = partialService.deletePartial as ReturnType<typeof mock>;
    expect(deletePartial).toHaveBeenCalledWith(workspaceId);
  });
});

describe("PartialService - Legacy compatibility", () => {
  let config: Config;
  let partialService: PartialService;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    let historyService: HistoryService;
    ({ config, historyService, cleanup } = await createTestHistoryService());
    partialService = new PartialService(config, historyService);
  });

  afterEach(async () => {
    await cleanup();
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

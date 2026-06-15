import { describe, expect, it } from "bun:test";

import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

import type { CompactionCompletionMetadata } from "@/common/types/compaction";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { Config } from "@/node/config";
import { MemoryMetaService } from "./memoryMeta";
import { MemoryService, type MemoryScopeContext } from "./memoryService";
import { TestTempDir } from "./tools/testHelpers";
import { runMemoryHarvest } from "./memoryHarvest";

const INBOX_PATH = "/memories/workspace/harvest/compaction-1.md";

function finishChunk(outputTokens = 0): LanguageModelV3StreamPart {
  return {
    type: "finish",
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
    },
  };
}

function toolFinishChunk(): LanguageModelV3StreamPart {
  return {
    type: "finish",
    finishReason: { unified: "tool-calls", raw: "tool-calls" },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 0, reasoning: 0 },
    },
  };
}

function harvestToolCall(candidates: unknown[]): LanguageModelV3StreamPart {
  return {
    type: "tool-call",
    toolCallId: "candidates-1",
    toolName: "submit_memory_candidates",
    input: JSON.stringify({ candidates }),
  };
}

function modelFromChunks(chunks: LanguageModelV3StreamPart[]): MockLanguageModelV3 {
  let streamCount = 0;
  return new MockLanguageModelV3({
    doStream: () => {
      streamCount++;
      return Promise.resolve({
        stream: simulateReadableStream({ chunks: streamCount === 1 ? chunks : [finishChunk(1)] }),
      });
    },
  });
}

function failingModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: () =>
      Promise.resolve({
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          pull(controller) {
            controller.error(new Error("provider exploded"));
          },
        }),
      }),
  });
}

interface Fixture extends Disposable {
  memoryService: MemoryService;
  ctx: MemoryScopeContext;
  metadata: CompactionCompletionMetadata;
  messages: MuxMessage[];
  summary: MuxMessage;
}

function createFixture(): Fixture {
  const tempDir = new TestTempDir("test-memory-harvest");
  const config = new Config(tempDir.path);
  const metaService = new MemoryMetaService(tempDir.path);
  const memoryService = new MemoryService(config, metaService);
  const ctx: MemoryScopeContext = {
    runtime: null,
    checkoutCwd: "",
    workspaceId: "ws-harvest",
    projectPath: "/projects/demo",
  };
  const summary = createMuxMessage("summary-1", "assistant", "The user prefers concise tests.", {
    historySequence: 2,
    compactionBoundary: true,
    compacted: "user",
    compactionEpoch: 1,
  });

  return {
    memoryService,
    ctx,
    metadata: {
      workspaceId: "ws-harvest",
      summaryMessageId: "summary-1",
      summaryHistorySequence: 2,
      compactionEpoch: 1,
      compactionRequestMessageId: "compact-request",
    },
    messages: [
      createMuxMessage("m1", "user", "Please remember that I prefer concise tests.", {
        historySequence: 0,
      }),
    ],
    summary,
    [Symbol.dispose]() {
      tempDir[Symbol.dispose]();
    },
  };
}

async function runHarvest(
  fixture: Fixture,
  model: MockLanguageModelV3
): Promise<Awaited<ReturnType<typeof runMemoryHarvest>>> {
  return runMemoryHarvest({
    model,
    agentBody: "Harvest durable memories from the transcript.",
    memoryService: fixture.memoryService,
    ctx: fixture.ctx,
    completionMetadata: fixture.metadata,
    messages: fixture.messages,
    summary: fixture.summary,
  });
}

describe("runMemoryHarvest", () => {
  it("writes accepted candidates to a workspace harvest inbox through MemoryService", async () => {
    using fixture = createFixture();

    const result = await runHarvest(
      fixture,
      modelFromChunks([
        harvestToolCall([
          {
            category: "preference",
            memoryText: "The user prefers concise tests.",
            evidenceMessageIds: ["m1"],
            confidence: 0.95,
            rationale: "The user stated this as a durable preference.",
          },
        ]),
        toolFinishChunk(),
      ])
    );

    expect(result.streamError).toBeUndefined();
    expect(result.acceptedCandidates).toBe(1);
    expect(result.skippedCandidates).toBe(0);

    const file = await fixture.memoryService.readFileWithSha(fixture.ctx, INBOX_PATH);
    expect(file.success).toBe(true);
    if (file.success) {
      expect(file.data.content).toContain("The user prefers concise tests.");
      expect(file.data.content).toContain("m1");
      expect(file.data.content).toContain("summary-1");
    }
  });

  it("rejects low-confidence, out-of-evidence, and secret-looking candidates", async () => {
    using fixture = createFixture();

    const result = await runHarvest(
      fixture,
      modelFromChunks([
        harvestToolCall([
          {
            category: "preference",
            memoryText: "The user prefers concise tests.",
            evidenceMessageIds: ["m1"],
            confidence: 0.95,
            rationale: "The user stated this as a durable preference.",
          },
          {
            category: "workflow",
            memoryText: "The user might possibly prefer verbose tests.",
            evidenceMessageIds: ["m1"],
            confidence: 0.2,
            rationale: "Weak inference only.",
          },
          {
            category: "project",
            memoryText: "The project requires imaginary evidence.",
            evidenceMessageIds: ["not-in-transcript"],
            confidence: 0.95,
            rationale: "The model invented the evidence id.",
          },
          {
            category: "environment",
            memoryText: "API token sk-1234567890abcdef should be remembered.",
            evidenceMessageIds: ["m1"],
            confidence: 0.95,
            rationale: "This is secret-looking data and must be skipped.",
          },
        ]),
        toolFinishChunk(),
      ])
    );

    expect(result.streamError).toBeUndefined();
    expect(result.acceptedCandidates).toBe(1);
    expect(result.skippedCandidates).toBe(3);

    const file = await fixture.memoryService.readFileWithSha(fixture.ctx, INBOX_PATH);
    expect(file.success).toBe(true);
    if (file.success) {
      expect(file.data.content).toContain("concise tests");
      expect(file.data.content).not.toContain("possibly prefer verbose");
      expect(file.data.content).not.toContain("imaginary evidence");
      expect(file.data.content).not.toContain("sk-1234567890abcdef");
    }
  });

  it("does not create an inbox when the model submits no candidates", async () => {
    using fixture = createFixture();

    const result = await runHarvest(fixture, modelFromChunks([finishChunk()]));

    expect(result.streamError).toBeUndefined();
    expect(result.acceptedCandidates).toBe(0);
    expect(result.skippedCandidates).toBe(0);
    expect(await fixture.memoryService.readFileWithSha(fixture.ctx, INBOX_PATH)).toMatchObject({
      success: false,
    });
  });

  it("reports stream failures without writing an inbox", async () => {
    using fixture = createFixture();

    const result = await runHarvest(fixture, failingModel());

    expect(result.streamError).toContain("provider exploded");
    expect(result.acceptedCandidates).toBe(0);
    expect(await fixture.memoryService.readFileWithSha(fixture.ctx, INBOX_PATH)).toMatchObject({
      success: false,
    });
  });
});

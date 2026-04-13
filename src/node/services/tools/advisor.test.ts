import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import * as ai from "ai";
import type { LanguageModel, ToolExecutionOptions } from "ai";

import {
  ADVISOR_HANDOFF_MAX_REASONING_CHARS,
  ADVISOR_HANDOFF_MAX_TEXT_CHARS,
} from "@/common/constants/advisor";
import type { ModelMessage } from "@/common/types/message";
import type { AdvisorToolCallSnapshot, ToolModelUsageEvent } from "@/common/utils/tools/tools";
import { log } from "@/node/services/log";
import { createAdvisorTool } from "./advisor";
import { TestTempDir, createTestToolConfig } from "./testHelpers";

const ADVISOR_MODEL = "anthropic:claude-sonnet-4-20250514";
const mockToolCallOptions: ToolExecutionOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

function createTranscript(): ModelMessage[] {
  return [{ role: "user", content: "hello" }];
}

function createSnapshot(overrides?: Partial<AdvisorToolCallSnapshot>): AdvisorToolCallSnapshot {
  return {
    toolCallId: "test-call-id",
    toolName: "advisor",
    input: { question: "How should we proceed?" },
    stepText: "current-step commentary",
    stepReasoning: "current-step reasoning",
    ...overrides,
  };
}

function createToolConfig(
  tempDir: string,
  options?: {
    reportModelUsage?: Parameters<typeof createAdvisorTool>[0]["reportModelUsage"];
    transcript?: ModelMessage[];
    snapshot?: AdvisorToolCallSnapshot | undefined;
    maxOutputTokens?: number;
  }
) {
  const createModel = mock(() => Promise.resolve({} as LanguageModel));
  const transcript = options?.transcript ?? createTranscript();
  const getTranscriptSnapshot = mock(() => transcript);
  const takeToolCallSnapshot = mock((_toolCallId: string) => options?.snapshot);
  const config = {
    ...createTestToolConfig(tempDir),
    reportModelUsage: options?.reportModelUsage,
    advisorRuntime: {
      advisorModelString: ADVISOR_MODEL,
      reasoningLevel: "medium",
      maxUsesPerTurn: 3,
      maxOutputTokens: options?.maxOutputTokens,
      getTranscriptSnapshot,
      takeToolCallSnapshot,
      createModel,
      abortSignal: new AbortController().signal,
    },
  };

  return { config, createModel, getTranscriptSnapshot, takeToolCallSnapshot, transcript };
}

function mockGenerateTextSuccess(result: {
  text: string;
  usage: LanguageModelV2Usage;
  providerMetadata?: Record<string, unknown>;
}) {
  return spyOn(ai, "generateText").mockResolvedValue(
    result as Awaited<ReturnType<typeof ai.generateText>>
  );
}

function getGenerateTextArgs(
  generateTextSpy: ReturnType<typeof mockGenerateTextSuccess>
): Parameters<typeof ai.generateText>[0] {
  const args = generateTextSpy.mock.calls[0]?.[0];
  expect(args).toBeDefined();
  if (!args) {
    throw new Error("Expected generateText to be called");
  }

  return args;
}

function getGenerateTextMessages(
  generateTextSpy: ReturnType<typeof mockGenerateTextSuccess>
): ModelMessage[] {
  const { messages } = getGenerateTextArgs(generateTextSpy);
  expect(messages).toBeDefined();
  if (!messages) {
    throw new Error("Expected generateText to receive messages");
  }

  return messages;
}

function getHandoffText(generateTextSpy: ReturnType<typeof mockGenerateTextSuccess>): string {
  const handoffMessage = getGenerateTextMessages(generateTextSpy).at(-1);
  expect(handoffMessage).toBeDefined();
  expect(handoffMessage?.role).toBe("user");
  if (handoffMessage?.role !== "user") {
    throw new Error("Expected a user handoff message");
  }

  expect(typeof handoffMessage.content).toBe("string");
  if (typeof handoffMessage.content !== "string") {
    throw new Error("Expected handoff content to be plain text");
  }

  return handoffMessage.content;
}

function extractLabeledBlock(handoffText: string, label: string): string {
  const marker = `**${label}:**\n`;
  const start = handoffText.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const contentStart = start + marker.length;
  const nextSection = handoffText.indexOf("\n\n**", contentStart);
  return nextSection === -1
    ? handoffText.slice(contentStart)
    : handoffText.slice(contentStart, nextSection);
}

describe("advisor tool", () => {
  afterEach(() => {
    mock.restore();
  });

  it("reports model usage after a successful advisor call", async () => {
    using tempDir = new TestTempDir("advisor-tool-report-usage");
    const usage: LanguageModelV2Usage = {
      inputTokens: 120,
      cachedInputTokens: 10,
      outputTokens: 45,
      reasoningTokens: 5,
      totalTokens: 165,
    };
    const providerMetadata = {
      anthropic: { cacheCreationInputTokens: 6 },
    };
    const reportModelUsage = mock((_event: ToolModelUsageEvent) => undefined);
    const { config, createModel } = createToolConfig(tempDir.path, { reportModelUsage });
    const generateTextSpy = mockGenerateTextSuccess({
      text: "Focus on the highest-risk dependency edges first.",
      usage,
      providerMetadata,
    });

    const tool = createAdvisorTool(config);
    const rawResult: unknown = await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(createModel).toHaveBeenCalledWith(ADVISOR_MODEL);
    expect(generateTextSpy).toHaveBeenCalledTimes(1);
    expect(rawResult).toEqual({
      type: "advice",
      advice: "Focus on the highest-risk dependency edges first.",
      advisorModel: ADVISOR_MODEL,
      reasoningLevel: "medium",
      remainingUses: 2,
    });
    expect(reportModelUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "tool",
        toolName: "advisor",
        model: ADVISOR_MODEL,
        usage,
        providerMetadata,
        toolCallId: "test-call-id",
      })
    );

    const event = reportModelUsage.mock.calls[0]?.[0];
    expect(event?.toolName).toBe("advisor");
    expect(event?.model).toBe(ADVISOR_MODEL);
    expect(typeof event?.timestamp).toBe("number");
  });

  it("falls back to the raw transcript when there is no question or same-step snapshot", async () => {
    using tempDir = new TestTempDir("advisor-tool-transcript-fallback");
    const transcript = createTranscript();
    const { config } = createToolConfig(tempDir.path, { transcript, snapshot: undefined });
    const generateTextSpy = mockGenerateTextSuccess({
      text: "Proceed with the existing plan.",
      usage: {
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
      },
    });

    const tool = createAdvisorTool(config);
    await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(getGenerateTextMessages(generateTextSpy)).toEqual(transcript);
  });

  it("appends a question-only advisor handoff when a normalized question is provided", async () => {
    using tempDir = new TestTempDir("advisor-tool-question-handoff");
    const question = "Should we split this refactor?";
    const { config, transcript } = createToolConfig(tempDir.path, { snapshot: undefined });
    const generateTextSpy = mockGenerateTextSuccess({
      text: "Split the work if each piece can be reviewed independently.",
      usage: {
        inputTokens: 50,
        outputTokens: 20,
        totalTokens: 70,
      },
    });

    const tool = createAdvisorTool(config);
    await Promise.resolve(tool.execute!({ question: `  ${question}  ` }, mockToolCallOptions));

    expect(getGenerateTextMessages(generateTextSpy)).toEqual([
      ...transcript,
      {
        role: "user",
        content: `## Advisor Handoff\n\n**Question:** ${question}`,
      },
    ]);
  });

  it("appends the full advisor handoff when question and same-step snapshot context exist", async () => {
    using tempDir = new TestTempDir("advisor-tool-full-handoff");
    const question = "What's the best approach for handling concurrent file writes?";
    const snapshot = createSnapshot({
      input: { question },
      stepText: "Visible commentary about the current step.",
      stepReasoning: "Internal reasoning about coordination and race conditions.",
    });
    const { config, transcript } = createToolConfig(tempDir.path, { snapshot });
    const generateTextSpy = mockGenerateTextSuccess({
      text: "Use a write queue around the shared file handle.",
      usage: {
        inputTokens: 60,
        outputTokens: 25,
        totalTokens: 85,
      },
    });

    const tool = createAdvisorTool(config);
    await Promise.resolve(tool.execute!({ question }, mockToolCallOptions));

    expect(getGenerateTextMessages(generateTextSpy)).toEqual([
      ...transcript,
      {
        role: "user",
        content:
          "## Advisor Handoff\n\n" +
          `**Question:** ${question}\n\n` +
          "**Current-step commentary:**\nVisible commentary about the current step.\n\n" +
          "**Current-step reasoning:**\nInternal reasoning about coordination and race conditions.\n\n" +
          `**Pending tool call:**\nadvisor(${JSON.stringify(snapshot.input)})`,
      },
    ]);
  });

  it("consumes the frozen snapshot exactly once for the current tool call", async () => {
    using tempDir = new TestTempDir("advisor-tool-snapshot-consumed");
    const { config, takeToolCallSnapshot } = createToolConfig(tempDir.path, {
      snapshot: createSnapshot(),
    });
    mockGenerateTextSuccess({
      text: "Continue with the current architecture.",
      usage: {
        inputTokens: 25,
        outputTokens: 12,
        totalTokens: 37,
      },
    });

    const tool = createAdvisorTool(config);
    await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(takeToolCallSnapshot).toHaveBeenCalledTimes(1);
    expect(takeToolCallSnapshot).toHaveBeenCalledWith(mockToolCallOptions.toolCallId);
  });

  it("tail-truncates long same-step commentary and reasoning in the handoff", async () => {
    using tempDir = new TestTempDir("advisor-tool-handoff-truncation");
    const longStepText = `discard-text-${"a".repeat(ADVISOR_HANDOFF_MAX_TEXT_CHARS)}TAIL-TEXT`;
    const longStepReasoning = `discard-reasoning-${"b".repeat(ADVISOR_HANDOFF_MAX_REASONING_CHARS)}TAIL-REASONING`;
    const snapshot = createSnapshot({
      stepText: longStepText,
      stepReasoning: longStepReasoning,
    });
    const { config } = createToolConfig(tempDir.path, { snapshot });
    const generateTextSpy = mockGenerateTextSuccess({
      text: "Prefer a deterministic queue.",
      usage: {
        inputTokens: 80,
        outputTokens: 18,
        totalTokens: 98,
      },
    });

    const tool = createAdvisorTool(config);
    await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    const handoffText = getHandoffText(generateTextSpy);
    const truncatedStepText = extractLabeledBlock(handoffText, "Current-step commentary");
    const truncatedStepReasoning = extractLabeledBlock(handoffText, "Current-step reasoning");

    expect(truncatedStepText).toBe(
      `...${longStepText.slice(-(ADVISOR_HANDOFF_MAX_TEXT_CHARS - 3))}`
    );
    expect(truncatedStepText.length).toBe(ADVISOR_HANDOFF_MAX_TEXT_CHARS);
    expect(truncatedStepText).not.toContain("discard-text-");

    expect(truncatedStepReasoning).toBe(
      `...${longStepReasoning.slice(-(ADVISOR_HANDOFF_MAX_REASONING_CHARS - 3))}`
    );
    expect(truncatedStepReasoning.length).toBe(ADVISOR_HANDOFF_MAX_REASONING_CHARS);
    expect(truncatedStepReasoning).not.toContain("discard-reasoning-");
  });

  it("skips the handoff when the frozen snapshot has no visible same-step content", async () => {
    using tempDir = new TestTempDir("advisor-tool-empty-snapshot-fields");
    const transcript = createTranscript();
    const { config } = createToolConfig(tempDir.path, {
      transcript,
      snapshot: createSnapshot({ stepText: "", stepReasoning: "" }),
    });
    const generateTextSpy = mockGenerateTextSuccess({
      text: "No extra context was needed.",
      usage: {
        inputTokens: 15,
        outputTokens: 7,
        totalTokens: 22,
      },
    });

    const tool = createAdvisorTool(config);
    await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(getGenerateTextMessages(generateTextSpy)).toEqual(transcript);
  });

  it("passes maxOutputTokens to generateText when the advisor runtime is capped", async () => {
    using tempDir = new TestTempDir("advisor-tool-max-output-tokens-limited");
    const { config } = createToolConfig(tempDir.path, { maxOutputTokens: 1000 });
    const generateTextSpy = mockGenerateTextSuccess({
      text: "Keep the recommendation concise.",
      usage: {
        inputTokens: 24,
        outputTokens: 12,
        totalTokens: 36,
      },
    });

    const tool = createAdvisorTool(config);
    await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(generateTextSpy).toHaveBeenCalledTimes(1);
    const generateTextArgs = generateTextSpy.mock.calls[0]?.[0];
    expect(generateTextArgs?.maxOutputTokens).toBe(1000);
  });

  it("omits maxOutputTokens from generateText when the advisor runtime is unlimited", async () => {
    using tempDir = new TestTempDir("advisor-tool-max-output-tokens-unlimited");
    const { config } = createToolConfig(tempDir.path, { maxOutputTokens: undefined });
    const generateTextSpy = mockGenerateTextSuccess({
      text: "Return the full analysis.",
      usage: {
        inputTokens: 30,
        outputTokens: 18,
        totalTokens: 48,
      },
    });

    const tool = createAdvisorTool(config);
    await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(generateTextSpy).toHaveBeenCalledTimes(1);
    const generateTextArgs = generateTextSpy.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(generateTextArgs?.maxOutputTokens).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(generateTextArgs ?? {}, "maxOutputTokens")).toBe(
      false
    );
  });

  it("does not report usage when the advisor model call fails", async () => {
    using tempDir = new TestTempDir("advisor-tool-no-usage-on-error");
    const reportModelUsage = mock((_event: ToolModelUsageEvent) => undefined);
    const { config } = createToolConfig(tempDir.path, { reportModelUsage });
    spyOn(ai, "generateText").mockRejectedValue(new Error("model unavailable"));

    const tool = createAdvisorTool(config);
    const rawResult: unknown = await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(rawResult).toEqual({
      type: "error",
      isError: true,
      message: "Advisor request failed: model unavailable",
    });
    expect(reportModelUsage).not.toHaveBeenCalled();
  });

  it("swallows synchronous usage reporting failures and logs them", async () => {
    using tempDir = new TestTempDir("advisor-tool-report-failure");
    const usage: LanguageModelV2Usage = {
      inputTokens: 40,
      outputTokens: 10,
      totalTokens: 50,
    };
    const reportModelUsage = mock((_event: ToolModelUsageEvent) => {
      throw new Error("report callback failed");
    });
    const debugSpy = spyOn(log, "debug").mockImplementation(() => undefined);
    const { config } = createToolConfig(tempDir.path, { reportModelUsage });
    mockGenerateTextSuccess({
      text: "Keep the implementation narrow.",
      usage,
    });

    const tool = createAdvisorTool(config);
    const rawResult: unknown = await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(rawResult).toEqual({
      type: "advice",
      advice: "Keep the implementation narrow.",
      advisorModel: ADVISOR_MODEL,
      reasoningLevel: "medium",
      remainingUses: 2,
    });
    expect(debugSpy).toHaveBeenCalledWith(
      "advisor: failed to report model usage",
      expect.objectContaining({ error: "report callback failed" })
    );
  });
});

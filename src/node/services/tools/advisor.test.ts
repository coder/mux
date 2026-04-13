import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import * as ai from "ai";
import type { LanguageModel, ToolExecutionOptions } from "ai";

import type { ToolModelUsageEvent } from "@/common/utils/tools/tools";
import { log } from "@/node/services/log";
import type { ModelMessage } from "@/common/types/message";
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

function createToolConfig(
  tempDir: string,
  options?: {
    reportModelUsage?: Parameters<typeof createAdvisorTool>[0]["reportModelUsage"];
    maxOutputTokens?: number;
  }
) {
  const createModel = mock(() => Promise.resolve({} as LanguageModel));
  const config = {
    ...createTestToolConfig(tempDir),
    reportModelUsage: options?.reportModelUsage,
    advisorRuntime: {
      advisorModelString: ADVISOR_MODEL,
      reasoningLevel: "medium",
      maxUsesPerTurn: 3,
      maxOutputTokens: options?.maxOutputTokens,
      getTranscriptSnapshot: createTranscript,
      createModel,
      abortSignal: new AbortController().signal,
    },
  };

  return { config, createModel };
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

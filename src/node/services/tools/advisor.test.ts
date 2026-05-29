import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import * as ai from "ai";
import type { LanguageModel, ToolExecutionOptions } from "ai";

import {
  ADVISOR_DEFAULT_MAX_USES_PER_TURN,
  ADVISOR_HANDOFF_MAX_REASONING_CHARS,
  ADVISOR_HANDOFF_MAX_TEXT_CHARS,
} from "@/common/constants/advisor";
import type { AdvisorPackage } from "@/common/types/advisor";
import type { ModelMessage } from "@/common/types/message";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import type { AdvisorToolCallSnapshot, ToolModelUsageEvent } from "@/common/utils/tools/tools";
import { log } from "@/node/services/log";
import { createAdvisorTool } from "./advisor";
import { TestTempDir, createTestToolConfig } from "./testHelpers";

const ADVISOR_MODEL = "anthropic:claude-sonnet-4-20250514";
const DEFAULT_ADVISOR_NAME = "default";

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
    input: { advisor_name: DEFAULT_ADVISOR_NAME, question: "How should we proceed?" },
    stepText: "current-step commentary",
    stepReasoning: "current-step reasoning",
    ...overrides,
  };
}

function buildAdvisor(overrides?: Partial<AdvisorPackage>): AdvisorPackage {
  return {
    scope: "project",
    directoryName: DEFAULT_ADVISOR_NAME,
    frontmatter: {
      description: "Default test advisor.",
      model: ADVISOR_MODEL,
      thinking: "medium",
    },
    body: "",
    sourcePath: `/tmp/.mux/advisors/${DEFAULT_ADVISOR_NAME}/ADVISOR.md`,
    ...overrides,
  };
}

function createToolConfig(
  tempDir: string,
  options?: {
    advisors?: AdvisorPackage[];
    defaultMaxUsesPerTurn?: number;
    reportModelUsage?: (event: ToolModelUsageEvent) => void;
    transcript?: ModelMessage[];
    snapshot?: AdvisorToolCallSnapshot | undefined;
    emitChatEvent?: (event: WorkspaceChatMessage) => void;
    workspaceId?: string;
  }
) {
  const createModel = mock(() => Promise.resolve({} as LanguageModel));
  const transcript = options?.transcript ?? createTranscript();
  const getTranscriptSnapshot = mock(() => transcript);
  const takeToolCallSnapshot = mock((_toolCallId: string) => options?.snapshot);
  const advisors = options?.advisors ?? [buildAdvisor()];
  const config = {
    ...createTestToolConfig(tempDir, { workspaceId: options?.workspaceId }),
    emitChatEvent: options?.emitChatEvent,
    reportModelUsage: options?.reportModelUsage,
    advisorRuntime: {
      advisors,
      defaultMaxUsesPerTurn: options?.defaultMaxUsesPerTurn ?? ADVISOR_DEFAULT_MAX_USES_PER_TURN,
      getTranscriptSnapshot,
      takeToolCallSnapshot,
      createModel,
      abortSignal: new AbortController().signal,
    },
  };

  return { config, createModel, getTranscriptSnapshot, takeToolCallSnapshot, transcript, advisors };
}

type StreamTextArgs = Parameters<typeof ai.streamText>[0];
type StreamTextResult = ReturnType<typeof ai.streamText>;
type StreamTextFinishReason = Awaited<StreamTextResult["finishReason"]>;

function mockStreamTextSuccess(result: {
  text: string;
  usage: LanguageModelV2Usage;
  providerMetadata?: Record<string, unknown>;
  chunks?: Array<{ type: string; text?: string; delta?: string; textDelta?: string }>;
  finishReason?: StreamTextFinishReason;
  streamError?: Error;
}) {
  return spyOn(ai, "streamText").mockImplementation(((args: StreamTextArgs) => {
    const text = (async () => {
      for (const chunk of result.chunks ?? []) {
        await args.onChunk?.({ chunk } as Parameters<NonNullable<typeof args.onChunk>>[0]);
      }
      if (result.streamError) {
        await args.onError?.({ error: result.streamError });
      }
      return result.text;
    })();

    return {
      text,
      finishReason: Promise.resolve(result.finishReason ?? "stop"),
      usage: Promise.resolve(result.usage),
      providerMetadata: Promise.resolve(result.providerMetadata),
    } as unknown as StreamTextResult;
  }) as unknown as typeof ai.streamText);
}

function getStreamTextArgs(
  streamTextSpy: ReturnType<typeof mockStreamTextSuccess>
): Parameters<typeof ai.streamText>[0] {
  const args = streamTextSpy.mock.calls[0]?.[0];
  expect(args).toBeDefined();
  if (!args) {
    throw new Error("Expected streamText to be called");
  }
  return args;
}

function getStreamTextMessages(
  streamTextSpy: ReturnType<typeof mockStreamTextSuccess>
): ModelMessage[] {
  const { messages } = getStreamTextArgs(streamTextSpy);
  expect(messages).toBeDefined();
  if (!messages) {
    throw new Error("Expected streamText to receive messages");
  }
  return messages;
}

function getHandoffText(streamTextSpy: ReturnType<typeof mockStreamTextSuccess>): string {
  const handoffMessage = getStreamTextMessages(streamTextSpy).at(-1);
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
  // Single-line labels (e.g. Question) use `**Label:** value`; multi-line
  // sections (e.g. Current-step commentary) use `**Label:**\nvalue`. Match
  // either by stripping the label prefix and any single separator.
  const labelMarker = `**${label}:**`;
  const start = handoffText.indexOf(labelMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  let contentStart = start + labelMarker.length;
  if (handoffText[contentStart] === " " || handoffText[contentStart] === "\n") {
    contentStart += 1;
  }
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
    const providerMetadata = { anthropic: { cacheCreationInputTokens: 6 } };
    const reportModelUsage = mock((_event: ToolModelUsageEvent) => undefined);
    const { config, createModel } = createToolConfig(tempDir.path, { reportModelUsage });
    const streamTextSpy = mockStreamTextSuccess({
      text: "Focus on the highest-risk dependency edges first.",
      usage,
      providerMetadata,
    });

    const tool = createAdvisorTool(config);
    const rawResult: unknown = await Promise.resolve(
      tool.execute!({ advisor_name: DEFAULT_ADVISOR_NAME }, mockToolCallOptions)
    );

    expect(createModel).toHaveBeenCalledWith(ADVISOR_MODEL);
    expect(streamTextSpy).toHaveBeenCalledTimes(1);
    expect(rawResult).toMatchObject({
      type: "advice",
      advice: "Focus on the highest-risk dependency edges first.",
      advisorName: DEFAULT_ADVISOR_NAME,
      advisorModel: ADVISOR_MODEL,
      reasoningLevel: "medium",
    });

    expect(reportModelUsage).toHaveBeenCalledTimes(1);
    const reportedEvent = reportModelUsage.mock.calls[0]?.[0];
    expect(reportedEvent).toMatchObject({
      source: "tool",
      toolName: "advisor",
      model: ADVISOR_MODEL,
      usage,
      providerMetadata,
      toolCallId: "test-call-id",
    });
  });

  it("returns an error when the requested advisor name is unknown", async () => {
    using tempDir = new TestTempDir("advisor-tool-unknown-name");
    const { config } = createToolConfig(tempDir.path);
    const streamTextSpy = spyOn(ai, "streamText");

    const tool = createAdvisorTool(config);
    const result = (await Promise.resolve(
      tool.execute!({ advisor_name: "no-such-advisor" }, mockToolCallOptions)
    )) as { type: string; message: string; isError?: boolean };

    expect(streamTextSpy).not.toHaveBeenCalled();
    expect(result.type).toBe("error");
    expect(result.isError).toBe(true);
    // Error message must include the configured advisor list so the model can
    // self-correct in the same turn.
    expect(result.message).toContain(DEFAULT_ADVISOR_NAME);
  });

  it("enforces the per-advisor max_uses_per_turn override", async () => {
    using tempDir = new TestTempDir("advisor-tool-per-advisor-limit");
    const advisor = buildAdvisor({
      frontmatter: {
        description: "Cap-1 advisor.",
        model: ADVISOR_MODEL,
        max_uses_per_turn: 1,
      },
    });
    const { config } = createToolConfig(tempDir.path, { advisors: [advisor] });
    mockStreamTextSuccess({
      text: "ok",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } satisfies LanguageModelV2Usage,
    });

    const tool = createAdvisorTool(config);
    const first = (await Promise.resolve(
      tool.execute!({ advisor_name: DEFAULT_ADVISOR_NAME }, { toolCallId: "call-1", messages: [] })
    )) as { type: string; remainingUses: number | null };
    expect(first.type).toBe("advice");
    expect(first.remainingUses).toBe(0);

    const second = (await Promise.resolve(
      tool.execute!({ advisor_name: DEFAULT_ADVISOR_NAME }, { toolCallId: "call-2", messages: [] })
    )) as { type: string; message: string };
    expect(second.type).toBe("limit_reached");
    expect(second.message).toContain(DEFAULT_ADVISOR_NAME);
  });

  it("falls back to the runtime defaultMaxUsesPerTurn when the advisor does not override", async () => {
    using tempDir = new TestTempDir("advisor-tool-default-limit");
    const { config } = createToolConfig(tempDir.path, { defaultMaxUsesPerTurn: 2 });
    mockStreamTextSuccess({
      text: "ok",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } satisfies LanguageModelV2Usage,
    });

    const tool = createAdvisorTool(config);
    const first = (await Promise.resolve(
      tool.execute!({ advisor_name: DEFAULT_ADVISOR_NAME }, { toolCallId: "call-1", messages: [] })
    )) as { remainingUses: number | null };
    expect(first.remainingUses).toBe(1);

    const second = (await Promise.resolve(
      tool.execute!({ advisor_name: DEFAULT_ADVISOR_NAME }, { toolCallId: "call-2", messages: [] })
    )) as { remainingUses: number | null };
    expect(second.remainingUses).toBe(0);

    const third = (await Promise.resolve(
      tool.execute!({ advisor_name: DEFAULT_ADVISOR_NAME }, { toolCallId: "call-3", messages: [] })
    )) as { type: string };
    expect(third.type).toBe("limit_reached");
  });

  it("treats max_uses_per_turn === null as unlimited", async () => {
    using tempDir = new TestTempDir("advisor-tool-unlimited");
    const advisor = buildAdvisor({
      frontmatter: {
        description: "Unlimited advisor.",
        model: ADVISOR_MODEL,
        max_uses_per_turn: null,
      },
    });
    const { config } = createToolConfig(tempDir.path, { advisors: [advisor] });
    mockStreamTextSuccess({
      text: "ok",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } satisfies LanguageModelV2Usage,
    });

    const tool = createAdvisorTool(config);
    for (let i = 0; i < 5; i++) {
      const result = (await Promise.resolve(
        tool.execute!(
          { advisor_name: DEFAULT_ADVISOR_NAME },
          { toolCallId: `call-${i}`, messages: [] }
        )
      )) as { type: string; remainingUses: number | null };
      expect(result.type).toBe("advice");
      expect(result.remainingUses).toBeNull();
    }
  });

  it("composes the advisor body onto the base system prompt", async () => {
    using tempDir = new TestTempDir("advisor-tool-body-compose");
    const advisor = buildAdvisor({
      body: "Always cite recent papers. Prefer formal definitions over hand-wavy analogies.",
    });
    const { config } = createToolConfig(tempDir.path, { advisors: [advisor] });
    const streamTextSpy = mockStreamTextSuccess({
      text: "ok",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } satisfies LanguageModelV2Usage,
    });

    const tool = createAdvisorTool(config);
    await Promise.resolve(
      tool.execute!({ advisor_name: DEFAULT_ADVISOR_NAME }, mockToolCallOptions)
    );

    const system = getStreamTextArgs(streamTextSpy).system;
    expect(typeof system).toBe("string");
    expect(system as string).toContain("strategic advisor for the calling assistant");
    expect(system as string).toContain("cite recent papers");
  });

  it("appends a question-only advisor handoff when a normalized question is provided", async () => {
    using tempDir = new TestTempDir("advisor-tool-question-only");
    const { config } = createToolConfig(tempDir.path);
    const streamTextSpy = mockStreamTextSuccess({
      text: "ok",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } satisfies LanguageModelV2Usage,
    });

    const tool = createAdvisorTool(config);
    await Promise.resolve(
      tool.execute!(
        { advisor_name: DEFAULT_ADVISOR_NAME, question: "  How should we proceed?  " },
        mockToolCallOptions
      )
    );

    const handoffText = getHandoffText(streamTextSpy);
    expect(handoffText).toContain("## Advisor Handoff");
    expect(extractLabeledBlock(handoffText, "Question")).toBe("How should we proceed?");
  });

  it("includes same-step context + tool call when a frozen snapshot is available", async () => {
    using tempDir = new TestTempDir("advisor-tool-full-handoff");
    const snapshot = createSnapshot();
    const { config } = createToolConfig(tempDir.path, { snapshot });
    const streamTextSpy = mockStreamTextSuccess({
      text: "ok",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } satisfies LanguageModelV2Usage,
    });

    const tool = createAdvisorTool(config);
    await Promise.resolve(
      tool.execute!(
        { advisor_name: DEFAULT_ADVISOR_NAME, question: "How should we proceed?" },
        mockToolCallOptions
      )
    );

    const handoffText = getHandoffText(streamTextSpy);
    expect(extractLabeledBlock(handoffText, "Question")).toBe("How should we proceed?");
    expect(extractLabeledBlock(handoffText, "Current-step commentary")).toBe(
      "current-step commentary"
    );
    expect(extractLabeledBlock(handoffText, "Current-step reasoning")).toBe(
      "current-step reasoning"
    );
    expect(extractLabeledBlock(handoffText, "Pending tool call")).toContain("advisor(");
  });

  it("tail-truncates very long same-step commentary and reasoning", async () => {
    using tempDir = new TestTempDir("advisor-tool-tail-truncate");
    const longText = "X".repeat(ADVISOR_HANDOFF_MAX_TEXT_CHARS + 500);
    const longReasoning = "Y".repeat(ADVISOR_HANDOFF_MAX_REASONING_CHARS + 500);
    const snapshot = createSnapshot({ stepText: longText, stepReasoning: longReasoning });
    const { config } = createToolConfig(tempDir.path, { snapshot });
    const streamTextSpy = mockStreamTextSuccess({
      text: "ok",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } satisfies LanguageModelV2Usage,
    });

    const tool = createAdvisorTool(config);
    await Promise.resolve(
      tool.execute!({ advisor_name: DEFAULT_ADVISOR_NAME, question: "?" }, mockToolCallOptions)
    );

    const handoffText = getHandoffText(streamTextSpy);
    const commentary = extractLabeledBlock(handoffText, "Current-step commentary");
    expect(commentary.startsWith("...")).toBe(true);
    expect(commentary.length).toBe(ADVISOR_HANDOFF_MAX_TEXT_CHARS);
    const reasoning = extractLabeledBlock(handoffText, "Current-step reasoning");
    expect(reasoning.startsWith("...")).toBe(true);
    expect(reasoning.length).toBe(ADVISOR_HANDOFF_MAX_REASONING_CHARS);
  });

  it("returns an error when streamText surfaces a stream failure", async () => {
    using tempDir = new TestTempDir("advisor-tool-stream-error");
    const reportModelUsage = mock((_event: ToolModelUsageEvent) => undefined);
    const { config } = createToolConfig(tempDir.path, { reportModelUsage });
    mockStreamTextSuccess({
      text: "",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } satisfies LanguageModelV2Usage,
      finishReason: "error",
      streamError: new Error("provider blew up"),
    });

    const tool = createAdvisorTool(config);
    const result = (await Promise.resolve(
      tool.execute!({ advisor_name: DEFAULT_ADVISOR_NAME }, mockToolCallOptions)
    )) as { type: string; isError: boolean; message: string };

    expect(result.type).toBe("error");
    expect(result.isError).toBe(true);
    expect(result.message).toContain("provider blew up");
    expect(reportModelUsage).not.toHaveBeenCalled();
  });

  it("swallows synchronous usage reporting failures and logs them", async () => {
    using tempDir = new TestTempDir("advisor-tool-usage-failure");
    const debugSpy = spyOn(log, "debug").mockImplementation(() => undefined);
    const reportModelUsage = mock(() => {
      throw new Error("usage sink offline");
    });
    const { config } = createToolConfig(tempDir.path, { reportModelUsage });
    mockStreamTextSuccess({
      text: "ok",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } satisfies LanguageModelV2Usage,
    });

    const tool = createAdvisorTool(config);
    const result = (await Promise.resolve(
      tool.execute!({ advisor_name: DEFAULT_ADVISOR_NAME }, mockToolCallOptions)
    )) as { type: string };

    expect(result.type).toBe("advice");
    expect(reportModelUsage).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith(
      "advisor: failed to report model usage",
      expect.objectContaining({
        error: expect.stringContaining("usage sink offline") as unknown,
      })
    );
  });
});

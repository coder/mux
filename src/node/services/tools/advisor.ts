import assert from "node:assert/strict";

import { generateText, tool, type Tool } from "ai";

import {
  ADVISOR_HANDOFF_MAX_REASONING_CHARS,
  ADVISOR_HANDOFF_MAX_TEXT_CHARS,
  ADVISOR_SYSTEM_PROMPT,
} from "@/common/constants/advisor";
import type { ModelMessage } from "@/common/types/message";
import { THINKING_LEVEL_OFF, coerceThinkingLevel } from "@/common/types/thinking";
import { buildProviderOptions } from "@/common/utils/ai/providerOptions";
import { getErrorMessage } from "@/common/utils/errors";
import type { AdvisorPhaseEvent } from "@/common/types/stream";
import { AdvisorToolInputSchema, TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { AdvisorToolCallSnapshot, ToolConfiguration } from "@/common/utils/tools/tools";
import { log } from "@/node/services/log";

type AdvisorHandoffMessage = Extract<ModelMessage, { role: "user" }>;

function hasNonWhitespaceContent(value: string | undefined): value is string {
  return value != null && value.trim().length > 0;
}

function tailTruncate(value: string, maxChars: number): string {
  assert(
    Number.isInteger(maxChars) && maxChars > 0,
    "advisor truncation maxChars must be positive"
  );

  if (value.length <= maxChars) {
    return value;
  }

  if (maxChars <= 3) {
    return value.slice(-maxChars);
  }

  return `...${value.slice(-(maxChars - 3))}`;
}

function formatPendingToolCall(input: Record<string, unknown>): string {
  const serializedInput = JSON.stringify(input);
  assert(serializedInput != null, "advisor handoff input must be JSON serializable");
  return `advisor(${serializedInput})`;
}

function buildAdvisorHandoffMessage(
  question: string | undefined,
  snapshot: AdvisorToolCallSnapshot | undefined
): AdvisorHandoffMessage | undefined {
  const stepText =
    snapshot != null && hasNonWhitespaceContent(snapshot.stepText)
      ? tailTruncate(snapshot.stepText, ADVISOR_HANDOFF_MAX_TEXT_CHARS)
      : undefined;
  const stepReasoning =
    snapshot != null && hasNonWhitespaceContent(snapshot.stepReasoning)
      ? tailTruncate(snapshot.stepReasoning, ADVISOR_HANDOFF_MAX_REASONING_CHARS)
      : undefined;

  if (question == null && stepText == null && stepReasoning == null) {
    return undefined;
  }

  const sections: string[] = ["## Advisor Handoff"];

  if (question != null) {
    sections.push(`**Question:** ${question}`);
  }

  if (stepText != null) {
    sections.push(`**Current-step commentary:**\n${stepText}`);
  }

  if (stepReasoning != null) {
    sections.push(`**Current-step reasoning:**\n${stepReasoning}`);
  }

  if (snapshot != null) {
    assert(
      snapshot.toolName === "advisor",
      "advisor handoff snapshot must come from the advisor tool"
    );
    sections.push(`**Pending tool call:**\n${formatPendingToolCall(snapshot.input)}`);
  }

  return {
    role: "user",
    content: sections.join("\n\n"),
  };
}

export function createAdvisorTool(config: ToolConfiguration): Tool {
  assert(config.advisorRuntime, "advisorRuntime must be set when advisor tool is registered");

  const runtime = config.advisorRuntime;
  const advisorModelString = runtime.advisorModelString.trim();
  const reasoningLevel = runtime.reasoningLevel?.trim();
  const effectiveReasoningLevel = coerceThinkingLevel(reasoningLevel) ?? THINKING_LEVEL_OFF;

  assert(advisorModelString.length > 0, "advisorModelString must be a non-empty string");
  assert(
    reasoningLevel === undefined || reasoningLevel.length > 0,
    "advisor reasoningLevel must be undefined or a non-empty string"
  );
  assert(
    reasoningLevel === undefined || effectiveReasoningLevel === reasoningLevel,
    "advisor reasoningLevel must be a valid ThinkingLevel when provided"
  );
  assert(
    runtime.maxUsesPerTurn === null ||
      (Number.isInteger(runtime.maxUsesPerTurn) && runtime.maxUsesPerTurn > 0),
    "advisor maxUsesPerTurn must be null or a positive integer"
  );
  assert(
    runtime.maxOutputTokens === undefined ||
      (Number.isInteger(runtime.maxOutputTokens) && runtime.maxOutputTokens > 0),
    "advisor maxOutputTokens must be undefined or a positive integer"
  );
  assert(
    typeof runtime.getTranscriptSnapshot === "function",
    "advisor getTranscriptSnapshot must be a function"
  );
  assert(
    typeof runtime.takeToolCallSnapshot === "function",
    "advisor takeToolCallSnapshot must be a function"
  );
  assert(typeof runtime.createModel === "function", "advisor createModel must be a function");

  let usesThisTurn = 0;
  const providerOptions = buildProviderOptions(advisorModelString, effectiveReasoningLevel);

  return tool({
    description: TOOL_DEFINITIONS.advisor.description,
    inputSchema: AdvisorToolInputSchema,
    execute: async (args, { abortSignal, toolCallId }) => {
      const question = args.question != null ? args.question.trim() || undefined : undefined;
      assert(
        question == null || question.length > 0,
        "advisor question must be undefined or a non-empty string after trimming"
      );

      const emitAdvisorPhase = (phase: AdvisorPhaseEvent["phase"]): void => {
        if (!config.emitChatEvent || !config.workspaceId || !toolCallId) {
          return;
        }

        config.emitChatEvent({
          type: "advisor-phase",
          workspaceId: config.workspaceId,
          toolCallId,
          phase,
          timestamp: Date.now(),
        } satisfies AdvisorPhaseEvent);
      };

      emitAdvisorPhase("preparing_context");

      if (runtime.maxUsesPerTurn !== null && usesThisTurn >= runtime.maxUsesPerTurn) {
        return {
          type: "limit_reached" as const,
          advisorModel: advisorModelString,
          reasoningLevel,
          message: `Advisor limit reached for this turn (max ${runtime.maxUsesPerTurn} uses).`,
        };
      }
      // Reserve the slot before any await so concurrent advisor calls cannot bypass the per-turn cap.
      usesThisTurn++;
      const remainingUses =
        runtime.maxUsesPerTurn !== null ? runtime.maxUsesPerTurn - usesThisTurn : null;

      const transcript = runtime.getTranscriptSnapshot();
      assert(Array.isArray(transcript), "advisor transcript snapshot must be an array");
      assert(transcript.length > 0, "advisor transcript snapshot must not be empty");
      assert(toolCallId, "advisor requires toolCallId");

      const snapshot = runtime.takeToolCallSnapshot(toolCallId);
      const handoffMessage = buildAdvisorHandoffMessage(question, snapshot);
      const messages: ModelMessage[] =
        handoffMessage != null ? [...transcript, handoffMessage] : transcript;

      try {
        const model = await runtime.createModel(advisorModelString);

        emitAdvisorPhase("waiting_for_response");

        const result = await generateText({
          model,
          system: ADVISOR_SYSTEM_PROMPT,
          messages,
          // Advisor requests are intentionally tool-less strategic consultations.
          tools: {},
          providerOptions,
          abortSignal: abortSignal ?? runtime.abortSignal,
          ...(runtime.maxOutputTokens != null ? { maxOutputTokens: runtime.maxOutputTokens } : {}),
        });

        emitAdvisorPhase("finalizing_result");

        if (config.reportModelUsage != null && result.usage != null) {
          try {
            assert(
              advisorModelString.length > 0,
              "advisorModelString must remain non-empty when reporting usage"
            );
            // Keep advisor costs under the advisor model bucket instead of folding them into
            // the parent chat stream's model totals.
            config.reportModelUsage({
              source: "tool",
              toolName: "advisor",
              model: advisorModelString,
              usage: result.usage,
              providerMetadata: result.providerMetadata as Record<string, unknown> | undefined,
              toolCallId,
              timestamp: Date.now(),
            });
          } catch (error) {
            log.debug("advisor: failed to report model usage", {
              error: getErrorMessage(error),
            });
          }
        }

        return {
          type: "advice" as const,
          advice: result.text,
          advisorModel: advisorModelString,
          reasoningLevel,
          remainingUses,
        };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return {
            type: "error" as const,
            isError: true,
            message: "Advisor request was aborted.",
          };
        }

        return {
          type: "error" as const,
          isError: true,
          message: `Advisor request failed: ${getErrorMessage(error)}`,
        };
      }
    },
  });
}

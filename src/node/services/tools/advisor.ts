import assert from "node:assert/strict";

import { streamText, tool, type Tool } from "ai";

import {
  ADVISOR_DEFAULT_MAX_USES_PER_TURN,
  ADVISOR_HANDOFF_MAX_REASONING_CHARS,
  ADVISOR_HANDOFF_MAX_TEXT_CHARS,
  buildAdvisorToolDescription,
  composeAdvisorSystemPrompt,
} from "@/common/constants/advisor";
import type { ModelMessage } from "@/common/types/message";
import type { AdvisorPackage } from "@/common/types/advisor";
import { THINKING_LEVEL_OFF, coerceThinkingLevel } from "@/common/types/thinking";
import { buildProviderOptions } from "@/common/utils/ai/providerOptions";
import { extractChunkDeltaText } from "@/common/utils/ai/streamChunks";
import { getErrorMessage } from "@/common/utils/errors";
import { sanitizeErrorMessageForDisplay } from "@/common/utils/providerOutputSanitization";
import type { AdvisorOutputEvent, AdvisorPhaseEvent } from "@/common/types/stream";
import { AdvisorToolInputSchema } from "@/common/utils/tools/toolDefinitions";
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

function getAdvisorTextDelta(chunk: unknown): string | undefined {
  if (typeof chunk !== "object" || chunk === null) {
    return undefined;
  }

  const record = chunk as Record<string, unknown>;
  if (record.type !== "text-delta" && record.type !== "text") {
    return undefined;
  }

  const text = extractChunkDeltaText(record, ["text", "delta", "textDelta"]);
  return text.length > 0 ? text : undefined;
}

/**
 * Resolve the effective per-turn usage cap for a single advisor.
 *
 * Resolution order (most specific wins):
 * 1. `frontmatter.max_uses_per_turn === null` → unlimited
 * 2. `frontmatter.max_uses_per_turn === <positive int>` → exact cap
 * 3. Falls back to the runtime-wide default
 */
function resolveAdvisorMaxUsesPerTurn(
  advisor: AdvisorPackage,
  runtimeDefault: number
): number | null {
  const override = advisor.frontmatter.max_uses_per_turn;
  if (override === null) {
    return null;
  }
  if (override != null) {
    return override;
  }
  return runtimeDefault;
}

function resolveAdvisorMaxOutputTokens(advisor: AdvisorPackage): number | undefined {
  // `null` and `undefined` both mean unlimited; positive int means explicit cap.
  return advisor.frontmatter.max_output_tokens ?? undefined;
}

function formatAvailableAdvisorList(advisors: readonly AdvisorPackage[]): string {
  if (advisors.length === 0) {
    return "(none configured)";
  }
  return advisors.map((a) => a.directoryName).join(", ");
}

export function createAdvisorTool(config: ToolConfiguration): Tool {
  assert(config.advisorRuntime, "advisorRuntime must be set when advisor tool is registered");

  const runtime = config.advisorRuntime;
  assert(
    runtime.advisors.length > 0,
    "advisorRuntime.advisors must be non-empty when the advisor tool is registered"
  );
  assert(
    Number.isInteger(runtime.defaultMaxUsesPerTurn) && runtime.defaultMaxUsesPerTurn > 0,
    "advisor defaultMaxUsesPerTurn must be a positive integer"
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

  // Per-advisor turn-scoped usage counters. Keying on directoryName mirrors how
  // the model selects an advisor (by name in `advisor_name`), so a busy
  // ml-fellow advisor can't starve a separately-configured code-review one.
  const usesThisTurnByAdvisor = new Map<string, number>();

  // The base default-cap fallback gets resolved once at registration. Per-turn
  // counter resets are handled by the parent stream rebuilding the runtime
  // bundle on every prepareStep — we never need to mutate state across turns.
  const advisorsByName = new Map(runtime.advisors.map((a) => [a.directoryName, a]));

  return tool({
    description: buildAdvisorToolDescription(runtime.advisors),
    inputSchema: AdvisorToolInputSchema,
    execute: async (args, { abortSignal, toolCallId }) => {
      const requestedName = args.advisor_name.trim();
      const question = args.question != null ? args.question.trim() || undefined : undefined;
      assert(
        question == null || question.length > 0,
        "advisor question must be undefined or a non-empty string after trimming"
      );

      const advisor = advisorsByName.get(requestedName);
      if (advisor == null) {
        // Self-correctable: include the live catalog so the model can retry
        // with a valid name in the same turn.
        return {
          type: "error" as const,
          isError: true,
          message: `Advisor '${requestedName}' is not configured. Available advisors: ${formatAvailableAdvisorList(runtime.advisors)}.`,
        };
      }

      const advisorModelString = advisor.frontmatter.model.trim();
      assert(
        advisorModelString.length > 0,
        `advisor '${advisor.directoryName}' has empty model after trim; should have been rejected at parse time`
      );
      const reasoningLevel = advisor.frontmatter.thinking ?? THINKING_LEVEL_OFF;
      const effectiveReasoningLevel = coerceThinkingLevel(reasoningLevel) ?? THINKING_LEVEL_OFF;

      const maxUsesPerTurn = resolveAdvisorMaxUsesPerTurn(advisor, runtime.defaultMaxUsesPerTurn);
      const maxOutputTokens = resolveAdvisorMaxOutputTokens(advisor);

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

      const emitAdvisorOutput = (text: string): void => {
        assert(text.length > 0, "advisor output chunks must be non-empty");
        if (!config.emitChatEvent || !config.workspaceId || !toolCallId) {
          return;
        }

        config.emitChatEvent({
          type: "advisor-output",
          workspaceId: config.workspaceId,
          toolCallId,
          text,
          timestamp: Date.now(),
        } satisfies AdvisorOutputEvent);
      };

      emitAdvisorPhase("preparing_context");

      const usesThisTurn = usesThisTurnByAdvisor.get(advisor.directoryName) ?? 0;
      if (maxUsesPerTurn !== null && usesThisTurn >= maxUsesPerTurn) {
        return {
          type: "limit_reached" as const,
          advisorName: advisor.directoryName,
          advisorModel: advisorModelString,
          reasoningLevel,
          message: `Advisor '${advisor.directoryName}' limit reached for this turn (max ${maxUsesPerTurn} uses).`,
        };
      }
      // Reserve the slot before any await so concurrent advisor calls cannot bypass the per-turn cap.
      usesThisTurnByAdvisor.set(advisor.directoryName, usesThisTurn + 1);
      const remainingUses = maxUsesPerTurn !== null ? maxUsesPerTurn - (usesThisTurn + 1) : null;

      const transcript = runtime.getTranscriptSnapshot();
      assert(Array.isArray(transcript), "advisor transcript snapshot must be an array");
      assert(transcript.length > 0, "advisor transcript snapshot must not be empty");
      assert(toolCallId, "advisor requires toolCallId");

      const snapshot = runtime.takeToolCallSnapshot(toolCallId);
      const handoffMessage = buildAdvisorHandoffMessage(question, snapshot);
      const messages: ModelMessage[] =
        handoffMessage != null ? [...transcript, handoffMessage] : transcript;

      const providerOptions = buildProviderOptions(advisorModelString, effectiveReasoningLevel);
      const systemPrompt = composeAdvisorSystemPrompt(advisor.body);

      try {
        const model = await runtime.createModel(advisorModelString);

        emitAdvisorPhase("waiting_for_response");

        let advisorStreamError: unknown;
        const streamedAdviceChunks: string[] = [];
        const result = streamText({
          model,
          system: systemPrompt,
          messages,
          // Advisor requests are intentionally tool-less strategic consultations.
          tools: {},
          providerOptions,
          abortSignal: abortSignal ?? runtime.abortSignal,
          ...(maxOutputTokens != null ? { maxOutputTokens } : {}),
          onError: ({ error }) => {
            advisorStreamError = error;
          },
          onChunk: ({ chunk }) => {
            const text = getAdvisorTextDelta(chunk);
            if (text == null) {
              return;
            }

            streamedAdviceChunks.push(text);
            emitAdvisorOutput(text);
          },
        });
        const finalAdvice = await result.text;
        const finishReason = await result.finishReason;
        if (advisorStreamError != null || finishReason === "error") {
          return {
            type: "error" as const,
            isError: true,
            message: `Advisor request failed: ${sanitizeErrorMessageForDisplay(
              getErrorMessage(advisorStreamError ?? new Error("Stream finished with an error."))
            )}`,
          };
        }

        const advice = finalAdvice.length > 0 ? finalAdvice : streamedAdviceChunks.join("");
        const usage = await result.usage;
        const providerMetadata = await result.providerMetadata;

        emitAdvisorPhase("finalizing_result");

        if (config.reportModelUsage != null && usage != null) {
          try {
            // Keep advisor costs under the advisor model bucket instead of folding them into
            // the parent chat stream's model totals.
            config.reportModelUsage({
              source: "tool",
              toolName: "advisor",
              model: advisorModelString,
              usage,
              providerMetadata: providerMetadata as Record<string, unknown> | undefined,
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
          advice,
          advisorName: advisor.directoryName,
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
          message: `Advisor request failed: ${sanitizeErrorMessageForDisplay(getErrorMessage(error))}`,
        };
      }
    },
  });
}

// Re-export the default for convenience; aiService.ts uses it as the fallback
// when an advisor entry omits `max_uses_per_turn`.
export { ADVISOR_DEFAULT_MAX_USES_PER_TURN };

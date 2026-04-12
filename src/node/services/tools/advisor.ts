import assert from "node:assert/strict";

import { generateText, tool, type Tool } from "ai";

import { ADVISOR_SYSTEM_PROMPT } from "@/common/constants/advisor";
import { THINKING_LEVEL_OFF, coerceThinkingLevel } from "@/common/types/thinking";
import { buildProviderOptions } from "@/common/utils/ai/providerOptions";
import { getErrorMessage } from "@/common/utils/errors";
import type { AdvisorPhaseEvent } from "@/common/types/stream";
import { AdvisorToolInputSchema, TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration } from "@/common/utils/tools/tools";

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
    typeof runtime.getTranscriptSnapshot === "function",
    "advisor getTranscriptSnapshot must be a function"
  );
  assert(typeof runtime.createModel === "function", "advisor createModel must be a function");

  let usesThisTurn = 0;
  const providerOptions = buildProviderOptions(advisorModelString, effectiveReasoningLevel);

  return tool({
    description: TOOL_DEFINITIONS.advisor.description,
    inputSchema: AdvisorToolInputSchema,
    execute: async (args, { abortSignal, toolCallId }) => {
      assert(Object.keys(args).length === 0, "advisor tool does not accept input");

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

      try {
        const model = await runtime.createModel(advisorModelString);

        emitAdvisorPhase("waiting_for_response");

        const result = await generateText({
          model,
          system: ADVISOR_SYSTEM_PROMPT,
          messages: transcript,
          // Advisor requests are intentionally tool-less strategic consultations.
          tools: {},
          providerOptions,
          abortSignal: abortSignal ?? runtime.abortSignal,
        });

        emitAdvisorPhase("finalizing_result");

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

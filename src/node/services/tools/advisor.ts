import assert from "node:assert/strict";

import { generateText, tool, type Tool } from "ai";

import { ADVISOR_SYSTEM_PROMPT } from "@/common/constants/advisor";
import { getErrorMessage } from "@/common/utils/errors";
import { AdvisorToolInputSchema, TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration } from "@/common/utils/tools/tools";

export function createAdvisorTool(config: ToolConfiguration): Tool {
  assert(config.advisorRuntime, "advisorRuntime must be set when advisor tool is registered");

  const runtime = config.advisorRuntime;
  const advisorModelString = runtime.advisorModelString.trim();

  assert(advisorModelString.length > 0, "advisorModelString must be a non-empty string");
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

  return tool({
    description: TOOL_DEFINITIONS.advisor.description,
    inputSchema: AdvisorToolInputSchema,
    execute: async (args, execOptions) => {
      assert(Object.keys(args).length === 0, "advisor tool does not accept input");

      if (runtime.maxUsesPerTurn !== null && usesThisTurn >= runtime.maxUsesPerTurn) {
        return {
          type: "limit_reached" as const,
          advisorModel: advisorModelString,
          message: `Advisor limit reached for this turn (max ${runtime.maxUsesPerTurn} uses).`,
        };
      }

      const transcript = runtime.getTranscriptSnapshot();
      assert(Array.isArray(transcript), "advisor transcript snapshot must be an array");
      assert(transcript.length > 0, "advisor transcript snapshot must not be empty");

      try {
        const model = await runtime.createModel(advisorModelString);
        usesThisTurn++;

        const result = await generateText({
          model,
          system: ADVISOR_SYSTEM_PROMPT,
          messages: transcript,
          // Advisor requests are intentionally tool-less strategic consultations.
          tools: {},
          abortSignal: execOptions?.abortSignal ?? runtime.abortSignal,
        });

        const remainingUses =
          runtime.maxUsesPerTurn !== null ? runtime.maxUsesPerTurn - usesThisTurn : null;

        return {
          type: "advice" as const,
          advice: result.text,
          advisorModel: advisorModelString,
          remainingUses,
        };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return {
            type: "error" as const,
            message: "Advisor request was aborted.",
          };
        }

        return {
          type: "error" as const,
          message: `Advisor request failed: ${getErrorMessage(error)}`,
        };
      }
    },
  });
}

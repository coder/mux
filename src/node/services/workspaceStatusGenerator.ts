import { streamText, tool } from "ai";
import type { AIService } from "./aiService";
import { log } from "./log";
import { mapModelCreationError, mapNameGenerationError } from "./workspaceTitleGenerator";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { NameGenerationError } from "@/common/types/errors";
import {
  TOOL_DEFINITIONS,
  ProposeStatusToolArgsSchema,
} from "@/common/utils/tools/toolDefinitions";

/**
 * AI-generated sidebar status: emoji + short verb-led phrase, matching
 * WorkspaceAgentStatus so the frontend renders it through the same
 * WorkspaceStatusIndicator path as displayStatus / todoStatus.
 */
export interface WorkspaceAgentStatusPayload {
  emoji: string;
  message: string;
}

export interface GenerateWorkspaceStatusResult {
  status: WorkspaceAgentStatusPayload;
  /** The model that successfully generated the status */
  modelUsed: string;
}

/**
 * Build the prompt used by {@link generateWorkspaceStatus}. The transcript
 * is supplied pre-trimmed (token budget enforced upstream). The prompt
 * intentionally targets "current activity" not "overall task scope" — this
 * is a sidebar status, not a workspace title.
 */
export function buildWorkspaceStatusPrompt(transcript: string): string {
  // Sentinel for an empty window. AgentStatusService skips empty inputs in
  // practice, but the model still needs something to ground on.
  const body = transcript.trim().length > 0 ? transcript : "(no recent transcript)";
  return [
    "You produce a short sidebar status summarizing the most recent activity in an AI coding agent's chat.\n\n",
    "Recent chat transcript (oldest first, newest last):\n",
    "<transcript>\n",
    body,
    "\n</transcript>\n\n",
    "Requirements:\n",
    "- Describe the specific activity the agent was last working on, drawn from the actual transcript content.\n",
    "- Do NOT use generic placeholders such as 'Awaiting next task', 'Doing work', or 'Idle'. Always name the concrete activity (file, feature, bug, command, etc.).\n",
    "- emoji: A single emoji that visually represents the activity.\n",
    "- message: 2-6 words, present tense, verb-led, sentence case, no punctuation, no quotes.\n",
    '- Examples: "Investigating crash", "Implementing sidebar status", "Running tests", "Reading config files".\n\n',
    "Call propose_status exactly once with your chosen emoji and message. Do not emit any text response.",
  ].join("");
}

/**
 * Generate a sidebar agent-status summary using the same "small model" path
 * that powers workspace title generation. Tries up to 3 candidates so a
 * single misconfigured candidate can't permanently disable status updates.
 */
export async function generateWorkspaceStatus(
  transcript: string,
  candidates: readonly string[],
  aiService: AIService
): Promise<Result<GenerateWorkspaceStatusResult, NameGenerationError>> {
  if (candidates.length === 0) {
    return Err({
      type: "unknown",
      raw: "No model candidates provided for workspace status generation",
    });
  }

  const maxAttempts = Math.min(candidates.length, 3);
  let lastError: NameGenerationError | null = null;

  for (let i = 0; i < maxAttempts; i++) {
    const modelString = candidates[i];

    const modelResult = await aiService.createModel(modelString, undefined, {
      agentInitiated: true,
    });
    if (!modelResult.success) {
      lastError = mapModelCreationError(modelResult.error, modelString);
      log.debug(`Status generation: skipping ${modelString} (${modelResult.error.type})`);
      continue;
    }

    try {
      const currentStream = streamText({
        model: modelResult.data,
        prompt: buildWorkspaceStatusPrompt(transcript),
        tools: {
          propose_status: tool({
            description: TOOL_DEFINITIONS.propose_status.description,
            inputSchema: ProposeStatusToolArgsSchema,
            // eslint-disable-next-line @typescript-eslint/require-await -- AI SDK Tool.execute must return a Promise
            execute: async (args) => ({ success: true as const, ...args }),
          }),
        },
      });

      const results = await currentStream.toolResults;
      const toolResult = results.find((r) => r.dynamic !== true && r.toolName === "propose_status");

      if (!toolResult) {
        lastError = { type: "unknown", raw: "Model did not call propose_status tool" };
        log.warn("Status generation: model did not call propose_status", { modelString });
        continue;
      }

      const { emoji, message } = toolResult.output;
      return Ok({
        status: { emoji: emoji.trim(), message: message.trim() },
        modelUsed: modelString,
      });
    } catch (error) {
      lastError = mapNameGenerationError(error, modelString);
      log.warn("Status generation failed, trying next candidate", {
        modelString,
        error: lastError,
      });
      continue;
    }
  }

  return Err(
    lastError ?? {
      type: "configuration",
      raw: "No working model candidates were available for workspace status generation.",
    }
  );
}

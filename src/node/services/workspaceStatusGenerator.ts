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
 * AI-generated sidebar status summary.
 *
 * Emoji + short verb-led phrase, intentionally identical to the existing
 * WorkspaceAgentStatus shape so the frontend can render it through the
 * same WorkspaceStatusIndicator path used for displayStatus / todoStatus.
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
 * Build the prompt used by {@link generateWorkspaceStatus}.
 *
 * The transcript is supplied pre-trimmed (token budget enforced upstream).
 * We deliberately keep the prompt short — the small model's job is to look
 * at the trailing window and write a present-tense phrase.
 */
export function buildWorkspaceStatusPrompt(transcript: string): string {
  // Sentinel for an empty trailing window (e.g., a fresh workspace with no
  // text content). Shouldn't happen in practice because AgentStatusService
  // skips empty inputs, but the model still needs *something* to ground on.
  const body = transcript.trim().length > 0 ? transcript : "(no recent transcript)";

  // The prompt avoids "summarize the whole task" framing on purpose: this
  // is a sidebar status, not a workspace title. We want the *current*
  // activity, not the overall scope.
  return [
    "You produce a short sidebar status that tells the user what an AI coding agent is doing right now.\n\n",
    "Recent chat transcript (oldest first, newest last):\n",
    "<transcript>\n",
    body,
    "\n</transcript>\n\n",
    "Requirements:\n",
    "- Focus on the most recent activity, not the overall task scope.\n",
    "- emoji: A single emoji that visually represents the activity.\n",
    "- message: 2-6 words, present tense, verb-led, sentence case, no punctuation, no quotes.\n",
    '- Examples of good messages: "Investigating crash", "Implementing sidebar status", "Running tests", "Reading config files", "Awaiting user reply".\n',
    '- If the agent appears idle or finished, describe that state instead (e.g. "Awaiting next task").\n\n',
    "Call propose_status exactly once with your chosen emoji and message. Do not emit any text response.",
  ].join("");
}

/**
 * Generate a sidebar agent-status summary using the same "small model" path
 * that powers workspace title generation.
 *
 * Try candidates in order, retrying on transient API errors (auth, quota,
 * 5xx, etc.) up to a small cap so a single misconfigured candidate doesn't
 * silently disable status updates for everyone.
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

  // Match workspaceTitleGenerator's retry behavior so a single API outage
  // can't permanently disable the feature.
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

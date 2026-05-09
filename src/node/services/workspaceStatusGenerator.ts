import { streamText, tool } from "ai";
import type { AIService } from "./aiService";
import { log } from "./log";
import { runLanguageModelCleanup } from "./languageModelCleanup";
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

export interface GenerateWorkspaceStatusFailure {
  error: NameGenerationError;
  /**
   * True if at least one candidate's `createModel` call succeeded, meaning
   * we actually reached the provider with a request. False if every
   * candidate failed during model construction (auth not connected, API
   * key missing, provider disabled, model not available, policy denied,
   * etc.).
   *
   * The caller uses this to decide whether to advance its dedup hash:
   * post-provider failures (model refused tool, rate limit, network blip,
   * persistent provider error) are properties of the *transcript* and
   * should defer until the chat changes. Pre-provider failures are
   * properties of the user's *config* and must remain retriable so a
   * later credential/provider fix recovers without requiring a transcript
   * change first.
   */
  reachedProvider: boolean;
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
    "- Always name a concrete activity (file, feature, bug, command, etc.) from the transcript. Generic non-informative phrasing is rejected and not shown.\n",
    "- Tense: use present tense if the agent appears to still be in the middle of the activity; use past tense if the most recent assistant turn looks complete (e.g. wrapped up with a summary, no pending tool calls).\n",
    // The sidebar renders the emoji through EmojiIcon, which maps a fixed
    // set of glyphs to Lucide icons. Emojis outside this set fall back to
    // a generic Sparkles icon, which looks identical regardless of the
    // activity. Restrict the model to glyphs we know render correctly.
    "- emoji: must be exactly one of: 🔍 📝 ✅ ❌ 🚀 ⏳ 🔗 🔄 🧪 🤔 🔧 🛠 🔔 🌐 📖 📦 💤 💡 ⚠. Pick the one that best matches the activity (🔍 investigating, 📝 writing, ✅ done/completed, ❌ failed, 🚀 deploying/launching, ⏳ waiting, 🔄 refreshing/iterating, 🧪 testing, 🤔 deciding, 🔧 🛠 fixing/building, 🌐 network/web, 📖 reading docs, 📦 packaging, 💤 idle, 💡 planning, ⚠ warning).\n",
    "- message: 2-6 words, verb-led, sentence case, no punctuation, no quotes.\n",
    '- Examples (in progress): "Investigating crash", "Implementing sidebar status", "Running tests", "Reading config files".\n',
    '- Examples (completed): "Wrote tests", "Fixed sidebar bug", "Investigated crash", "Refactored config loader".\n\n',
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
): Promise<Result<GenerateWorkspaceStatusResult, GenerateWorkspaceStatusFailure>> {
  if (candidates.length === 0) {
    return Err({
      error: {
        type: "unknown",
        raw: "No model candidates provided for workspace status generation",
      },
      reachedProvider: false,
    });
  }

  const maxAttempts = Math.min(candidates.length, 3);
  let lastError: NameGenerationError | null = null;
  // Track whether any candidate's createModel call succeeded — i.e., whether
  // we actually crossed the wire to a provider. If every attempt fails at
  // construction (no API key, OAuth not connected, provider disabled, etc.),
  // the failure is about the user's config rather than the transcript and
  // the caller must keep retrying so a later fix recovers.
  let reachedProvider = false;

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
    reachedProvider = true;

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
    } finally {
      // Mirror workspaceTitleGenerator: some providers attach cleanup hooks
      // to the created model (notably the OpenAI Responses WebSocket
      // transport, which attaches webSocketTransport.close). Without this
      // call the periodic AgentStatusService loop would leak transports
      // for every successful or failed candidate, every tick, every
      // workspace.
      runLanguageModelCleanup(modelResult.data);
    }
  }

  return Err({
    error: lastError ?? {
      type: "configuration",
      raw: "No working model candidates were available for workspace status generation.",
    },
    reachedProvider,
  });
}

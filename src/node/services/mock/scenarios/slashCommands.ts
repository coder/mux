import type { ScenarioTurn } from "@/node/services/mock/scenarioTypes";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { STREAM_BASE_DELAY } from "@/node/services/mock/scenarioTypes";

export const SLASH_COMMAND_PROMPTS = {
  MODEL_STATUS: "Please confirm which model is currently active for this conversation.",
} as const;

export const COMPACTION_MESSAGE =
  "Summarize this conversation into a compact form for a new Assistant to continue helping the user. Focus entirely on the summary of what has happened. Do not suggest next steps or future actions. Use approximately 385 words.";

export const COMPACT_SUMMARY_TEXT =
  "Compact summary: The assistant read project files, listed directory contents, created and inspected test.txt, then confirmed the contents remained 'hello'. Technical details preserved.";

const compactConversationTurn: ScenarioTurn = {
  user: {
    text: COMPACTION_MESSAGE,
    thinkingLevel: "medium",
    mode: "plan",
  },
  assistant: {
    messageId: "msg-slash-compact-1",
    events: [
      {
        kind: "stream-start",
        delay: 0,
        messageId: "msg-slash-compact-1",
        model: KNOWN_MODELS.GPT.id,
      },
      {
        kind: "stream-delta",
        delay: STREAM_BASE_DELAY,
        text: COMPACT_SUMMARY_TEXT,
      },
      {
        kind: "stream-end",
        delay: STREAM_BASE_DELAY * 2,
        metadata: {
          model: KNOWN_MODELS.GPT.id,
          inputTokens: 220,
          outputTokens: 96,
          systemMessageTokens: 18,
        },
        parts: [
          {
            type: "text",
            text: COMPACT_SUMMARY_TEXT,
          },
        ],
      },
    ],
  },
};

const modelStatusTurn: ScenarioTurn = {
  user: {
    text: SLASH_COMMAND_PROMPTS.MODEL_STATUS,
    thinkingLevel: "low",
    mode: "plan",
  },
  assistant: {
    messageId: "msg-slash-model-status",
    events: [
      {
        kind: "stream-start",
        delay: 0,
        messageId: "msg-slash-model-status",
        model: "anthropic:claude-opus-4-5",
      },
      {
        kind: "stream-delta",
        delay: STREAM_BASE_DELAY,
        text: "Claude Opus 4.5 is now responding with enhanced reasoning capacity.",
      },
      {
        kind: "stream-end",
        delay: STREAM_BASE_DELAY * 2,
        metadata: {
          model: "anthropic:claude-opus-4-5",
          inputTokens: 70,
          outputTokens: 54,
          systemMessageTokens: 12,
        },
        parts: [
          {
            type: "text",
            text: "I'm responding as Claude Opus 4.5, which you selected via /model opus. Let me know how to proceed.",
          },
        ],
      },
    ],
  },
};

export const scenarios: ScenarioTurn[] = [compactConversationTurn, modelStatusTurn];

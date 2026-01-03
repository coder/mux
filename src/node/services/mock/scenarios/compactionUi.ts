import type { ScenarioTurn } from "@/node/services/mock/scenarioTypes";
import { STREAM_BASE_DELAY } from "@/node/services/mock/scenarioTypes";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { buildCompactionPrompt } from "@/common/constants/ui";

export const SEED_MESSAGE = "Seed conversation for compaction";
export const SEED_RESPONSE_TEXT = "Seed response: acknowledged.";

export const MANUAL_CONTINUE_TEXT = "Continue after manual compaction";
export const MANUAL_CONTINUE_RESPONSE_TEXT = "Manual continue response: resumed.";

export const MANUAL_COMPACTION_WORD_TARGET = 385;
export const MANUAL_COMPACTION_PROMPT =
  buildCompactionPrompt(MANUAL_COMPACTION_WORD_TARGET) +
  `\n\nThe user wants to continue with: ${MANUAL_CONTINUE_TEXT}`;
export const MANUAL_COMPACTION_SUMMARY_TEXT =
  "Manual compaction summary: Seed conversation acknowledged; no outstanding tasks.";

export const FORCE_COMPACTION_TRIGGER_MESSAGE = "Trigger force compaction";

// Force compaction uses the default word target (see DEFAULT_COMPACTION_WORD_TARGET).
// Keep this in sync with src/common/constants/ui.ts.
export const FORCE_COMPACTION_WORD_TARGET = 2000;
export const FORCE_COMPACTION_PROMPT = buildCompactionPrompt(FORCE_COMPACTION_WORD_TARGET);
export const FORCE_COMPACTION_SUMMARY_TEXT =
  "Force compaction summary: Stream hit context threshold; history compacted successfully.";

export const FORCE_CONTINUE_TEXT = "Continue";
export const FORCE_CONTINUE_RESPONSE_TEXT = "Force continue response: resumed.";

const seedTurn: ScenarioTurn = {
  user: { text: SEED_MESSAGE, thinkingLevel: "low", mode: "exec" },
  assistant: {
    messageId: "msg-compaction-seed",
    events: [
      {
        kind: "stream-start",
        delay: 0,
        messageId: "msg-compaction-seed",
        model: KNOWN_MODELS.OPUS.id,
      },
      {
        kind: "stream-delta",
        delay: STREAM_BASE_DELAY,
        text: SEED_RESPONSE_TEXT,
      },
      {
        kind: "stream-end",
        delay: STREAM_BASE_DELAY * 2,
        metadata: {
          model: KNOWN_MODELS.OPUS.id,
          inputTokens: 32,
          outputTokens: 16,
          systemMessageTokens: 12,
        },
        parts: [{ type: "text", text: SEED_RESPONSE_TEXT }],
      },
    ],
  },
};

const manualCompactionTurn: ScenarioTurn = {
  user: { text: MANUAL_COMPACTION_PROMPT, thinkingLevel: "low", mode: "exec" },
  assistant: {
    messageId: "msg-compaction-manual",
    events: [
      {
        kind: "stream-start",
        delay: 0,
        messageId: "msg-compaction-manual",
        model: KNOWN_MODELS.OPUS.id,
        mode: "compact",
      },
      {
        kind: "stream-delta",
        delay: STREAM_BASE_DELAY,
        text: MANUAL_COMPACTION_SUMMARY_TEXT,
      },
      {
        kind: "stream-end",
        delay: STREAM_BASE_DELAY * 2,
        metadata: {
          model: KNOWN_MODELS.OPUS.id,
          inputTokens: 100,
          outputTokens: 50,
          systemMessageTokens: 12,
        },
        parts: [{ type: "text", text: MANUAL_COMPACTION_SUMMARY_TEXT }],
      },
    ],
  },
};

const manualContinueTurn: ScenarioTurn = {
  user: { text: MANUAL_CONTINUE_TEXT, thinkingLevel: "low", mode: "exec" },
  assistant: {
    messageId: "msg-compaction-manual-continue",
    events: [
      {
        kind: "stream-start",
        delay: 0,
        messageId: "msg-compaction-manual-continue",
        model: KNOWN_MODELS.OPUS.id,
      },
      {
        kind: "stream-delta",
        delay: STREAM_BASE_DELAY,
        text: MANUAL_CONTINUE_RESPONSE_TEXT,
      },
      {
        kind: "stream-end",
        delay: STREAM_BASE_DELAY * 2,
        metadata: {
          model: KNOWN_MODELS.OPUS.id,
          inputTokens: 32,
          outputTokens: 16,
          systemMessageTokens: 12,
        },
        parts: [{ type: "text", text: MANUAL_CONTINUE_RESPONSE_TEXT }],
      },
    ],
  },
};

const forceTriggerTurn: ScenarioTurn = {
  user: { text: FORCE_COMPACTION_TRIGGER_MESSAGE, thinkingLevel: "low", mode: "exec" },
  assistant: {
    messageId: "msg-compaction-force-trigger",
    events: [
      {
        kind: "stream-start",
        delay: 0,
        messageId: "msg-compaction-force-trigger",
        model: KNOWN_MODELS.OPUS.id,
      },
      {
        kind: "stream-delta",
        delay: 10,
        text: "Streaming response...",
      },
      {
        kind: "usage-delta",
        delay: 20,
        usage: {
          inputTokens: 160_000,
          outputTokens: 1,
          totalTokens: 160_001,
        },
        cumulativeUsage: {
          inputTokens: 160_000,
          outputTokens: 1,
          totalTokens: 160_001,
        },
      },
      // Keep the stream alive long enough for the frontend effect to trigger force compaction.
      { kind: "stream-delta", delay: 1000, text: "More streaming..." },
      {
        kind: "stream-end",
        delay: 1500,
        metadata: {
          model: KNOWN_MODELS.OPUS.id,
          inputTokens: 200,
          outputTokens: 100,
          systemMessageTokens: 12,
        },
        parts: [{ type: "text", text: "Finished streaming." }],
      },
    ],
  },
};

const forceCompactionTurn: ScenarioTurn = {
  user: { text: FORCE_COMPACTION_PROMPT, thinkingLevel: "low", mode: "exec" },
  assistant: {
    messageId: "msg-compaction-force",
    events: [
      {
        kind: "stream-start",
        delay: 0,
        messageId: "msg-compaction-force",
        model: KNOWN_MODELS.OPUS.id,
        mode: "compact",
      },
      {
        kind: "stream-delta",
        delay: STREAM_BASE_DELAY,
        text: FORCE_COMPACTION_SUMMARY_TEXT,
      },
      {
        kind: "stream-end",
        delay: STREAM_BASE_DELAY * 2,
        metadata: {
          model: KNOWN_MODELS.OPUS.id,
          inputTokens: 100,
          outputTokens: 50,
          systemMessageTokens: 12,
        },
        parts: [{ type: "text", text: FORCE_COMPACTION_SUMMARY_TEXT }],
      },
    ],
  },
};

const forceContinueTurn: ScenarioTurn = {
  user: { text: FORCE_CONTINUE_TEXT, thinkingLevel: "low", mode: "exec" },
  assistant: {
    messageId: "msg-compaction-force-continue",
    events: [
      {
        kind: "stream-start",
        delay: 0,
        messageId: "msg-compaction-force-continue",
        model: KNOWN_MODELS.OPUS.id,
      },
      {
        kind: "stream-delta",
        delay: STREAM_BASE_DELAY,
        text: FORCE_CONTINUE_RESPONSE_TEXT,
      },
      {
        kind: "stream-end",
        delay: STREAM_BASE_DELAY * 2,
        metadata: {
          model: KNOWN_MODELS.OPUS.id,
          inputTokens: 32,
          outputTokens: 16,
          systemMessageTokens: 12,
        },
        parts: [{ type: "text", text: FORCE_CONTINUE_RESPONSE_TEXT }],
      },
    ],
  },
};

export const scenarios: ScenarioTurn[] = [
  seedTurn,
  manualCompactionTurn,
  manualContinueTurn,
  forceTriggerTurn,
  forceCompactionTurn,
  forceContinueTurn,
];

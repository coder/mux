/**
 * Deterministic fixture-session generator for the replay harness tests and
 * the replay-verify / cache-audit debug CLI commands.
 *
 * Regenerating (only needed when the request pipeline intentionally changes):
 *   MUX_REGENERATE_REPLAY_FIXTURE=1 bun test src/node/services/replay/replayVerify.fixture.test.ts
 *
 * The recorded devtools.jsonl requests are produced through the SAME capture
 * harness the verifier uses, so the fixture is a frozen golden snapshot of the
 * production pipeline's bytes: any later request-time injection of live state
 * (the regression this net exists to catch) rebuilds different bytes in the
 * test environment and fails the byte-equality assertions.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tool, type Tool } from "ai";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import { z } from "zod";
import type { DevToolsLogEntry } from "@/common/types/devtools";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { applyCacheControlToTools } from "@/common/utils/ai/cacheStrategy";
import assert from "@/common/utils/assert";
import { HistoryService } from "@/node/services/historyService";
import { emitTurnEnvelope } from "@/node/services/turnEnvelope";
import { DurableEventJournal } from "@/node/utils/journal/durableEventJournal";
import { buildReplayRequest, captureLanguageModelPrompt } from "./replayRequestBuilder";
import { DEVTOOLS_LOG_FILE_NAME } from "./replayVerify";

export const REPLAY_FIXTURE_WORKSPACE_ID = "replay-fixture";
/** Anthropic model so the cached-system-message request shape is exercised. */
export const REPLAY_FIXTURE_MODEL = "anthropic:claude-sonnet-4-5";
// __dirname (not import.meta.dir): tsconfig.main.json's module target rejects
// import.meta, and bun provides __dirname in both CJS and ESM transpilation.
export const REPLAY_FIXTURE_DIR = path.join(__dirname, "__fixtures__", "replay-session");

const SYSTEM_PROMPT_V1 =
  "You are a sanitized replay fixture agent.\n\nAnswer briefly and never call tools unless asked.";
const SYSTEM_PROMPT_V2 = `${SYSTEM_PROMPT_V1}\n\nAddendum: a skill was loaded, changing the system prompt.`;

function fixtureToolsV1(): Record<string, Tool> {
  return {
    file_read: tool({
      description: "Read a file",
      inputSchema: z.object({ path: z.string() }),
    }),
  };
}

function fixtureToolsV2(): Record<string, Tool> {
  return {
    ...fixtureToolsV1(),
    bash: tool({
      description: "Run a command",
      inputSchema: z.object({ script: z.string() }),
    }),
  };
}

interface FixtureTurn {
  userText: string;
  assistantText: string;
  systemPrompt: string;
  tools: Record<string, Tool>;
  usage: LanguageModelV2Usage;
  providerMetadata?: Record<string, unknown>;
}

/**
 * The three fixture turns: baseline, prefix-stable follow-up, then a turn
 * that busts the cache twice over (system prompt change + tool added) with
 * cache-write-heavy usage for the auditor's token attribution.
 */
const FIXTURE_TURNS: FixtureTurn[] = [
  {
    userText: "Hello! Which file holds the entry point?",
    assistantText: "The entry point lives in src/main.ts.",
    systemPrompt: SYSTEM_PROMPT_V1,
    tools: fixtureToolsV1(),
    usage: { inputTokens: 1200, outputTokens: 40, totalTokens: 1240 },
    providerMetadata: { anthropic: { cacheCreationInputTokens: 1100 } },
  },
  {
    userText: "Thanks. And the preload script?",
    assistantText: "That is src/preload.ts.",
    systemPrompt: SYSTEM_PROMPT_V1,
    tools: fixtureToolsV1(),
    usage: { inputTokens: 1260, outputTokens: 30, totalTokens: 1290, cachedInputTokens: 1200 },
  },
  {
    userText: "Now run the linter.",
    assistantText: "Lint passed with no findings.",
    systemPrompt: SYSTEM_PROMPT_V2,
    tools: fixtureToolsV2(),
    usage: { inputTokens: 1400, outputTokens: 25, totalTokens: 1425 },
    providerMetadata: { anthropic: { cacheCreationInputTokens: 1300 } },
  },
];

/** Generate the fixture session directory from scratch. */
export async function generateReplayFixtureSession(
  sessionDir: string = REPLAY_FIXTURE_DIR
): Promise<void> {
  await fs.rm(sessionDir, { recursive: true, force: true });
  await fs.mkdir(sessionDir, { recursive: true });

  const workspaceId = REPLAY_FIXTURE_WORKSPACE_ID;
  const historyService = new HistoryService({ getSessionDir: () => sessionDir });
  const journal = new DurableEventJournal(sessionDir);
  const devtoolsLines: string[] = [];

  const appendOrThrow = async (message: MuxMessage): Promise<number> => {
    const result = await historyService.appendToHistory(workspaceId, message);
    assert(result.success, `fixture append failed: ${String(!result.success && result.error)}`);
    const sequence = message.metadata?.historySequence;
    assert(sequence != null, "appendToHistory must assign historySequence");
    return sequence;
  };

  for (const [index, turn] of FIXTURE_TURNS.entries()) {
    const turnNumber = index + 1;
    const baseTimestamp = 1_700_000_000_000 + turnNumber * 10_000;

    const userMessage = createMuxMessage(`user-${turnNumber}`, "user", turn.userText, {
      timestamp: baseTimestamp,
    });
    const requestHistorySequence = await appendOrThrow(userMessage);

    // The request is built from history as read BEFORE the assistant row is
    // appended — same ordering as AgentSession.streamWithHistory.
    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
    assert(historyResult.success, "fixture history read failed");

    await emitTurnEnvelope({
      journal,
      workspaceId,
      systemMessage: turn.systemPrompt,
      tools: turn.tools,
      modelString: REPLAY_FIXTURE_MODEL,
      thinkingLevel: "off",
      providerOptions: { anthropic: {} },
    });

    const rebuilt = await buildReplayRequest({
      historyMessages: historyResult.data,
      systemPrompt: turn.systemPrompt,
      modelString: REPLAY_FIXTURE_MODEL,
      thinkingLevel: "off",
      effectiveAgentId: "exec",
      toolNamesForSentinel: Object.keys(turn.tools).sort(),
      workspaceId,
    });
    // Wire tool definitions for the recorded request: same cache-control
    // treatment StreamManager.buildStreamRequestConfig applies before
    // streamText serializes tools.
    const { tools: wireTools } = await captureLanguageModelPrompt({
      system: rebuilt.system,
      messages: rebuilt.messages,
      modelId: REPLAY_FIXTURE_MODEL,
      tools: applyCacheControlToTools(turn.tools, REPLAY_FIXTURE_MODEL, undefined, null),
    });

    const runEntry: DevToolsLogEntry = {
      type: "run",
      run: {
        id: `run-${turnNumber}`,
        workspaceId,
        startedAt: new Date(baseTimestamp + 1_000).toISOString(),
      },
    };
    const stepEntry: DevToolsLogEntry = {
      type: "step",
      step: {
        id: `step-${turnNumber}`,
        runId: `run-${turnNumber}`,
        stepNumber: 0,
        type: "stream",
        modelId: REPLAY_FIXTURE_MODEL,
        provider: "anthropic",
        startedAt: new Date(baseTimestamp + 1_000).toISOString(),
        durationMs: 1234,
        input: {
          prompt: JSON.parse(JSON.stringify(rebuilt.lmPrompt)) as unknown,
          tools: JSON.parse(JSON.stringify(wireTools)) as unknown,
        },
        output: null,
        usage: null,
        error: null,
        rawRequest: null,
        requestHeaders: null,
        responseHeaders: null,
        rawResponse: null,
        rawChunks: null,
      },
    };
    devtoolsLines.push(JSON.stringify(runEntry), JSON.stringify(stepEntry));

    const assistantMessage = createMuxMessage(
      `assistant-${turnNumber}`,
      "assistant",
      turn.assistantText,
      {
        timestamp: baseTimestamp + 2_000,
        model: REPLAY_FIXTURE_MODEL,
        agentId: "exec",
        thinkingLevel: "off",
        requestHistorySequence,
        usage: turn.usage,
        ...(turn.providerMetadata !== undefined ? { providerMetadata: turn.providerMetadata } : {}),
      }
    );
    await appendOrThrow(assistantMessage);
  }

  // Envelope emission is fire-and-forget in production (never fails a turn);
  // the fixture must not silently miss rows.
  const envelopeCount = (await journal.read()).filter(
    (event) => event.kind === "turn-envelope"
  ).length;
  assert(
    envelopeCount === FIXTURE_TURNS.length,
    `expected ${FIXTURE_TURNS.length} turn-envelope rows, found ${envelopeCount}`
  );

  await fs.writeFile(
    path.join(sessionDir, DEVTOOLS_LOG_FILE_NAME),
    devtoolsLines.join("\n") + "\n",
    "utf-8"
  );
}

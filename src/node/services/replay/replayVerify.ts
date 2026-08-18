/**
 * Replay verification: proves "model-visible ⟹ logged" for a recorded
 * session by rebuilding each turn's provider request from durable logs
 * (chat.jsonl + turn-envelope rows + blob store) and byte-comparing it against
 * the request the provider actually received (devtools.jsonl, llmDebugLogs).
 *
 * Guarantee scope: same log + same config + same binary. See
 * replayRequestBuilder.ts for the inputs that are intentionally not
 * log-derivable; turns depending on them report FAIL with the divergence
 * point rather than silently passing.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { asSchema } from "ai";
import type { DevToolsLogEntry, DevToolsStep, DevToolsUsage } from "@/common/types/devtools";
import type { DurableEvent } from "@/common/types/durableEvent";
import type { MuxMessage } from "@/common/types/message";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import assert from "@/common/utils/assert";
import { DurableEventJournal } from "@/node/utils/journal/durableEventJournal";
import { hashToolSchema } from "@/node/services/turnEnvelope";
import { buildReplayRequest } from "./replayRequestBuilder";

export const DEVTOOLS_LOG_FILE_NAME = "devtools.jsonl";

/** One turn-envelope durable event (narrowed from the event union). */
export type TurnEnvelopeEvent = Extract<DurableEvent, { kind: "turn-envelope" }>;

/** The first provider round-trip of one recorded run (the log-built request). */
export interface RecordedProviderRequest {
  runId: string;
  stepId: string;
  startedAt: string;
  modelId: string;
  prompt: unknown;
  tools: unknown;
  usage: DevToolsUsage | null;
}

/**
 * Parse devtools.jsonl into per-run first-step requests. Tolerant reader
 * (self-heal doctrine): malformed lines and unknown entry types are skipped.
 * Later steps of a run are SDK-internal tool loops whose extra messages come
 * from the streamed output (persisted at turn end), so the log-purity
 * comparison targets step 0 — the request assembled from chat.jsonl.
 */
export async function readRecordedRequests(sessionDir: string): Promise<RecordedProviderRequest[]> {
  const filePath = path.join(sessionDir, DEVTOOLS_LOG_FILE_NAME);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  const runOrder: string[] = [];
  const firstSteps = new Map<string, DevToolsStep>();
  const stepUsageUpdates = new Map<string, DevToolsUsage | null>();

  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let entry: DevToolsLogEntry;
    try {
      entry = JSON.parse(line) as DevToolsLogEntry;
    } catch {
      continue;
    }
    if (entry.type === "run") {
      runOrder.push(entry.run.id);
    } else if (entry.type === "step") {
      const existing = firstSteps.get(entry.step.runId);
      if (existing == null || entry.step.stepNumber < existing.stepNumber) {
        firstSteps.set(entry.step.runId, entry.step);
      }
    } else if (entry.type === "step-update" && entry.update.usage !== undefined) {
      stepUsageUpdates.set(entry.stepId, entry.update.usage);
    }
  }

  const requests: RecordedProviderRequest[] = [];
  for (const runId of runOrder) {
    const step = firstSteps.get(runId);
    if (step?.input == null) {
      continue;
    }
    requests.push({
      runId,
      stepId: step.id,
      startedAt: step.startedAt,
      modelId: step.modelId,
      prompt: step.input.prompt,
      tools: step.input.tools,
      usage: stepUsageUpdates.get(step.id) ?? step.usage,
    });
  }
  return requests;
}

/** First structural difference between two JSON values (depth-first). */
export interface JsonDivergence {
  path: string;
  expected: unknown;
  actual: unknown;
}

/**
 * Locate the first divergence between two JSON-compatible values. `expected`
 * is the log-rebuilt value, `actual` the recorded one. Returns null when
 * deep-equal.
 */
export function findFirstJsonDivergence(
  expected: unknown,
  actual: unknown,
  basePath = "$"
): JsonDivergence | null {
  if (expected === actual) {
    return null;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length);
    for (let i = 0; i < length; i++) {
      if (i >= expected.length || i >= actual.length) {
        return { path: `${basePath}[${i}]`, expected: expected[i], actual: actual[i] };
      }
      const nested = findFirstJsonDivergence(expected[i], actual[i], `${basePath}[${i}]`);
      if (nested) {
        return nested;
      }
    }
    return null;
  }
  if (
    expected !== null &&
    actual !== null &&
    typeof expected === "object" &&
    typeof actual === "object" &&
    !Array.isArray(expected) &&
    !Array.isArray(actual)
  ) {
    const expectedRecord = expected as Record<string, unknown>;
    const actualRecord = actual as Record<string, unknown>;
    const keys = new Set([...Object.keys(expectedRecord), ...Object.keys(actualRecord)]);
    for (const key of keys) {
      const nested = findFirstJsonDivergence(
        expectedRecord[key],
        actualRecord[key],
        `${basePath}.${key}`
      );
      if (nested) {
        return nested;
      }
    }
    return null;
  }
  return { path: basePath, expected, actual };
}

export interface ReplayVerifyTurnResult {
  turnIndex: number;
  envelopeSeq: number;
  assistantMessageId: string;
  runId: string;
  status: "PASS" | "FAIL" | "SKIPPED";
  /** Present for SKIPPED (why verification was impossible). */
  reason?: string;
  systemPromptMatch?: boolean;
  toolsetMatch?: boolean;
  messagesMatch?: boolean;
  /** First differing JSON path when messagesMatch is false. */
  divergence?: JsonDivergence;
  /** Human-readable toolset delta when toolsetMatch is false. */
  toolsetDiff?: string;
}

export interface ReplayVerifySessionResult {
  turns: ReplayVerifyTurnResult[];
  /** Correlation notes (count mismatches between logs). */
  notes: string[];
}

export interface AssistantTurn {
  message: MuxMessage;
  requestHistorySequence: number;
}

/**
 * Assistant rows that finished a provider request build (one per
 * streamMessage call) — the chat.jsonl side of the ordinal pairing with
 * turn-envelope rows and recorded devtools runs.
 */
export function collectAssistantTurns(historyMessages: MuxMessage[]): AssistantTurn[] {
  const turns: AssistantTurn[] = [];
  for (const message of historyMessages) {
    const requestHistorySequence = message.metadata?.requestHistorySequence;
    if (message.role === "assistant" && requestHistorySequence != null) {
      turns.push({ message, requestHistorySequence });
    }
  }
  return turns;
}

/** Extract the system text from a recorded LanguageModel prompt. */
function recordedSystemText(prompt: unknown): string | undefined {
  if (!Array.isArray(prompt) || prompt.length === 0) {
    return undefined;
  }
  const first = prompt[0] as { role?: unknown; content?: unknown };
  if (first?.role !== "system" || typeof first.content !== "string") {
    return undefined;
  }
  return first.content;
}

/** Hash the recorded wire tools into manifest form (name-sorted). */
function manifestFromRecordedTools(tools: unknown): Array<{ name: string; schemaHash: string }> {
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools
    .flatMap((tool) => {
      const record = tool as { name?: unknown; inputSchema?: unknown };
      if (typeof record.name !== "string") {
        return [];
      }
      // The wire inputSchema is already plain JSON schema (post asSchema);
      // schema-less entries (provider-defined tools) fingerprint like the
      // manifest's empty-schema fallback in turnEnvelope.extractJsonSchema.
      const schema = record.inputSchema ?? asSchema(undefined).jsonSchema;
      return [{ name: record.name, schemaHash: hashToolSchema(schema) }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function describeManifestDiff(
  envelope: Array<{ name: string; schemaHash: string }>,
  recorded: Array<{ name: string; schemaHash: string }>
): string {
  const envelopeByName = new Map(envelope.map((entry) => [entry.name, entry.schemaHash]));
  const recordedByName = new Map(recorded.map((entry) => [entry.name, entry.schemaHash]));
  const parts: string[] = [];
  for (const [name] of envelopeByName) {
    if (!recordedByName.has(name)) {
      parts.push(`missing-on-wire:${name}`);
    }
  }
  for (const [name, hash] of recordedByName) {
    const envelopeHash = envelopeByName.get(name);
    if (envelopeHash === undefined) {
      parts.push(`unlogged:${name}`);
    } else if (envelopeHash !== hash) {
      parts.push(`schema-changed:${name}`);
    }
  }
  return parts.join(", ");
}

/**
 * Verify every turn of a session: rebuild the provider request from durable
 * logs and byte-compare against the recorded devtools request. Envelopes,
 * assistant rows, and recorded runs are paired ordinally (they are all
 * appended once per streamMessage call); count mismatches are surfaced as
 * notes and unpaired entries as SKIPPED.
 */
export async function replayVerifySession(params: {
  sessionDir: string;
  workspaceId: string;
  historyMessages: MuxMessage[];
  providersConfig?: ProvidersConfigMap | null;
}): Promise<ReplayVerifySessionResult> {
  const journal = new DurableEventJournal(params.sessionDir);
  const events = await journal.read();
  const envelopes = events.filter(
    (event): event is TurnEnvelopeEvent => event.kind === "turn-envelope"
  );
  const recorded = await readRecordedRequests(params.sessionDir);
  const turns = collectAssistantTurns(params.historyMessages);

  const notes: string[] = [];
  if (envelopes.length !== recorded.length || envelopes.length !== turns.length) {
    notes.push(
      `count mismatch: ${envelopes.length} turn-envelope rows, ${recorded.length} recorded requests, ` +
        `${turns.length} assistant turns in the current history epoch — pairing ordinally, ` +
        `leftovers are SKIPPED (devtools logging toggles, retries, or compaction can cause this)`
    );
  }

  const results: ReplayVerifyTurnResult[] = [];
  const pairCount = Math.max(envelopes.length, recorded.length, turns.length);

  for (let i = 0; i < pairCount; i++) {
    const envelope = envelopes[i];
    const record = recorded[i];
    const turn = turns[i];

    if (envelope == null || record == null || turn == null) {
      results.push({
        turnIndex: i,
        envelopeSeq: envelope?.seq ?? -1,
        assistantMessageId: turn?.message.id ?? "",
        runId: record?.runId ?? "",
        status: "SKIPPED",
        reason: `unpaired turn (envelope=${envelope != null}, recorded=${record != null}, assistant=${turn != null})`,
      });
      continue;
    }

    const systemPrompt = await journal.blobs.getText(envelope.data.systemPromptHash);
    if (systemPrompt == null) {
      results.push({
        turnIndex: i,
        envelopeSeq: envelope.seq,
        assistantMessageId: turn.message.id,
        runId: record.runId,
        status: "FAIL",
        reason: `system prompt blob ${envelope.data.systemPromptHash} missing from blob store`,
      });
      continue;
    }

    // 1) System prompt: blob bytes vs the wire's system message.
    const systemPromptMatch = recordedSystemText(record.prompt) === systemPrompt;

    // 2) Toolset: envelope manifest vs re-hashed wire tool schemas.
    const recordedManifest = manifestFromRecordedTools(record.tools);
    const toolsetMatch =
      JSON.stringify(envelope.data.toolsetManifest) === JSON.stringify(recordedManifest);

    // 3) Messages: rebuild the full LanguageModel prompt from log rows and
    // byte-compare. Slice history to the rows the original build saw: every
    // row the request contained has historySequence <= requestHistorySequence
    // (rows appended later, including this turn's assistant row, are higher).
    const historySlice = params.historyMessages.filter((message) => {
      const sequence = message.metadata?.historySequence;
      assert(sequence != null, `history row ${message.id} is missing historySequence`);
      return sequence <= turn.requestHistorySequence;
    });

    const rebuilt = await buildReplayRequest({
      historyMessages: historySlice,
      systemPrompt,
      modelString: envelope.data.modelString,
      thinkingLevel: envelope.data.thinkingLevel as ThinkingLevel,
      effectiveAgentId: turn.message.metadata?.agentId ?? "exec",
      toolNamesForSentinel: envelope.data.toolsetManifest.map((entry) => entry.name),
      routeProvider: turn.message.metadata?.routeProvider,
      providersConfig: params.providersConfig,
      workspaceId: params.workspaceId,
    });

    // JSON round-trip the rebuilt prompt so both sides are plain JSON values
    // (the recorded prompt already survived a devtools.jsonl round-trip).
    const rebuiltJson: unknown = JSON.parse(JSON.stringify(rebuilt.lmPrompt));
    const messagesMatch = JSON.stringify(rebuiltJson) === JSON.stringify(record.prompt);

    const pass = systemPromptMatch && toolsetMatch && messagesMatch;
    results.push({
      turnIndex: i,
      envelopeSeq: envelope.seq,
      assistantMessageId: turn.message.id,
      runId: record.runId,
      status: pass ? "PASS" : "FAIL",
      systemPromptMatch,
      toolsetMatch,
      messagesMatch,
      ...(messagesMatch
        ? {}
        : { divergence: findFirstJsonDivergence(rebuiltJson, record.prompt) ?? undefined }),
      ...(toolsetMatch
        ? {}
        : { toolsetDiff: describeManifestDiff(envelope.data.toolsetManifest, recordedManifest) }),
    });
  }

  return { turns: results, notes };
}

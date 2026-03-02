/** A "run" = one top-level AI SDK call (streamText/generateText). */
export interface DevToolsRun {
  id: string;
  workspaceId: string;
  startedAt: string; // ISO timestamp
}

/** A "step" = a single LLM round-trip within a run. */
export interface DevToolsStep {
  id: string;
  runId: string;
  stepNumber: number;
  type: "generate" | "stream";
  modelId: string;
  provider: string | null;
  startedAt: string;
  durationMs: number | null;
  input: DevToolsStepInput | null;
  output: DevToolsStepOutput | null;
  usage: DevToolsUsage | null;
  error: string | null;
  rawRequest: unknown;
  responseHeaders: Record<string, string> | null;
  rawResponse: unknown;
  rawChunks: unknown;
}

export interface DevToolsStepInput {
  prompt: unknown;
  tools?: unknown;
  toolChoice?: unknown;
  maxOutputTokens?: number;
  temperature?: number;
  providerOptions?: unknown;
}

export interface DevToolsStepOutput {
  content?: unknown;
  finishReason?: string;
  textParts?: Array<{ id: string; text: string }>;
  reasoningParts?: Array<{ id: string; text: string }>;
  toolCalls?: unknown[];
}

export interface DevToolsUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** Enriched summary returned by getRuns (includes computed fields). */
export interface DevToolsRunSummary extends DevToolsRun {
  stepCount: number;
  firstMessage: string;
  hasError: boolean;
  isInProgress: boolean;
  totalDurationMs: number | null;
  modelId: string | null;
}

/** Live events streamed to frontend. */
export type DevToolsEvent =
  | { type: "snapshot"; runs: DevToolsRunSummary[] }
  | { type: "run-created"; run: DevToolsRunSummary }
  | { type: "run-updated"; run: DevToolsRunSummary }
  | { type: "step-created"; step: DevToolsStep }
  | { type: "step-updated"; step: DevToolsStep }
  | { type: "cleared" };

/** One line in devtools.jsonl — append-only log format. */
export type DevToolsLogEntry =
  | { type: "run"; run: DevToolsRun }
  | { type: "step"; step: DevToolsStep }
  | { type: "step-update"; stepId: string; update: Partial<DevToolsStep> };

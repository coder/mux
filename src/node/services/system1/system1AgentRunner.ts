import assert from "@/common/utils/assert";

import { generateText, type LanguageModel, type Tool } from "ai";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";

import type { Runtime } from "@/node/runtime/Runtime";

import { resolveAgentBody } from "@/node/services/agentDefinitions/agentDefinitionsService";
import { createSystem1KeepRangesTool } from "@/node/services/tools/system1_keep_ranges";
import type { System1KeepRange } from "@/node/services/system1/bashOutputFiltering";
import { linkAbortSignal } from "@/node/utils/abort";

export type GenerateTextLike = (args: Parameters<typeof generateText>[0]) => Promise<{
  finishReason?: string;
  usage?: LanguageModelV2Usage;
  providerMetadata?: Record<string, unknown>;
}>;
export interface RunSystem1KeepRangesParams {
  runtime: Runtime;
  agentDiscoveryPath: string;
  runtimeTempDir: string;

  model: LanguageModel;
  modelString: string;
  providerOptions?: Record<string, unknown>;

  // Optional short label describing what the bash command is doing (intent hint).
  // This is intentionally lightweight to avoid bloating the System 1 prompt.
  displayName?: string;

  script: string;
  numberedOutput: string;
  maxKeptLines: number;

  timeoutMs: number;
  abortSignal?: AbortSignal;
  onTimeout?: () => void;

  // Testing hook: allows unit tests to stub the AI SDK call.
  generateTextImpl?: GenerateTextLike;
}

export async function runSystem1KeepRangesForBashOutput(
  params: RunSystem1KeepRangesParams
): Promise<
  | {
      keepRanges: System1KeepRange[];
      finishReason?: string;
      timedOut: boolean;
      usage?: LanguageModelV2Usage;
      providerMetadata?: Record<string, unknown>;
    }
  | undefined
> {
  assert(params, "params is required");
  assert(params.runtime, "runtime is required");
  assert(
    typeof params.agentDiscoveryPath === "string" && params.agentDiscoveryPath.length > 0,
    "agentDiscoveryPath must be a non-empty string"
  );
  assert(
    typeof params.runtimeTempDir === "string" && params.runtimeTempDir.length > 0,
    "runtimeTempDir must be a non-empty string"
  );
  assert(params.model, "model is required");
  assert(
    params.displayName === undefined || typeof params.displayName === "string",
    "displayName must be a string when provided"
  );
  assert(
    typeof params.modelString === "string" && params.modelString.length > 0,
    "modelString must be a non-empty string"
  );
  assert(typeof params.script === "string", "script must be a string");
  assert(
    typeof params.numberedOutput === "string" && params.numberedOutput.length > 0,
    "numberedOutput must be a non-empty string"
  );
  assert(
    Number.isInteger(params.maxKeptLines) && params.maxKeptLines > 0,
    "maxKeptLines must be a positive integer"
  );
  assert(
    Number.isInteger(params.timeoutMs) && params.timeoutMs > 0,
    "timeoutMs must be a positive integer"
  );

  // Intentionally keep the System 1 prompt minimal to avoid consuming context budget.
  //
  // Use the built-in definition for this internal agent. Allowing project/global overrides
  // would introduce a new footgun compared to the previously hard-coded System1 prompt.
  const systemPrompt = await resolveAgentBody(
    params.runtime,
    params.agentDiscoveryPath,
    "system1_bash",
    { skipScopesAbove: "global" }
  );

  const userMessageParts = [`maxKeptLines: ${params.maxKeptLines}`, ""];

  const displayName =
    typeof params.displayName === "string" && params.displayName.trim().length > 0
      ? params.displayName.trim()
      : undefined;
  if (displayName) {
    userMessageParts.push(`Display name:\n${displayName}`, "");
  }

  userMessageParts.push(
    `Bash script:\n${params.script}`,
    "",
    `Numbered output:\n${params.numberedOutput}`
  );

  const userMessage = userMessageParts.join("\n");

  const system1AbortController = new AbortController();
  const unlink = linkAbortSignal(params.abortSignal, system1AbortController);

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    params.onTimeout?.();
    system1AbortController.abort();
  }, params.timeoutMs);
  timeout.unref?.();

  // Some providers (Anthropic) reject requests that force tool use while also enabling
  // "thinking". Since the System 1 agent already mandates tool usage, keep requests
  // provider-agnostic and retry once with a stronger reminder if needed.
  const attemptMessages: Array<NonNullable<Parameters<typeof generateText>[0]["messages"]>> = [
    [{ role: "user", content: userMessage }],
    [
      { role: "user", content: userMessage },
      {
        role: "user",
        content:
          "Reminder: You MUST call `system1_keep_ranges` exactly once. Do not output any text; only the tool call.",
      },
    ],
  ];

  const generate = params.generateTextImpl ?? generateText;
  let responseWithUsage:
    | {
        finishReason?: string;
        usage: LanguageModelV2Usage;
        providerMetadata?: Record<string, unknown>;
      }
    | undefined;

  try {
    for (const messages of attemptMessages) {
      let keepRanges: System1KeepRange[] | undefined;

      const tools: Record<string, Tool> = {
        system1_keep_ranges: createSystem1KeepRangesTool(
          // This tool is pure/side-effect-free; config is unused.
          // Provide a minimal config object for interface compatibility.
          {
            cwd: params.agentDiscoveryPath,
            runtime: params.runtime,
            runtimeTempDir: params.runtimeTempDir,
          },
          {
            onKeepRanges: (ranges) => {
              keepRanges = ranges;
            },
          }
        ),
      };

      let response: Awaited<ReturnType<GenerateTextLike>>;
      try {
        response = await generate({
          model: params.model,
          system: systemPrompt,
          messages,
          tools,
          abortSignal: system1AbortController.signal,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
          providerOptions: params.providerOptions as any,
          maxOutputTokens: 300,
          maxRetries: 0,
        });
      } catch (error) {
        const errorName = error instanceof Error ? error.name : undefined;
        if (errorName === "AbortError") {
          return undefined;
        }
        throw error;
      }

      if (keepRanges && keepRanges.length > 0) {
        return {
          keepRanges,
          finishReason: response.finishReason,
          timedOut,
          usage: response.usage,
          providerMetadata: response.providerMetadata,
        };
      }

      if (response.usage) {
        responseWithUsage = {
          finishReason: response.finishReason,
          usage: response.usage,
          providerMetadata: response.providerMetadata,
        };
      }
    }

    if (responseWithUsage) {
      return {
        keepRanges: [],
        finishReason: responseWithUsage.finishReason,
        timedOut,
        usage: responseWithUsage.usage,
        providerMetadata: responseWithUsage.providerMetadata,
      };
    }

    return undefined;
  } finally {
    clearTimeout(timeout);
    unlink();
  }
}

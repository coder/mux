import assert from "@/common/utils/assert";

import { generateText, type LanguageModel, type Tool } from "ai";

import type { Runtime } from "@/node/runtime/Runtime";

import { resolveAgentBody } from "@/node/services/agentDefinitions/agentDefinitionsService";
import { createSystem1KeepRangesTool } from "@/node/services/tools/system1_keep_ranges";
import type { System1KeepRange } from "@/node/services/system1/bashOutputFiltering";
import { normalizeGatewayModel } from "@/common/utils/ai/models";
import { linkAbortSignal } from "@/node/utils/abort";

export type GenerateTextLike = (
  args: Parameters<typeof generateText>[0]
) => Promise<{ finishReason?: string }>;
export interface RunSystem1KeepRangesParams {
  runtime: Runtime;
  agentDiscoveryPath: string;
  runtimeTempDir: string;

  model: LanguageModel;
  modelString: string;
  providerOptions?: Record<string, unknown>;

  script: string;
  numberedOutput: string;
  maxKeptLines: number;

  timeoutMs: number;
  abortSignal?: AbortSignal;
  onTimeout?: () => void;

  // Testing hook: allows unit tests to stub the AI SDK call.
  generateTextImpl?: GenerateTextLike;
}

function stripAnthropicThinkingWhenToolForced(
  modelString: string,
  providerOptions: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const [provider] = normalizeGatewayModel(modelString).split(":", 2);
  if (provider !== "anthropic") {
    return providerOptions;
  }

  if (!providerOptions || typeof providerOptions !== "object") {
    return providerOptions;
  }

  if (!("anthropic" in providerOptions)) {
    return providerOptions;
  }

  const anthropicValue = (providerOptions as { anthropic?: unknown }).anthropic;
  if (!anthropicValue || typeof anthropicValue !== "object") {
    return providerOptions;
  }

  if (!("thinking" in anthropicValue)) {
    return providerOptions;
  }

  // Remove `thinking` to avoid Anthropic API errors when tool_choice is forced.
  const { thinking: _thinking, ...rest } = anthropicValue as Record<string, unknown>;
  return {
    ...providerOptions,
    anthropic: rest,
  };
}

export async function runSystem1KeepRangesForBashOutput(
  params: RunSystem1KeepRangesParams
): Promise<
  { keepRanges: System1KeepRange[]; finishReason?: string; timedOut: boolean } | undefined
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
  const systemPrompt = await resolveAgentBody(
    params.runtime,
    params.agentDiscoveryPath,
    "system1_bash"
  );

  const userMessage = [
    `maxKeptLines: ${params.maxKeptLines}`,
    "",
    `Bash script:\n${params.script}`,
    "",
    `Numbered output:\n${params.numberedOutput}`,
  ].join("\n");

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

  const system1AbortController = new AbortController();
  const unlink = linkAbortSignal(params.abortSignal, system1AbortController);

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    params.onTimeout?.();
    system1AbortController.abort();
  }, params.timeoutMs);
  timeout.unref?.();

  const providerOptions = stripAnthropicThinkingWhenToolForced(
    params.modelString,
    params.providerOptions
  );

  try {
    let response: Awaited<ReturnType<GenerateTextLike>>;
    try {
      response = await (params.generateTextImpl ?? generateText)({
        model: params.model,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
        tools,
        // Force tool call. This avoids parsing JSON from model text.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
        toolChoice: { type: "tool", toolName: "system1_keep_ranges" } as any,
        abortSignal: system1AbortController.signal,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
        providerOptions: providerOptions as any,
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

    if (!keepRanges || keepRanges.length === 0) {
      return undefined;
    }

    return {
      keepRanges,
      finishReason: response.finishReason,
      timedOut,
    };
  } finally {
    clearTimeout(timeout);
    unlink();
  }
}

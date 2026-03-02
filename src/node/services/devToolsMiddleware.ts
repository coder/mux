import { randomUUID } from "node:crypto";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import type {
  DevToolsStep,
  DevToolsStepInput,
  DevToolsStepOutput,
  DevToolsUsage,
} from "@/common/types/devtools";
import assert from "@/common/utils/assert";
import type { DevToolsService } from "./devToolsService";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}

function extractFinishReason(reason: unknown): string | undefined {
  if (typeof reason === "string") {
    return reason;
  }

  if (!isRecord(reason)) {
    return undefined;
  }

  const raw = reason.raw;
  if (typeof raw === "string" && raw.length > 0) {
    return raw;
  }

  const unified = reason.unified;
  if (typeof unified === "string" && unified.length > 0) {
    return unified;
  }

  return undefined;
}

function extractTokenCount(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const total = value.total;
  return typeof total === "number" ? total : undefined;
}

function extractOptionalTokenCount(
  record: Record<string, unknown>,
  key: string
): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function createEmptyStep(
  stepId: string,
  runId: string,
  stepNumber: number,
  type: DevToolsStep["type"],
  model: LanguageModelV3,
  input: DevToolsStepInput | null
): DevToolsStep {
  return {
    id: stepId,
    runId,
    stepNumber,
    type,
    modelId: model.modelId,
    provider:
      typeof model.provider === "string" && model.provider.length > 0 ? model.provider : null,
    startedAt: new Date().toISOString(),
    durationMs: null,
    input,
    output: null,
    usage: null,
    error: null,
    rawRequest: null,
    rawResponse: null,
  };
}

function extractGenerateToolCalls(result: LanguageModelV3GenerateResult): unknown[] | undefined {
  const toolCallsFromContent = result.content
    .filter((part) => part.type === "tool-call")
    .map((part) => ({
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      args: part.input,
    }));

  if (toolCallsFromContent.length > 0) {
    return toolCallsFromContent;
  }

  if (!isRecord(result)) {
    return undefined;
  }

  const resultRecord = result as Record<string, unknown>;
  const dynamicToolCalls = resultRecord.toolCalls;
  return Array.isArray(dynamicToolCalls) ? dynamicToolCalls : undefined;
}

export function extractInput(
  params: LanguageModelV3CallOptions | null | undefined
): DevToolsStepInput | null {
  if (!params) {
    return null;
  }

  return {
    prompt: params.prompt ?? null,
    tools: params.tools ?? undefined,
    toolChoice: params.toolChoice ?? undefined,
    maxOutputTokens: params.maxOutputTokens ?? undefined,
    temperature: params.temperature ?? undefined,
    providerOptions: params.providerOptions ?? undefined,
  };
}

export function extractGenerateOutput(result: LanguageModelV3GenerateResult): DevToolsStepOutput {
  return {
    content: result.content ?? undefined,
    finishReason: extractFinishReason(result.finishReason),
    toolCalls: extractGenerateToolCalls(result),
  };
}

export function extractUsage(
  usage: LanguageModelV3Usage | Record<string, unknown> | null | undefined
): DevToolsUsage | null {
  if (!usage || !isRecord(usage)) {
    return null;
  }

  const inputTokens =
    extractTokenCount(usage.inputTokens) ?? extractOptionalTokenCount(usage, "promptTokens");
  const outputTokens =
    extractTokenCount(usage.outputTokens) ?? extractOptionalTokenCount(usage, "completionTokens");
  const explicitTotalTokens = extractOptionalTokenCount(usage, "totalTokens");

  const hasInputTokens = typeof inputTokens === "number";
  const hasOutputTokens = typeof outputTokens === "number";
  const totalTokens =
    typeof explicitTotalTokens === "number"
      ? explicitTotalTokens
      : hasInputTokens || hasOutputTokens
        ? (inputTokens ?? 0) + (outputTokens ?? 0)
        : undefined;

  if (!hasInputTokens && !hasOutputTokens && typeof totalTokens !== "number") {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

export function createDevToolsMiddleware(
  workspaceId: string,
  service: DevToolsService
): LanguageModelV3Middleware {
  assert(workspaceId.trim().length > 0, "createDevToolsMiddleware requires a workspaceId");
  assert(service, "createDevToolsMiddleware requires a DevToolsService");

  const runId = randomUUID();
  let runCreated = false;
  let runCreationPromise: Promise<void> | null = null;
  let stepCounter = 0;

  async function ensureRun(): Promise<void> {
    if (runCreated) {
      return;
    }

    if (runCreationPromise) {
      await runCreationPromise;
      return;
    }

    runCreationPromise = (async () => {
      await service.createRun(workspaceId, {
        id: runId,
        workspaceId,
        startedAt: new Date().toISOString(),
      });
      runCreated = true;
    })();

    try {
      await runCreationPromise;
    } finally {
      runCreationPromise = null;
    }
  }

  async function createStep(
    stepType: DevToolsStep["type"],
    params: LanguageModelV3CallOptions,
    model: LanguageModelV3
  ): Promise<{ stepId: string; startedAtMs: number }> {
    await ensureRun();

    const stepId = randomUUID();
    const stepNumber = (stepCounter += 1);
    const input = extractInput(params);

    await service.createStep(
      workspaceId,
      createEmptyStep(stepId, runId, stepNumber, stepType, model, input)
    );

    return {
      stepId,
      startedAtMs: Date.now(),
    };
  }

  async function updateStepSuccess(
    stepId: string,
    startedAtMs: number,
    update: Pick<DevToolsStep, "output" | "usage" | "rawRequest" | "rawResponse" | "error">
  ): Promise<void> {
    await service.updateStep(workspaceId, stepId, {
      durationMs: Date.now() - startedAtMs,
      ...update,
    });
  }

  async function updateStepWithError(
    stepId: string,
    startedAtMs: number,
    error: unknown,
    output: DevToolsStepOutput | null = null,
    rawRequest: unknown | null = null,
    rawResponse: unknown | null = null
  ): Promise<void> {
    await service.updateStep(workspaceId, stepId, {
      durationMs: Date.now() - startedAtMs,
      output,
      error: extractErrorMessage(error),
      rawRequest,
      rawResponse,
    });
  }

  return {
    specificationVersion: "v3",

    wrapGenerate: async ({ doGenerate, params, model }) => {
      if (!service.enabled) {
        return doGenerate();
      }

      const { stepId, startedAtMs } = await createStep("generate", params, model);

      try {
        const result = await doGenerate();

        await updateStepSuccess(stepId, startedAtMs, {
          output: extractGenerateOutput(result),
          usage: extractUsage(result.usage),
          rawRequest: result.request ?? null,
          rawResponse: result.response ?? null,
          error: null,
        });

        return result;
      } catch (error) {
        await updateStepWithError(stepId, startedAtMs, error);
        throw error;
      }
    },

    wrapStream: async ({ doStream, params, model }) => {
      if (!service.enabled) {
        return doStream();
      }

      const { stepId, startedAtMs } = await createStep("stream", params, model);

      let streamResult: LanguageModelV3StreamResult;
      try {
        streamResult = await doStream();
      } catch (error) {
        await updateStepWithError(stepId, startedAtMs, error);
        throw error;
      }

      const { stream, ...rest } = streamResult;
      const reader = stream.getReader();

      const currentText = new Map<string, string>();
      const currentReasoning = new Map<string, string>();
      const textParts: Array<{ id: string; text: string }> = [];
      const reasoningParts: Array<{ id: string; text: string }> = [];
      const toolCalls: unknown[] = [];

      let finishReason: string | undefined;
      let usage: DevToolsUsage | null = null;
      let stepFinalized = false;

      const finalizeStep = async (
        update: Pick<DevToolsStep, "output" | "usage" | "error" | "rawRequest" | "rawResponse">
      ): Promise<void> => {
        if (stepFinalized) {
          return;
        }

        stepFinalized = true;
        await service.updateStep(workspaceId, stepId, {
          durationMs: Date.now() - startedAtMs,
          ...update,
        });
      };

      const collectChunk = (chunk: LanguageModelV3StreamPart): void => {
        switch (chunk.type) {
          case "text-start": {
            currentText.set(chunk.id, "");
            break;
          }
          case "text-delta": {
            currentText.set(chunk.id, `${currentText.get(chunk.id) ?? ""}${chunk.delta}`);
            break;
          }
          case "text-end": {
            textParts.push({
              id: chunk.id,
              text: currentText.get(chunk.id) ?? "",
            });
            currentText.delete(chunk.id);
            break;
          }
          case "reasoning-start": {
            currentReasoning.set(chunk.id, "");
            break;
          }
          case "reasoning-delta": {
            currentReasoning.set(chunk.id, `${currentReasoning.get(chunk.id) ?? ""}${chunk.delta}`);
            break;
          }
          case "reasoning-end": {
            reasoningParts.push({
              id: chunk.id,
              text: currentReasoning.get(chunk.id) ?? "",
            });
            currentReasoning.delete(chunk.id);
            break;
          }
          case "tool-call": {
            toolCalls.push({
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              args: chunk.input,
            });
            break;
          }
          case "finish": {
            finishReason = extractFinishReason(chunk.finishReason);
            usage = extractUsage(chunk.usage);
            break;
          }
          case "error": {
            if (!finishReason) {
              finishReason = "error";
            }
            break;
          }
          default:
            break;
        }
      };

      const buildOutput = (): DevToolsStepOutput => ({
        textParts,
        reasoningParts,
        toolCalls,
        finishReason,
      });

      const trackedStream = new ReadableStream<LanguageModelV3StreamPart>({
        async pull(controller): Promise<void> {
          try {
            const { done, value } = await reader.read();
            if (done) {
              await finalizeStep({
                output: buildOutput(),
                usage,
                error: null,
                rawRequest: rest.request ?? null,
                rawResponse: rest.response ?? null,
              });
              controller.close();
              return;
            }

            assert(value, "DevTools middleware expected stream value when done=false");
            collectChunk(value);
            controller.enqueue(value);
          } catch (error) {
            await finalizeStep({
              output: buildOutput(),
              usage,
              error: extractErrorMessage(error),
              rawRequest: rest.request ?? null,
              rawResponse: rest.response ?? null,
            });
            controller.error(error);
          }
        },

        async cancel(reason): Promise<void> {
          try {
            await reader.cancel(reason);
          } finally {
            await finalizeStep({
              output: buildOutput(),
              usage,
              error: "Request aborted",
              rawRequest: rest.request ?? null,
              rawResponse: rest.response ?? null,
            });
          }
        },
      });

      return {
        ...rest,
        stream: trackedStream,
      };
    },
  };
}

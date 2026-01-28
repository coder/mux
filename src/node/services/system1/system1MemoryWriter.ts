import assert from "@/common/utils/assert";

import { generateText, type LanguageModel, type Tool } from "ai";

import * as fs from "node:fs/promises";

import type { Runtime } from "@/node/runtime/Runtime";

import type { MuxMessage, MuxToolPart } from "@/common/types/message";

import { resolveAgentBody } from "@/node/services/agentDefinitions/agentDefinitionsService";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import { createMemoryReadTool } from "@/node/services/tools/memory_read";
import { createMemoryWriteTool } from "@/node/services/tools/memory_write";
import { getMuxHome } from "@/common/constants/paths";
import { getMemoryFilePathForProject } from "@/node/services/tools/memoryCommon";
import {
  readInstructionSet,
  readInstructionSetFromRuntime,
} from "@/node/utils/main/instructionFiles";
import { log } from "@/node/services/log";
import { linkAbortSignal } from "@/node/utils/abort";

export type GenerateTextLike = (
  args: Parameters<typeof generateText>[0]
) => Promise<{ finishReason?: string }>;

export interface RunSystem1MemoryWriterParams {
  runtime: Runtime;
  agentDiscoveryPath: string;
  runtimeTempDir: string;

  model: LanguageModel;
  modelString: string;
  providerOptions?: Record<string, unknown>;

  workspaceId: string;
  workspaceName: string;
  triggerMessageId: string;
  projectPath: string;
  workspacePath: string;

  history: MuxMessage[];

  timeoutMs: number;
  abortSignal?: AbortSignal;
  onTimeout?: () => void;

  // Testing hook: allows unit tests to stub the AI SDK call.
  generateTextImpl?: GenerateTextLike;
}

interface MemoryWriterToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  state: "input-available" | "output-available";
}

interface MemoryWriterToolExecutionEvent {
  attemptIndex: number;
  toolName: string;
  toolCallId?: string;
  input: unknown;
  output?: unknown;
  error?: string;
  startedAt: number;
  durationMs: number;
}

interface MemoryWriterAttemptDebug {
  attemptIndex: number;
  messages: unknown;
  stepResults: unknown[];
  toolExecutions: MemoryWriterToolExecutionEvent[];
  finishReason?: string;
  wrote: boolean;
  aborted: boolean;
  error?: string;
}

function sanitizeDebugFilenameComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function getToolCallIdFromExecuteOptions(options: unknown): string | undefined {
  if (!options || typeof options !== "object") {
    return undefined;
  }

  const record = options as Record<string, unknown>;
  const toolCallId = record.toolCallId;
  return typeof toolCallId === "string" && toolCallId.trim().length > 0 ? toolCallId : undefined;
}

function sanitizeStepResultForDebug(stepResult: unknown): unknown {
  if (!stepResult || typeof stepResult !== "object") {
    return stepResult;
  }

  const record = stepResult as Record<string, unknown>;
  const sanitized: Record<string, unknown> = { ...record };

  const request = record.request;
  if (request && typeof request === "object") {
    const requestRecord = request as Record<string, unknown>;
    // Request bodies can be very large; keep the metadata but drop the body for readability.
    const { body: _requestBody, ...rest } = requestRecord;
    sanitized.request = rest;
  }

  const response = record.response;
  if (response && typeof response === "object") {
    const responseRecord = response as Record<string, unknown>;
    // Response bodies can be very large; keep the metadata but drop the body for readability.
    const { body: _responseBody, ...rest } = responseRecord;
    sanitized.response = rest;
  }

  return sanitized;
}

interface MemoryWriterEvent {
  historySequence?: number;
  role: string;
  text?: string;
  toolCalls?: MemoryWriterToolCall[];
}

function buildMemoryWriterEvents(history: MuxMessage[]): MemoryWriterEvent[] {
  const events: MemoryWriterEvent[] = [];

  for (const msg of history) {
    const historySequence = msg.metadata?.historySequence;

    const textParts = msg.parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");

    const toolParts = msg.parts
      .filter((part): part is MuxToolPart => part.type === "dynamic-tool")
      .map((part) => ({
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
        output: part.state === "output-available" ? part.output : undefined,
        state: part.state,
      }));

    events.push({
      historySequence,
      role: msg.role,
      text: textParts.length > 0 ? textParts : undefined,
      toolCalls: toolParts.length > 0 ? toolParts : undefined,
    });
  }

  return events;
}

function trimToCharBudget(events: MemoryWriterEvent[], maxChars: number): MemoryWriterEvent[] {
  assert(Number.isInteger(maxChars) && maxChars > 0, "maxChars must be a positive integer");

  // Drop oldest events until the compact JSON fits.
  let startIndex = 0;
  while (startIndex < events.length) {
    const candidate = events.slice(startIndex);
    const serialized = JSON.stringify(candidate);
    if (serialized.length <= maxChars) {
      return candidate;
    }
    startIndex += 1;
  }

  return events.slice(-1);
}

export async function runSystem1WriteProjectMemories(
  params: RunSystem1MemoryWriterParams
): Promise<{ finishReason?: string; timedOut: boolean } | undefined> {
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
  assert(
    typeof params.triggerMessageId === "string" && params.triggerMessageId.length > 0,
    "triggerMessageId must be a non-empty string"
  );
  assert(
    typeof params.workspaceId === "string" && params.workspaceId.length > 0,
    "workspaceId is required"
  );
  assert(
    typeof params.projectPath === "string" && params.projectPath.length > 0,
    "projectPath must be a non-empty string"
  );
  assert(
    typeof params.workspacePath === "string" && params.workspacePath.length > 0,
    "workspacePath must be a non-empty string"
  );
  assert(Array.isArray(params.history), "history must be an array");
  assert(
    Number.isInteger(params.timeoutMs) && params.timeoutMs > 0,
    "timeoutMs must be a positive integer"
  );

  const runStartedAt = Date.now();

  // Intentionally keep the System 1 prompt minimal to avoid consuming context budget.
  //
  // Use the built-in definition for this internal agent. Allowing project/global overrides
  // would introduce a new footgun compared to the previously hard-coded System1 prompt.
  const systemPrompt = await resolveAgentBody(
    params.runtime,
    params.agentDiscoveryPath,
    "system1_memory_writer",
    { skipScopesAbove: "global" }
  );

  const globalAgentsMd = await readInstructionSet(getMuxHome());

  const workspaceInstructions = await readInstructionSetFromRuntime(
    params.runtime,
    params.workspacePath
  );
  const contextAgentsMd = workspaceInstructions ?? (await readInstructionSet(params.projectPath));

  const { projectId, memoryPath } = getMemoryFilePathForProject(params.projectPath);

  let existingMemory = "";
  try {
    existingMemory = await fs.readFile(memoryPath, "utf8");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  const events = buildMemoryWriterEvents(params.history);

  // Size guard: tool outputs can be huge (bash output, logs, etc.).
  // We prefer dropping older context over truncating newer context.
  const MAX_EVENTS_JSON_CHARS = 80_000;
  const trimmedEvents = trimToCharBudget(events, MAX_EVENTS_JSON_CHARS);

  const userMessageParts = [
    `projectId: ${projectId}`,
    "",
    "<global-instructions>",
    globalAgentsMd ?? "(none)",
    "</global-instructions>",
    "",
    "<context-instructions>",
    contextAgentsMd ?? "(none)",
    "</context-instructions>",
    "",
    "<memory-file>",
    existingMemory.length > 0 ? existingMemory : "(empty)",
    "</memory-file>",
    "",
    "Conversation events (JSON):",
    JSON.stringify(trimmedEvents),
  ];

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

  const debugAttempts: MemoryWriterAttemptDebug[] = [];

  let didWriteMemory = false;

  const generate = params.generateTextImpl ?? generateText;

  try {
    const attemptMessages: Array<NonNullable<Parameters<typeof generateText>[0]["messages"]>> = [
      [{ role: "user", content: userMessage }],
      [
        { role: "user", content: userMessage },
        {
          role: "user",
          content:
            "Reminder: You MUST call memory_write to persist the updated memory file. Do not output prose.",
        },
      ],
    ];

    for (let attemptIndex = 0; attemptIndex < attemptMessages.length; attemptIndex += 1) {
      const messages = attemptMessages[attemptIndex];
      let wrote = false;

      const stepResults: unknown[] = [];
      const toolExecutions: MemoryWriterToolExecutionEvent[] = [];

      const attemptDebug: MemoryWriterAttemptDebug = {
        attemptIndex: attemptIndex + 1,
        messages,
        stepResults,
        toolExecutions,
        wrote: false,
        aborted: false,
      };

      debugAttempts.push(attemptDebug);

      const toolConfig: ToolConfiguration = {
        cwd: params.workspacePath,
        runtime: params.runtime,
        runtimeTempDir: params.runtimeTempDir,
        muxEnv: {
          MUX_PROJECT_PATH: params.projectPath,
          MUX_WORKSPACE_NAME: params.workspaceName,
          MUX_RUNTIME: "local",
        },
        workspaceId: params.workspaceId,
      };

      const wrapToolExecute = (toolName: string, tool: Tool) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const toolRecord = tool as any as Record<string, unknown>;
        const originalExecute = toolRecord.execute;
        if (typeof originalExecute !== "function") {
          return;
        }

        toolRecord.execute = async (input: unknown, options: unknown) => {
          const startedAt = Date.now();
          const toolCallId = getToolCallIdFromExecuteOptions(options);

          try {
            const result = await (originalExecute as (a: unknown, b: unknown) => Promise<unknown>)(
              input,
              options
            );

            if (
              toolName === "memory_write" &&
              result &&
              typeof result === "object" &&
              "success" in result
            ) {
              const successValue = (result as { success?: unknown }).success;
              if (successValue === true) {
                wrote = true;
              }
            }

            toolExecutions.push({
              attemptIndex: attemptDebug.attemptIndex,
              toolName,
              toolCallId,
              input,
              output: result,
              startedAt,
              durationMs: Date.now() - startedAt,
            });

            return result;
          } catch (error) {
            toolExecutions.push({
              attemptIndex: attemptDebug.attemptIndex,
              toolName,
              toolCallId,
              input,
              error: error instanceof Error ? error.message : String(error),
              startedAt,
              durationMs: Date.now() - startedAt,
            });

            throw error;
          }
        };
      };

      const memoryReadTool = createMemoryReadTool(toolConfig);
      const memoryWriteTool = createMemoryWriteTool(toolConfig);

      wrapToolExecute("memory_read", memoryReadTool);
      wrapToolExecute("memory_write", memoryWriteTool);

      const tools: Record<string, Tool> = {
        memory_read: memoryReadTool,
        memory_write: memoryWriteTool,
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
          onStepFinish: (stepResult) => {
            stepResults.push(sanitizeStepResultForDebug(stepResult));
          },
        });
      } catch (error) {
        const errorName = error instanceof Error ? error.name : undefined;
        if (errorName === "AbortError") {
          attemptDebug.aborted = true;
          attemptDebug.error = timedOut ? "AbortError (timeout)" : "AbortError";
          return undefined;
        }

        attemptDebug.error = error instanceof Error ? error.message : String(error);
        throw error;
      }

      attemptDebug.finishReason = response.finishReason;

      if (wrote) {
        didWriteMemory = true;
        attemptDebug.wrote = true;
        return {
          finishReason: response.finishReason,
          timedOut,
        };
      }
    }

    return undefined;
  } finally {
    clearTimeout(timeout);
    unlink();

    if (log.isDebugMode() && (timedOut || !didWriteMemory)) {
      const safeTriggerMessageId = sanitizeDebugFilenameComponent(params.triggerMessageId);
      log.debug_obj(
        `${params.workspaceId}/system1_memory_writer/${runStartedAt}_${safeTriggerMessageId}.json`,
        {
          schemaVersion: 1,
          runStartedAt,
          workspaceId: params.workspaceId,
          workspaceName: params.workspaceName,
          triggerMessageId: params.triggerMessageId,
          modelString: params.modelString,
          timeoutMs: params.timeoutMs,
          timedOut,
          didWriteMemory,
          agentDiscoveryPath: params.agentDiscoveryPath,
          projectPath: params.projectPath,
          workspacePath: params.workspacePath,
          memoryPath,
          systemPrompt,
          globalAgentsMd,
          contextAgentsMd,
          existingMemory,
          eventsSummary: {
            originalCount: events.length,
            trimmedCount: trimmedEvents.length,
            maxJsonChars: MAX_EVENTS_JSON_CHARS,
          },
          events: trimmedEvents,
          userMessage,
          attempts: debugAttempts,
        }
      );
    }
  }
}

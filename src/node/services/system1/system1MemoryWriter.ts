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
    "Global AGENTS.md (~/.mux/AGENTS.md):",
    globalAgentsMd ?? "(none)",
    "",
    "Project/workspace AGENTS.md:",
    contextAgentsMd ?? "(none)",
    "",
    "Current memory file content:",
    existingMemory.length > 0 ? existingMemory : "(empty)",
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

    for (const messages of attemptMessages) {
      let wrote = false;

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

      const memoryWriteTool = createMemoryWriteTool(toolConfig);

      // Track whether the model successfully persisted an update.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const memoryWriteToolRecord = memoryWriteTool as any as Record<string, unknown>;
      const originalExecute = memoryWriteToolRecord.execute;
      if (typeof originalExecute === "function") {
        memoryWriteToolRecord.execute = async (args: unknown, options: unknown) => {
          const result = await (originalExecute as (a: unknown, b: unknown) => Promise<unknown>)(
            args,
            options
          );
          if (result && typeof result === "object" && "success" in result) {
            const successValue = (result as { success?: unknown }).success;
            if (successValue === true) {
              wrote = true;
            }
          }
          return result;
        };
      }

      const tools: Record<string, Tool> = {
        memory_read: createMemoryReadTool(toolConfig),
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
        });
      } catch (error) {
        const errorName = error instanceof Error ? error.name : undefined;
        if (errorName === "AbortError") {
          return undefined;
        }
        throw error;
      }

      if (wrote) {
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
  }
}

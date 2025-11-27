#!/usr/bin/env bun

import assert from "@/common/utils/assert";
import * as fs from "fs/promises";
import * as path from "path";
import { PlatformPaths } from "@/common/utils/paths";
import { parseArgs } from "util";
import { Config } from "@/node/config";
import { HistoryService } from "@/node/services/historyService";
import { PartialService } from "@/node/services/partialService";
import { InitStateManager } from "@/node/services/initStateManager";
import { AIService } from "@/node/services/aiService";
import { AgentSession, type AgentSessionChatEvent } from "@/node/services/agentSession";
import {
  isCaughtUpMessage,
  isStreamAbort,
  isStreamDelta,
  isStreamEnd,
  isStreamError,
  isStreamStart,
  isToolCallDelta,
  isToolCallEnd,
  isToolCallStart,
  type SendMessageOptions,
  type WorkspaceChatMessage,
} from "@/common/orpc/types";
import { defaultModel } from "@/common/utils/ai/models";
import { ensureProvidersConfig } from "@/common/utils/providers/ensureProvidersConfig";
import { modeToToolPolicy, PLAN_MODE_INSTRUCTION } from "@/common/utils/ui/modeUtils";
import {
  extractAssistantText,
  extractReasoning,
  extractToolCalls,
} from "@/cli/debug/chatExtractors";
import type { ThinkingLevel } from "@/common/types/thinking";

interface CliResult {
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

async function ensureDirectory(pathToCheck: string): Promise<void> {
  const stats = await fs.stat(pathToCheck);
  if (!stats.isDirectory()) {
    throw new Error(`"${pathToCheck}" is not a directory`);
  }
}

async function gatherMessageFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }

  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
      continue;
    }
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
      continue;
    }
    if (chunk instanceof Uint8Array) {
      chunks.push(chunk);
      continue;
    }
    throw new Error(`Unsupported stdin chunk type: ${typeof chunk}`);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function parseTimeout(timeoutRaw: string | undefined): number | undefined {
  if (!timeoutRaw) {
    return undefined;
  }

  const parsed = Number.parseInt(timeoutRaw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid timeout value "${timeoutRaw}"`);
  }
  return parsed;
}

function parseThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (
    normalized === "off" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high"
  ) {
    return normalized;
  }
  throw new Error(`Invalid thinking level "${value}". Expected one of: off, low, medium, high.`);
}

type CLIMode = "plan" | "exec";

function parseMode(raw: string | undefined): CLIMode {
  if (!raw) {
    return "exec";
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === "plan") {
    return "plan";
  }
  if (normalized === "exec" || normalized === "execute") {
    return "exec";
  }

  throw new Error('Invalid mode "' + raw + '". Expected "plan" or "exec" (or "execute").');
}

function renderUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function writeJson(result: CliResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "workspace-path": { type: "string" },
      "workspace-id": { type: "string" },
      "project-path": { type: "string" },
      "config-root": { type: "string" },
      message: { type: "string" },
      model: { type: "string" },
      "thinking-level": { type: "string" },
      mode: { type: "string" },
      timeout: { type: "string" },
      json: { type: "boolean" },
      "json-streaming": { type: "boolean" },
    },
    allowPositionals: false,
  });

  const workspacePathRaw = values["workspace-path"];
  if (typeof workspacePathRaw !== "string" || workspacePathRaw.trim().length === 0) {
    throw new Error("--workspace-path is required");
  }
  const workspacePath = path.resolve(workspacePathRaw.trim());
  await ensureDirectory(workspacePath);

  const configRootRaw = values["config-root"];
  const configRoot =
    configRootRaw && configRootRaw.trim().length > 0 ? configRootRaw.trim() : undefined;
  const config = new Config(configRoot);

  const workspaceIdRaw = values["workspace-id"];
  if (typeof workspaceIdRaw !== "string" || workspaceIdRaw.trim().length === 0) {
    throw new Error("--workspace-id is required");
  }
  const workspaceId = workspaceIdRaw.trim();

  const projectPathRaw = values["project-path"];
  const projectName =
    typeof projectPathRaw === "string" && projectPathRaw.trim().length > 0
      ? PlatformPaths.basename(path.resolve(projectPathRaw.trim()))
      : PlatformPaths.basename(path.dirname(workspacePath)) || "unknown";

  const messageArg =
    values.message && values.message.trim().length > 0 ? values.message : undefined;
  const messageText = messageArg ?? (await gatherMessageFromStdin());
  if (messageText?.trim().length === 0) {
    throw new Error("Message must be provided via --message or stdin");
  }

  const model = values.model && values.model.trim().length > 0 ? values.model.trim() : defaultModel;
  const timeoutMs = parseTimeout(values.timeout);
  const thinkingLevel = parseThinkingLevel(values["thinking-level"]);
  const initialMode = parseMode(values.mode);
  const emitFinalJson = values.json === true;
  const emitJsonStreaming = values["json-streaming"] === true;

  const suppressHumanOutput = emitJsonStreaming || emitFinalJson;

  // Log model selection for terminal-bench verification
  if (!suppressHumanOutput) {
    console.error(`[mux-cli] Using model: ${model}`);
  }

  const humanStream = process.stdout;
  const writeHuman = (text: string) => {
    if (suppressHumanOutput) {
      return;
    }
    humanStream.write(text);
  };
  const writeHumanLine = (text = "") => {
    if (suppressHumanOutput) {
      return;
    }
    humanStream.write(`${text}\n`);
  };
  const emitJsonLine = (payload: unknown) => {
    if (!emitJsonStreaming) {
      return;
    }
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };

  const historyService = new HistoryService(config);
  const partialService = new PartialService(config, historyService);
  const initStateManager = new InitStateManager(config);
  const aiService = new AIService(config, historyService, partialService, initStateManager);
  ensureProvidersConfig(config);

  const session = new AgentSession({
    workspaceId,
    config,
    historyService,
    partialService,
    aiService,
    initStateManager,
  });

  await session.ensureMetadata({
    workspacePath,
    projectName,
  });

  const buildSendOptions = (mode: CLIMode): SendMessageOptions => ({
    model,
    thinkingLevel,
    toolPolicy: modeToToolPolicy(mode),
    additionalSystemInstructions: mode === "plan" ? PLAN_MODE_INSTRUCTION : undefined,
  });

  const liveEvents: WorkspaceChatMessage[] = [];
  let readyForLive = false;
  let streamLineOpen = false;
  let activeMessageId: string | null = null;
  let planProposed = false;
  let streamEnded = false;

  let resolveCompletion: ((value: void) => void) | null = null;
  let rejectCompletion: ((reason?: unknown) => void) | null = null;
  let completionPromise: Promise<void> = Promise.resolve();

  const createCompletionPromise = (): Promise<void> => {
    streamEnded = false;
    return new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
  };

  const waitForCompletion = async (): Promise<void> => {
    if (timeoutMs !== undefined) {
      let timeoutHandle: NodeJS.Timeout | null = null;
      try {
        await Promise.race([
          completionPromise,
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
              timeoutMs
            );
          }),
        ]);
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }
    } else {
      await completionPromise;
    }

    if (!streamEnded) {
      throw new Error("Stream completion promise resolved unexpectedly without stream end");
    }
  };

  const sendAndAwait = async (message: string, options: SendMessageOptions): Promise<void> => {
    completionPromise = createCompletionPromise();
    const sendResult = await session.sendMessage(message, options);
    if (!sendResult.success) {
      const errorValue = sendResult.error;
      let formattedError = "unknown error";
      if (typeof errorValue === "string") {
        formattedError = errorValue;
      } else if (errorValue && typeof errorValue === "object") {
        const maybeRaw = (errorValue as { raw?: unknown }).raw;
        if (typeof maybeRaw === "string" && maybeRaw.trim().length > 0) {
          formattedError = maybeRaw;
        } else {
          formattedError = JSON.stringify(errorValue);
        }
      }
      throw new Error(`Failed to send message: ${formattedError}`);
    }

    await waitForCompletion();
  };

  const handleToolStart = (payload: WorkspaceChatMessage): boolean => {
    if (!isToolCallStart(payload)) {
      return false;
    }
    writeHumanLine("\n========== TOOL CALL START ==========");
    writeHumanLine(`Tool: ${payload.toolName}`);
    writeHumanLine(`Call ID: ${payload.toolCallId}`);
    writeHumanLine("Arguments:");
    writeHumanLine(renderUnknown(payload.args));
    writeHumanLine("=====================================");
    return true;
  };

  const handleToolDelta = (payload: WorkspaceChatMessage): boolean => {
    if (!isToolCallDelta(payload)) {
      return false;
    }
    writeHumanLine("\n----------- TOOL OUTPUT -------------");
    writeHumanLine(renderUnknown(payload.delta));
    writeHumanLine("-------------------------------------");
    return true;
  };

  const handleToolEnd = (payload: WorkspaceChatMessage): boolean => {
    if (!isToolCallEnd(payload)) {
      return false;
    }
    writeHumanLine("\n=========== TOOL CALL END ===========");
    writeHumanLine(`Tool: ${payload.toolName}`);
    writeHumanLine(`Call ID: ${payload.toolCallId}`);
    writeHumanLine("Result:");
    writeHumanLine(renderUnknown(payload.result));
    writeHumanLine("=====================================");
    if (payload.toolName === "propose_plan") {
      planProposed = true;
    }
    return true;
  };

  const chatListener = (event: AgentSessionChatEvent) => {
    const payload = event.message;

    if (!readyForLive) {
      if (isCaughtUpMessage(payload)) {
        readyForLive = true;
        emitJsonLine({ type: "caught-up", workspaceId });
      }
      return;
    }

    emitJsonLine({ type: "event", workspaceId, payload });
    liveEvents.push(payload);

    if (handleToolStart(payload) || handleToolDelta(payload) || handleToolEnd(payload)) {
      return;
    }

    if (isStreamStart(payload)) {
      if (activeMessageId && activeMessageId !== payload.messageId) {
        if (rejectCompletion) {
          rejectCompletion(
            new Error(
              `Received conflicting stream-start message IDs (${activeMessageId} vs ${payload.messageId})`
            )
          );
          resolveCompletion = null;
          rejectCompletion = null;
        }
        return;
      }
      activeMessageId = payload.messageId;
      return;
    }

    if (isStreamDelta(payload)) {
      assert(typeof payload.delta === "string", "stream delta must include text");
      writeHuman(payload.delta);
      streamLineOpen = !payload.delta.endsWith("\n");
      return;
    }

    if (isStreamError(payload)) {
      if (rejectCompletion) {
        rejectCompletion(new Error(payload.error));
        resolveCompletion = null;
        rejectCompletion = null;
      }
      return;
    }

    if (isStreamAbort(payload)) {
      if (rejectCompletion) {
        rejectCompletion(new Error("Stream aborted before completion"));
        resolveCompletion = null;
        rejectCompletion = null;
      }
      return;
    }

    if (isStreamEnd(payload)) {
      if (activeMessageId && payload.messageId !== activeMessageId) {
        if (rejectCompletion) {
          rejectCompletion(
            new Error(
              `Mismatched stream-end message ID. Expected ${activeMessageId}, received ${payload.messageId}`
            )
          );
          resolveCompletion = null;
          rejectCompletion = null;
        }
        return;
      }
      if (streamLineOpen) {
        writeHuman("\n");
        streamLineOpen = false;
      }
      streamEnded = true;
      if (resolveCompletion) {
        resolveCompletion();
        resolveCompletion = null;
        rejectCompletion = null;
      }
      activeMessageId = null;
    }
  };

  const unsubscribe = await session.subscribeChat(chatListener);

  try {
    await sendAndAwait(messageText, buildSendOptions(initialMode));

    const planWasProposed = planProposed;
    planProposed = false;
    if (initialMode === "plan" && !planWasProposed) {
      throw new Error("Plan mode was requested, but the assistant never proposed a plan.");
    }
    if (planWasProposed) {
      writeHumanLine("\n[auto] Plan received. Approving and switching to execute mode...\n");
      await sendAndAwait("Plan approved. Execute it.", buildSendOptions("exec"));
    }

    let finalEvent: WorkspaceChatMessage | undefined;
    for (let i = liveEvents.length - 1; i >= 0; i -= 1) {
      const candidate = liveEvents[i];
      if (isStreamEnd(candidate)) {
        finalEvent = candidate;
        break;
      }
    }

    if (!finalEvent || !isStreamEnd(finalEvent)) {
      throw new Error("Stream ended without receiving stream-end event");
    }

    const parts = (finalEvent as unknown as { parts?: unknown }).parts ?? [];
    const text = extractAssistantText(parts);
    const reasoning = extractReasoning(parts);
    const toolCalls = extractToolCalls(parts);

    if (emitFinalJson) {
      writeJson({
        success: true,
        data: {
          messageId: finalEvent.messageId,
          model: finalEvent.metadata?.model ?? null,
          text,
          reasoning,
          toolCalls,
          metadata: finalEvent.metadata ?? null,
          parts,
          events: liveEvents,
        },
      });
    }
  } finally {
    unsubscribe();
    session.dispose();
  }
}

// Keep process alive explicitly - Bun may exit when stdin closes even if async work is pending
const keepAliveInterval = setInterval(() => {
  // No-op to keep event loop alive
}, 1000000);

(async () => {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const wantsJsonStreaming =
      process.argv.includes("--json-streaming") || process.argv.includes("--json-streaming=true");
    const wantsJson = process.argv.includes("--json") || process.argv.includes("--json=true");

    if (wantsJsonStreaming) {
      process.stdout.write(`${JSON.stringify({ type: "error", error: message })}\n`);
    }

    if (wantsJson) {
      writeJson({ success: false, error: message });
    } else {
      process.stderr.write(`Error: ${message}\n`);
    }
    process.exitCode = 1;
  } finally {
    clearInterval(keepAliveInterval);
  }
})();

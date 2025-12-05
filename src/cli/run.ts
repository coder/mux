#!/usr/bin/env bun
/**
 * `mux run` - First-class CLI for running agent sessions
 *
 * Usage:
 *   mux run "Fix the failing tests"
 *   mux run --dir /path/to/project "Add authentication"
 *   mux run --runtime "ssh user@host" "Deploy changes"
 */

import { Command } from "commander";
import * as path from "path";
import * as fs from "fs/promises";
import { Config } from "@/node/config";
import { HistoryService } from "@/node/services/historyService";
import { PartialService } from "@/node/services/partialService";
import { InitStateManager } from "@/node/services/initStateManager";
import { AIService } from "@/node/services/aiService";
import { AgentSession, type AgentSessionChatEvent } from "@/node/services/agentSession";
import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import { MCPConfigService } from "@/node/services/mcpConfigService";
import { MCPServerManager } from "@/node/services/mcpServerManager";
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
import { modeToToolPolicy } from "@/common/utils/ui/modeUtils";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { RuntimeConfig } from "@/common/types/runtime";
import { parseRuntimeModeAndHost, RUNTIME_MODE } from "@/common/types/runtime";
import assert from "@/common/utils/assert";
import parseDuration from "parse-duration";
import { log, type LogLevel } from "@/node/services/log";

type CLIMode = "plan" | "exec";

function parseRuntimeConfig(value: string | undefined, srcBaseDir: string): RuntimeConfig {
  if (!value) {
    // Default to local for `mux run` (no worktree isolation needed for one-off)
    return { type: "local" };
  }

  const { mode, host } = parseRuntimeModeAndHost(value);

  switch (mode) {
    case RUNTIME_MODE.LOCAL:
      return { type: "local" };
    case RUNTIME_MODE.WORKTREE:
      return { type: "worktree", srcBaseDir };
    case RUNTIME_MODE.SSH:
      if (!host.trim()) {
        throw new Error("SSH runtime requires a host (e.g., --runtime 'ssh user@host')");
      }
      return { type: "ssh", host: host.trim(), srcBaseDir };
    default:
      return { type: "local" };
  }
}

function parseTimeout(value: string | undefined): number | undefined {
  if (!value) return undefined;

  const trimmed = value.trim();

  // Try parsing as plain number (milliseconds)
  const asNumber = Number(trimmed);
  if (!Number.isNaN(asNumber) && asNumber > 0) {
    return Math.round(asNumber);
  }

  // Use parse-duration for human-friendly formats (5m, 300s, 1h30m, etc.)
  const ms = parseDuration(trimmed);
  if (ms === null || ms <= 0) {
    throw new Error(
      `Invalid timeout format "${value}". Use: 5m, 300s, 1h30m, or milliseconds (e.g., 300000)`
    );
  }

  return Math.round(ms);
}

function parseThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  if (!value) return "medium"; // Default for mux run

  const normalized = value.trim().toLowerCase();
  if (
    normalized === "off" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high"
  ) {
    return normalized;
  }
  throw new Error(`Invalid thinking level "${value}". Expected: off, low, medium, high`);
}

function parseMode(value: string | undefined): CLIMode {
  if (!value) return "exec";

  const normalized = value.trim().toLowerCase();
  if (normalized === "plan") return "plan";
  if (normalized === "exec" || normalized === "execute") return "exec";

  throw new Error(`Invalid mode "${value}". Expected: plan, exec`);
}

function generateWorkspaceId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `run-${timestamp}-${random}`;
}

async function ensureDirectory(dirPath: string): Promise<void> {
  const stats = await fs.stat(dirPath);
  if (!stats.isDirectory()) {
    throw new Error(`"${dirPath}" is not a directory`);
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
    } else if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
    } else if (chunk instanceof Uint8Array) {
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function renderUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

interface MCPServerEntry {
  name: string;
  command: string;
}

function collectMcpServers(value: string, previous: MCPServerEntry[]): MCPServerEntry[] {
  const eqIndex = value.indexOf("=");
  if (eqIndex === -1) {
    throw new Error(`Invalid --mcp format: "${value}". Expected: name=command`);
  }
  const name = value.slice(0, eqIndex).trim();
  const command = value.slice(eqIndex + 1).trim();
  if (!name) {
    throw new Error(`Invalid --mcp format: "${value}". Server name is required`);
  }
  if (!command) {
    throw new Error(`Invalid --mcp format: "${value}". Command is required`);
  }
  return [...previous, { name, command }];
}

const program = new Command();

program
  .name("mux run")
  .description("Run an agent session in the current directory")
  .argument("[message]", "instruction for the agent (can also be piped via stdin)")
  .option("-d, --dir <path>", "project directory", process.cwd())
  .option("-m, --model <model>", "model to use", defaultModel)
  .option("-r, --runtime <runtime>", "runtime type: local, worktree, or 'ssh <host>'", "local")
  .option("--mode <mode>", "agent mode: plan or exec", "exec")
  .option("-t, --thinking <level>", "thinking level: off, low, medium, high", "medium")
  .option("--timeout <duration>", "timeout (e.g., 5m, 300s, 300000)")
  .option("-v, --verbose", "show info-level logs (default: errors only)")
  .option("--log-level <level>", "set log level: error, warn, info, debug")
  .option("--json", "output NDJSON for programmatic consumption")
  .option("-q, --quiet", "only output final result")
  .option("--workspace-id <id>", "explicit workspace ID (auto-generated if not provided)")
  .option("--config-root <path>", "mux config directory")
  .option("--mcp <server>", "MCP server as name=command (can be repeated)", collectMcpServers, [])
  .option("--no-mcp-config", "ignore .mux/mcp.jsonc, use only --mcp servers")
  .addHelpText(
    "after",
    `
Examples:
  $ mux run "Fix the failing tests"
  $ mux run --dir /path/to/project "Add authentication"
  $ mux run --runtime "ssh user@host" "Deploy changes"
  $ mux run --mode plan "Refactor the auth module"
  $ echo "Add logging" | mux run
  $ mux run --json "List all files" | jq '.type'
  $ mux run --mcp "memory=npx -y @modelcontextprotocol/server-memory" "Remember this"
  $ mux run --mcp "chrome=npx chrome-devtools-mcp" --mcp "fs=npx @anthropic/mcp-fs" "Take a screenshot"
`
  );

program.parse(process.argv);

interface CLIOptions {
  dir: string;
  model: string;
  runtime: string;
  mode: string;
  thinking: string;
  timeout?: string;
  verbose?: boolean;
  logLevel?: string;
  json?: boolean;
  quiet?: boolean;
  workspaceId?: string;
  configRoot?: string;
  mcp: MCPServerEntry[];
  mcpConfig: boolean;
}

const opts = program.opts<CLIOptions>();
const messageArg = program.args[0];

async function main(): Promise<void> {
  // Configure log level early (before any logging happens)
  if (opts.logLevel) {
    const level = opts.logLevel.toLowerCase();
    if (level === "error" || level === "warn" || level === "info" || level === "debug") {
      log.setLevel(level as LogLevel);
    } else {
      console.error(`Invalid log level "${opts.logLevel}". Expected: error, warn, info, debug`);
      process.exit(1);
    }
  } else if (opts.verbose) {
    log.setLevel("info");
  }
  // Default is already "warn" for CLI mode (set in log.ts)

  // Resolve directory
  const projectDir = path.resolve(opts.dir);
  await ensureDirectory(projectDir);

  // Get message from arg or stdin
  const stdinMessage = await gatherMessageFromStdin();
  const message = messageArg?.trim() ?? stdinMessage.trim();

  if (!message) {
    console.error("Error: No message provided. Pass as argument or pipe via stdin.");
    console.error('Usage: mux run "Your instruction here"');
    process.exit(1);
  }

  // Setup config
  const config = new Config(opts.configRoot);
  const workspaceId = opts.workspaceId ?? generateWorkspaceId();
  const model: string = opts.model;
  const runtimeConfig = parseRuntimeConfig(opts.runtime, config.srcDir);
  const thinkingLevel = parseThinkingLevel(opts.thinking);
  const initialMode = parseMode(opts.mode);
  const timeoutMs = parseTimeout(opts.timeout);
  const emitJson = opts.json === true;
  const quiet = opts.quiet === true;

  const suppressHumanOutput = emitJson || quiet;

  const writeHuman = (text: string) => {
    if (!suppressHumanOutput) process.stdout.write(text);
  };
  const writeHumanLine = (text = "") => {
    if (!suppressHumanOutput) process.stdout.write(`${text}\n`);
  };
  const emitJsonLine = (payload: unknown) => {
    if (emitJson) process.stdout.write(`${JSON.stringify(payload)}\n`);
  };

  // Log startup info (shown at info+ level, i.e., with --verbose)
  log.info(`Directory: ${projectDir}`);
  log.info(`Model: ${model}`);
  log.info(
    `Runtime: ${runtimeConfig.type}${runtimeConfig.type === "ssh" ? ` (${runtimeConfig.host})` : ""}`
  );
  log.info(`Mode: ${initialMode}`);

  // Initialize services
  const historyService = new HistoryService(config);
  const partialService = new PartialService(config, historyService);
  const initStateManager = new InitStateManager(config);
  const backgroundProcessManager = new BackgroundProcessManager();
  const aiService = new AIService(
    config,
    historyService,
    partialService,
    initStateManager,
    backgroundProcessManager
  );
  ensureProvidersConfig(config);

  // Initialize MCP support
  const mcpConfigService = new MCPConfigService();
  const inlineServers: Record<string, string> = {};
  for (const entry of opts.mcp) {
    inlineServers[entry.name] = entry.command;
  }
  const mcpServerManager = new MCPServerManager(mcpConfigService, {
    inlineServers,
    ignoreConfigFile: !opts.mcpConfig,
  });
  aiService.setMCPServerManager(mcpServerManager);

  const session = new AgentSession({
    workspaceId,
    config,
    historyService,
    partialService,
    aiService,
    initStateManager,
    backgroundProcessManager,
  });

  await session.ensureMetadata({
    workspacePath: projectDir,
    projectName: path.basename(projectDir),
    runtimeConfig,
  });

  const buildSendOptions = (cliMode: CLIMode): SendMessageOptions => ({
    model,
    thinkingLevel,
    mode: cliMode,
    toolPolicy: modeToToolPolicy(cliMode),
    // Plan mode instructions are handled by the backend (has access to plan file path)
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
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    } else {
      await completionPromise;
    }

    if (!streamEnded) {
      throw new Error("Stream completion promise resolved unexpectedly without stream end");
    }
  };

  const sendAndAwait = async (msg: string, options: SendMessageOptions): Promise<void> => {
    completionPromise = createCompletionPromise();
    const sendResult = await session.sendMessage(msg, options);
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
    if (!isToolCallStart(payload)) return false;
    writeHumanLine("\n========== TOOL CALL START ==========");
    writeHumanLine(`Tool: ${payload.toolName}`);
    writeHumanLine(`Call ID: ${payload.toolCallId}`);
    writeHumanLine("Arguments:");
    writeHumanLine(renderUnknown(payload.args));
    writeHumanLine("=====================================");
    return true;
  };

  const handleToolDelta = (payload: WorkspaceChatMessage): boolean => {
    if (!isToolCallDelta(payload)) return false;
    writeHumanLine("\n----------- TOOL OUTPUT -------------");
    writeHumanLine(renderUnknown(payload.delta));
    writeHumanLine("-------------------------------------");
    return true;
  };

  const handleToolEnd = (payload: WorkspaceChatMessage): boolean => {
    if (!isToolCallEnd(payload)) return false;
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
    await sendAndAwait(message, buildSendOptions(initialMode));

    const planWasProposed = planProposed;
    planProposed = false;
    if (initialMode === "plan" && !planWasProposed) {
      throw new Error("Plan mode was requested, but the assistant never proposed a plan.");
    }
    if (planWasProposed) {
      writeHumanLine("\n[auto] Plan received. Approving and switching to execute mode...\n");
      await sendAndAwait("Plan approved. Execute it.", buildSendOptions("exec"));
    }

    // Output final result for --quiet mode
    if (quiet) {
      let finalEvent: WorkspaceChatMessage | undefined;
      for (let i = liveEvents.length - 1; i >= 0; i--) {
        if (isStreamEnd(liveEvents[i])) {
          finalEvent = liveEvents[i];
          break;
        }
      }
      if (finalEvent && isStreamEnd(finalEvent)) {
        const parts = (finalEvent as unknown as { parts?: unknown[] }).parts ?? [];
        for (const part of parts) {
          if (part && typeof part === "object" && "type" in part && part.type === "text") {
            const text = (part as { text?: string }).text;
            if (text) console.log(text);
          }
        }
      }
    }
  } finally {
    unsubscribe();
    session.dispose();
    mcpServerManager.dispose();
  }
}

// Keep process alive - Bun may exit when stdin closes even if async work is pending
const keepAliveInterval = setInterval(() => {
  // No-op to keep event loop alive
}, 1000000);

main()
  .then(() => {
    clearInterval(keepAliveInterval);
    process.exit(0);
  })
  .catch((error) => {
    clearInterval(keepAliveInterval);
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });

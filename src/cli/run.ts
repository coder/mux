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
import { tool } from "ai";
import { z } from "zod";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import { Config } from "@/node/config";
import { DisposableTempDir } from "@/node/services/tempDir";
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
  isReasoningDelta,
  isReasoningEnd,
  isStreamAbort,
  isStreamDelta,
  isStreamEnd,
  isStreamError,
  isStreamStart,
  isToolCallDelta,
  isToolCallEnd,
  isToolCallStart,
  isUsageDelta,
  type SendMessageOptions,
  type WorkspaceChatMessage,
} from "@/common/orpc/types";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import {
  getTotalCost,
  formatCostWithDollar,
  sumUsageHistory,
  type ChatUsageDisplay,
} from "@/common/utils/tokens/usageAggregator";
import {
  formatToolStart,
  formatToolEnd,
  formatGenericToolStart,
  formatGenericToolEnd,
  isMultilineResultTool,
} from "./toolFormatters";
import { defaultModel, resolveModelAlias } from "@/common/utils/ai/models";
import { buildProvidersFromEnv, hasAnyConfiguredProvider } from "@/node/utils/providerRequirements";

import {
  DEFAULT_THINKING_LEVEL,
  THINKING_LEVELS,
  isThinkingLevel,
  type ThinkingLevel,
} from "@/common/types/thinking";
import type { RuntimeConfig } from "@/common/types/runtime";
import { parseRuntimeModeAndHost, RUNTIME_MODE } from "@/common/types/runtime";
import assert from "@/common/utils/assert";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import { log, type LogLevel } from "@/node/services/log";
import chalk from "chalk";
import type { InitLogger, WorkspaceInitResult } from "@/node/runtime/Runtime";
import { DockerRuntime } from "@/node/runtime/DockerRuntime";
import { runFullInit } from "@/node/runtime/runtimeFactory";
import { execSync } from "child_process";
import { getParseOptions } from "./argv";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";

const THINKING_LEVELS_LIST = THINKING_LEVELS.join(", ");

type CLIMode = "plan" | "exec";

function parseRuntimeConfig(value: string | undefined, srcBaseDir: string): RuntimeConfig {
  if (!value) {
    // Default to local for `mux run` (no worktree isolation needed for one-off)
    return { type: "local" };
  }

  const parsed = parseRuntimeModeAndHost(value);
  if (!parsed) {
    throw new Error(
      `Invalid runtime: '${value}'. Use 'local', 'worktree', 'ssh <host>', or 'docker <image>'`
    );
  }

  switch (parsed.mode) {
    case RUNTIME_MODE.LOCAL:
      return { type: "local" };
    case RUNTIME_MODE.WORKTREE:
      return { type: "worktree", srcBaseDir };
    case RUNTIME_MODE.SSH:
      return { type: "ssh", host: parsed.host, srcBaseDir };
    case RUNTIME_MODE.DOCKER:
      return { type: "docker", image: parsed.image };
    default:
      return { type: "local" };
  }
}

function parseThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  if (!value) return DEFAULT_THINKING_LEVEL; // Default for mux run

  const normalized = value.trim().toLowerCase();
  if (isThinkingLevel(normalized)) {
    return normalized;
  }
  throw new Error(`Invalid thinking level "${value}". Expected: ${THINKING_LEVELS_LIST}`);
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

function makeCliInitLogger(writeHumanLine: (text?: string) => void): InitLogger {
  return {
    logStep: (msg) => writeHumanLine(`  ${msg}`),
    logStdout: (line) => writeHumanLine(`  ${line}`),
    logStderr: (line) => writeHumanLine(`  [stderr] ${line}`),
    logComplete: (exitCode) => {
      if (exitCode !== 0) writeHumanLine(`  Init completed with exit code ${exitCode}`);
    },
  };
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

const VALID_EXPERIMENT_IDS = new Set<string>(Object.values(EXPERIMENT_IDS));

function collectExperiments(value: string, previous: string[]): string[] {
  const experimentId = value.trim().toLowerCase();
  if (!VALID_EXPERIMENT_IDS.has(experimentId)) {
    throw new Error(
      `Unknown experiment "${value}". Valid experiments: ${[...VALID_EXPERIMENT_IDS].join(", ")}`
    );
  }
  if (previous.includes(experimentId)) {
    return previous; // Dedupe
  }
  return [...previous, experimentId];
}

/**
 * Convert experiment ID array to the experiments object expected by SendMessageOptions.
 */
function buildExperimentsObject(experimentIds: string[]): SendMessageOptions["experiments"] {
  if (experimentIds.length === 0) return undefined;

  return {
    programmaticToolCalling: experimentIds.includes("programmatic-tool-calling"),
    programmaticToolCallingExclusive: experimentIds.includes("programmatic-tool-calling-exclusive"),
    postCompactionContext: experimentIds.includes("post-compaction-context"),
  };
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
  .argument("[message...]", "instruction for the agent (can also be piped via stdin)")
  .option("-d, --dir <path>", "project directory", process.cwd())
  .option("-m, --model <model>", "model to use", defaultModel)
  .option(
    "-r, --runtime <runtime>",
    "runtime type: local, worktree, 'ssh <host>', or 'docker <image>'",
    "local"
  )
  .option("--mode <mode>", "agent mode: plan or exec", "exec")
  .option(
    "-t, --thinking <level>",
    `thinking level: ${THINKING_LEVELS_LIST}`,
    DEFAULT_THINKING_LEVEL
  )
  .option("-v, --verbose", "show info-level logs (default: errors only)")
  .option("--hide-costs", "hide cost summary at end of run")
  .option("--log-level <level>", "set log level: error, warn, info, debug")
  .option("--json", "output NDJSON for programmatic consumption")
  .option("-q, --quiet", "only output final result")
  .option("--mcp <server>", "MCP server as name=command (can be repeated)", collectMcpServers, [])
  .option("--no-mcp-config", "ignore .mux/mcp.jsonc, use only --mcp servers")
  .option("-e, --experiment <id>", "enable experiment (can be repeated)", collectExperiments, [])
  .option("-b, --budget <usd>", "stop when session cost exceeds budget (USD)", parseFloat)
  .addHelpText(
    "after",
    `
Examples:
  $ mux run "Fix the failing tests"
  $ mux run --dir /path/to/project "Add authentication"
  $ mux run --runtime "ssh user@host" "Deploy changes"
  $ mux run --mode plan "Refactor the auth module"
  $ mux run --budget 1.50 "Quick code review"
  $ echo "Add logging" | mux run
  $ mux run --json "List all files" | jq '.type'
  $ mux run --mcp "memory=npx -y @modelcontextprotocol/server-memory" "Remember this"
  $ mux run --mcp "chrome=npx chrome-devtools-mcp" --mcp "fs=npx @anthropic/mcp-fs" "Take a screenshot"
`
  );

program.parse(process.argv, getParseOptions());

interface CLIOptions {
  dir: string;
  model: string;
  runtime: string;
  mode: string;
  thinking: string;
  verbose?: boolean;
  hideCosts?: boolean;
  logLevel?: string;
  json?: boolean;
  quiet?: boolean;
  mcp: MCPServerEntry[];
  mcpConfig: boolean;
  experiment: string[];
  budget?: number;
}

const opts = program.opts<CLIOptions>();
const messageArg = program.args.join(" ");

async function main(): Promise<number> {
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

  // Get message from arg or stdin
  const stdinMessage = await gatherMessageFromStdin();
  const message = messageArg?.trim() || stdinMessage.trim();

  if (!message) {
    console.error("Error: No message provided. Pass as argument or pipe via stdin.");
    console.error('Usage: mux run "Your instruction here"');
    process.exit(1);
  }

  // Create ephemeral temp dir for session data (auto-cleaned on exit)
  using tempDir = new DisposableTempDir("mux-run");

  // Use real config for providers, but ephemeral temp dir for session data
  const realConfig = new Config();
  const config = new Config(tempDir.path);

  // Copy providers and secrets from real config to ephemeral config
  const existingProviders = realConfig.loadProvidersConfig();
  if (hasAnyConfiguredProvider(existingProviders)) {
    // Write providers to temp config so services can find them
    const providersFile = path.join(config.rootDir, "providers.jsonc");
    fsSync.writeFileSync(providersFile, JSON.stringify(existingProviders, null, 2));
  }

  // Copy secrets so tools/MCP servers get project secrets (e.g., GH_TOKEN)
  const existingSecrets = realConfig.loadSecretsConfig();
  if (Object.keys(existingSecrets).length > 0) {
    const secretsFile = path.join(config.rootDir, "secrets.json");
    fsSync.writeFileSync(secretsFile, JSON.stringify(existingSecrets, null, 2));
  }

  const workspaceId = generateWorkspaceId();
  const projectDir = path.resolve(opts.dir);
  await ensureDirectory(projectDir);

  const model: string = resolveModelAlias(opts.model);
  const runtimeConfig = parseRuntimeConfig(opts.runtime, config.srcDir);
  const thinkingLevel = parseThinkingLevel(opts.thinking);
  const initialMode = parseMode(opts.mode);
  const emitJson = opts.json === true;
  const quiet = opts.quiet === true;
  const hideCosts = opts.hideCosts === true;

  const budget = opts.budget;

  // Validate budget
  if (budget !== undefined) {
    if (Number.isNaN(budget)) {
      console.error("Error: --budget must be a valid number");
      process.exit(1);
    }
    if (budget < 0) {
      console.error("Error: --budget cannot be negative");
      process.exit(1);
    }
  }

  const suppressHumanOutput = emitJson || quiet;
  const stdoutIsTTY = process.stdout.isTTY === true;
  const stderrIsTTY = process.stderr.isTTY === true;

  const writeHuman = (text: string) => {
    if (!suppressHumanOutput) process.stdout.write(text);
  };
  const writeHumanLine = (text = "") => {
    if (!suppressHumanOutput) process.stdout.write(`${text}\n`);
  };
  const writeThinking = (text: string) => {
    if (suppressHumanOutput) return;
    // Purple color matching Mux UI thinking blocks (hsl(271, 76%, 53%) = #A855F7)
    const colored = stderrIsTTY ? chalk.hex("#A855F7")(text) : text;
    process.stderr.write(colored);
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
  const backgroundProcessManager = new BackgroundProcessManager(
    path.join(os.tmpdir(), "mux-bashes")
  );
  const aiService = new AIService(
    config,
    historyService,
    partialService,
    initStateManager,
    backgroundProcessManager
  );

  // CLI-only exit code control: allows agent to set the process exit code
  // Useful for CI workflows where the agent should block merge on failure
  let agentExitCode: number | undefined;
  const setExitCodeSchema = z.object({
    exit_code: z
      .number()
      .int()
      .min(0)
      .max(255)
      .describe("Exit code (0 = success, 1-255 = failure)"),
  });
  const setExitCodeTool = tool({
    description:
      "Set the process exit code for this CLI session. " +
      "Use this in CI/automation to signal success (0) or failure (non-zero). " +
      "For example, exit 1 to block a PR merge when issues are found. " +
      "Only available in `mux run` CLI mode.",
    inputSchema: setExitCodeSchema,
    execute: ({ exit_code }: z.infer<typeof setExitCodeSchema>) => {
      agentExitCode = exit_code;
      return { success: true, exit_code };
    },
  });
  aiService.setExtraTools({ set_exit_code: setExitCodeTool });

  // Bootstrap providers from env vars if no providers.jsonc exists
  if (!hasAnyConfiguredProvider(existingProviders)) {
    const providersFromEnv = buildProvidersFromEnv();
    if (hasAnyConfiguredProvider(providersFromEnv)) {
      config.saveProvidersConfig(providersFromEnv);
    } else {
      throw new Error(
        "No provider credentials found. Configure providers.jsonc or set ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY."
      );
    }
  }

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

  // For Docker runtime, create and initialize the container first
  let workspacePath = projectDir;
  if (runtimeConfig.type === "docker") {
    const runtime = new DockerRuntime(runtimeConfig);
    // Use a sanitized branch name (CLI runs are typically one-off, no real branch needed)
    const branchName = `cli-${workspaceId.replace(/[^a-zA-Z0-9-]/g, "-")}`;

    // Detect trunk branch from repo
    let trunkBranch = "main";
    try {
      const symbolic = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
        cwd: projectDir,
        encoding: "utf-8",
      }).trim();
      trunkBranch = symbolic.replace("refs/remotes/origin/", "");
    } catch {
      // Fallback to main
    }

    const initLogger = makeCliInitLogger(writeHumanLine);
    const createResult = await runtime.createWorkspace({
      projectPath: projectDir,
      branchName,
      trunkBranch,
      directoryName: branchName,
      initLogger,
    });
    if (!createResult.success) {
      console.error(`Failed to create Docker workspace: ${createResult.error ?? "unknown error"}`);
      process.exit(1);
    }

    // Use runFullInit to ensure postCreateSetup runs before initWorkspace
    let initResult: WorkspaceInitResult;
    try {
      initResult = await runFullInit(runtime, {
        projectPath: projectDir,
        branchName,
        trunkBranch,
        workspacePath: createResult.workspacePath!,
        initLogger,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      initLogger.logStderr(`Initialization failed: ${errorMessage}`);
      initLogger.logComplete(-1);
      initResult = { success: false, error: errorMessage };
    }
    if (!initResult.success) {
      // Clean up orphaned container
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      await runtime.deleteWorkspace(projectDir, branchName, true).catch(() => {});
      console.error(
        `Failed to initialize Docker workspace: ${initResult.error ?? "unknown error"}`
      );
      process.exit(1);
    }

    // Docker workspacePath is /src; projectName stays as original
    workspacePath = createResult.workspacePath!;
  }

  // Initialize workspace metadata (ephemeral - stored in temp dir)
  await session.ensureMetadata({
    workspacePath,
    projectName: path.basename(projectDir),
    runtimeConfig,
  });

  const experiments = buildExperimentsObject(opts.experiment);

  const buildSendOptions = (cliMode: CLIMode): SendMessageOptions => ({
    model,
    thinkingLevel,
    mode: cliMode,
    experiments,
    // toolPolicy is computed by backend from agent definitions (resolveToolPolicyForAgent)
    // Plan mode instructions are handled by the backend (has access to plan file path)
  });

  const liveEvents: WorkspaceChatMessage[] = [];
  let readyForLive = false;

  /**
   * Tracks whether stdout currently has an unfinished line (i.e. the last write was
   * via `writeHuman(...)` without a trailing newline).
   *
   * This is used to prevent concatenating multi-line blocks (like tool results) onto
   * the end of an inline prefix.
   */
  let streamLineOpen = false;
  let activeMessageId: string | null = null;
  let planProposed = false;
  let streamEnded = false;

  // Track usage for cost summary at end of run
  const usageHistory: ChatUsageDisplay[] = [];
  // Track latest usage-delta per message as fallback when stream-end lacks usage metadata
  const latestUsageDelta = new Map<
    string,
    { usage: LanguageModelV2Usage; providerMetadata?: Record<string, unknown>; model: string }
  >();

  const writeHumanChunk = (text: string) => {
    if (text.length === 0) return;
    writeHuman(text);
    streamLineOpen = !text.endsWith("\n");
  };

  const writeHumanLineClosed = (text = "") => {
    writeHumanLine(text);
    streamLineOpen = false;
  };

  const closeHumanLine = () => {
    if (!streamLineOpen) return;
    writeHumanLineClosed("");
  };

  // Track tool call args by toolCallId for use in end formatting
  const toolCallArgs = new Map<string, unknown>();

  // Budget tracking state
  let budgetExceeded = false;

  // Centralized output type tracking for spacing
  type OutputType = "none" | "text" | "thinking" | "tool";
  let lastOutputType: OutputType = "none";

  /**
   * Ensure proper spacing before starting a new output block.
   * Call this before writing any output to handle transitions cleanly.
   */
  const ensureSpacing = (nextType: OutputType) => {
    const isTransition = lastOutputType !== nextType;

    // Finish any open line when transitioning to a different output type
    if (isTransition) {
      closeHumanLine();
    }

    // Add blank line for transitions (but not at start of output)
    if (lastOutputType !== "none" && isTransition) {
      writeHumanLineClosed("");
    }
    // Also add blank line between consecutive tool calls
    if (lastOutputType === "tool" && nextType === "tool") {
      writeHumanLineClosed("");
    }

    lastOutputType = nextType;
  };

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
    await completionPromise;

    if (!streamEnded) {
      throw new Error("Stream completion promise resolved unexpectedly without stream end");
    }
  };

  const resetCompletionHandlers = () => {
    resolveCompletion = null;
    rejectCompletion = null;
  };

  const rejectStream = (error: Error) => {
    // Keep terminal output readable (error messages should not start mid-line)
    closeHumanLine();
    rejectCompletion?.(error);
    resetCompletionHandlers();
  };

  const resolveStream = () => {
    closeHumanLine();

    streamEnded = true;
    resolveCompletion?.();
    resetCompletionHandlers();

    activeMessageId = null;
    toolCallArgs.clear();
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

    // Cache args for use in end formatting
    toolCallArgs.set(payload.toolCallId, payload.args);
    ensureSpacing("tool");

    // Try formatted output, fall back to generic
    const formatted = formatToolStart(payload);
    if (formatted) {
      // For multiline result tools, put result on a new line; for inline, keep the line open
      // so the end marker (`✓` / `✗`) can land on the same line.
      if (isMultilineResultTool(payload.toolName)) {
        writeHumanLineClosed(formatted);
      } else {
        writeHumanChunk(formatted);
      }
    } else {
      writeHumanLineClosed(formatGenericToolStart(payload));
    }
    return true;
  };

  const handleToolDelta = (payload: WorkspaceChatMessage): boolean => {
    if (!isToolCallDelta(payload)) return false;
    // Tool deltas (e.g., bash streaming output) - write inline
    // Preserve whitespace-only chunks (e.g., newlines) to avoid merging lines
    const deltaStr =
      typeof payload.delta === "string" ? payload.delta : renderUnknown(payload.delta);
    writeHumanChunk(deltaStr);
    return true;
  };

  const handleToolEnd = (payload: WorkspaceChatMessage): boolean => {
    if (!isToolCallEnd(payload)) return false;

    // Retrieve cached args and clean up
    const args = toolCallArgs.get(payload.toolCallId);
    toolCallArgs.delete(payload.toolCallId);

    // Try formatted output, fall back to generic
    const formatted = formatToolEnd(payload, args);
    if (formatted) {
      // For multiline tools, ensure we don't concatenate results onto streaming output.
      if (isMultilineResultTool(payload.toolName)) {
        closeHumanLine();
      }
      writeHumanLineClosed(formatted);
    } else {
      closeHumanLine();
      writeHumanLineClosed(formatGenericToolEnd(payload));
    }

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
        rejectStream(
          new Error(
            `Received conflicting stream-start message IDs (${activeMessageId} vs ${payload.messageId})`
          )
        );
        return;
      }
      activeMessageId = payload.messageId;
      return;
    }

    if (isStreamDelta(payload)) {
      assert(typeof payload.delta === "string", "stream delta must include text");
      ensureSpacing("text");
      writeHumanChunk(payload.delta);
      return;
    }

    if (isReasoningDelta(payload)) {
      ensureSpacing("thinking");
      writeThinking(payload.delta);
      return;
    }

    if (isReasoningEnd(payload)) {
      // Ensure thinking ends with newline (spacing handled by next ensureSpacing call)
      writeThinking("\n");
      return;
    }

    if (isStreamError(payload)) {
      rejectStream(new Error(payload.error));
      return;
    }

    if (isStreamAbort(payload)) {
      // Don't treat budget-triggered abort as an error
      if (budgetExceeded) {
        resolveStream();
      } else {
        rejectStream(new Error("Stream aborted before completion"));
      }
      return;
    }

    if (isStreamEnd(payload)) {
      if (activeMessageId && payload.messageId !== activeMessageId) {
        rejectStream(
          new Error(
            `Mismatched stream-end message ID. Expected ${activeMessageId}, received ${payload.messageId}`
          )
        );
        return;
      }

      // Track usage for cost summary - prefer stream-end metadata, fall back to usage-delta
      let displayUsage: ChatUsageDisplay | undefined;
      if (payload.metadata.usage) {
        displayUsage = createDisplayUsage(
          payload.metadata.usage,
          payload.metadata.model,
          payload.metadata.providerMetadata
        );
      } else {
        // Fallback: use cumulative usage from the last usage-delta event
        const fallback = latestUsageDelta.get(payload.messageId);
        if (fallback) {
          displayUsage = createDisplayUsage(
            fallback.usage,
            fallback.model,
            fallback.providerMetadata
          );
        }
      }
      if (displayUsage) {
        usageHistory.push(displayUsage);

        // Budget enforcement at stream-end for providers that don't emit usage-delta events
        // Use cumulative cost across all messages in this run (not just the current message)
        if (budget !== undefined && !budgetExceeded) {
          const totalUsage = sumUsageHistory(usageHistory);
          const cost = getTotalCost(totalUsage);
          const hasTokens = totalUsage
            ? totalUsage.input.tokens +
                totalUsage.output.tokens +
                totalUsage.cached.tokens +
                totalUsage.cacheCreate.tokens +
                totalUsage.reasoning.tokens >
              0
            : false;

          if (hasTokens && cost === undefined) {
            const errMsg = `Cannot enforce budget: unknown pricing for model "${payload.metadata.model ?? model}"`;
            emitJsonLine({
              type: "budget-error",
              error: errMsg,
              model: payload.metadata.model ?? model,
            });
            rejectStream(new Error(errMsg));
            return;
          }

          if (cost !== undefined && cost > budget) {
            budgetExceeded = true;
            const msg = `Budget exceeded ($${cost.toFixed(2)} of $${budget.toFixed(2)}) - stopping`;
            emitJsonLine({ type: "budget-exceeded", spent: cost, budget });
            writeHumanLineClosed(`\n${chalk.yellow(msg)}`);
            // Don't interrupt - stream is already ending
          }
        }
      }
      latestUsageDelta.delete(payload.messageId);

      resolveStream();
      return;
    }

    // Capture usage-delta events as fallback when stream-end lacks usage metadata
    // Also check budget limits if --budget is specified
    if (isUsageDelta(payload)) {
      latestUsageDelta.set(payload.messageId, {
        usage: payload.cumulativeUsage,
        providerMetadata: payload.cumulativeProviderMetadata,
        model, // Use the model from CLI options
      });

      // Budget enforcement
      if (budget !== undefined) {
        const displayUsage = createDisplayUsage(
          payload.cumulativeUsage,
          model,
          payload.cumulativeProviderMetadata
        );

        const cost = getTotalCost(displayUsage);

        // Reject if model has unknown pricing: displayUsage exists with tokens but cost is undefined
        // (createDisplayUsage doesn't set hasUnknownCosts; that's only set by sumUsageHistory)
        // Include all token types: input, output, cached, cacheCreate, and reasoning
        const hasTokens =
          displayUsage &&
          displayUsage.input.tokens +
            displayUsage.output.tokens +
            displayUsage.cached.tokens +
            displayUsage.cacheCreate.tokens +
            displayUsage.reasoning.tokens >
            0;
        if (hasTokens && cost === undefined) {
          const errMsg = `Cannot enforce budget: unknown pricing for model "${model}"`;
          emitJsonLine({ type: "budget-error", error: errMsg, model });
          rejectStream(new Error(errMsg));
          return;
        }

        if (cost !== undefined && cost > budget) {
          budgetExceeded = true;
          const msg = `Budget exceeded ($${cost.toFixed(2)} of $${budget.toFixed(2)}) - stopping`;
          emitJsonLine({ type: "budget-exceeded", spent: cost, budget });
          writeHumanLineClosed(`\n${chalk.yellow(msg)}`);
          void session.interruptStream({ abandonPartial: false });
        }
      }
      return;
    }
  };

  const unsubscribe = await session.subscribeChat(chatListener);

  try {
    await sendAndAwait(message, buildSendOptions(initialMode));

    // Stop if budget was exceeded during first message
    if (budgetExceeded) {
      // Skip plan auto-approval and any follow-up work
    } else {
      const planWasProposed = planProposed;
      planProposed = false;
      if (initialMode === "plan" && !planWasProposed) {
        throw new Error("Plan mode was requested, but the assistant never proposed a plan.");
      }
      if (planWasProposed) {
        writeHumanLineClosed(
          "\n[auto] Plan received. Approving and switching to execute mode...\n"
        );
        await sendAndAwait("Plan approved. Execute it.", buildSendOptions("exec"));
      }
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

    // Print cost summary at end of run (unless --hide-costs or --json)
    if (!hideCosts && !emitJson) {
      const totalUsage = sumUsageHistory(usageHistory);
      const totalCost = getTotalCost(totalUsage);
      // Skip if no cost data or if model pricing is unknown (would show misleading $0.00)
      if (totalCost !== undefined && !totalUsage?.hasUnknownCosts) {
        const costLine = `Cost: ${formatCostWithDollar(totalCost)}`;
        writeHumanLineClosed("");
        writeHumanLineClosed(stdoutIsTTY ? chalk.gray(costLine) : costLine);
      }
    }
  } finally {
    unsubscribe();
    session.dispose();
    mcpServerManager.dispose();
  }

  // Exit codes: 2 for budget exceeded, agent-specified exit code, or 0 for success
  if (budgetExceeded) return 2;
  return agentExitCode ?? 0;
}

// Keep process alive - Bun may exit when stdin closes even if async work is pending
const keepAliveInterval = setInterval(() => {
  // No-op to keep event loop alive
}, 1000000);

main()
  .then((exitCode) => {
    clearInterval(keepAliveInterval);
    process.exit(exitCode);
  })
  .catch((error) => {
    clearInterval(keepAliveInterval);
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });

#!/usr/bin/env bun
/**
 * `mux workflow` - Headless CLI runner for durable workflow scripts.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { Command } from "commander";

import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { ProjectConfig } from "@/common/types/project";
import { parseRuntimeModeAndHost, RUNTIME_MODE, type RuntimeConfig } from "@/common/types/runtime";
import {
  DEFAULT_THINKING_LEVEL,
  THINKING_DISPLAY_LABELS,
  parseThinkingInput,
  type ParsedThinkingInput,
} from "@/common/types/thinking";
import assert from "@/common/utils/assert";
import { resolveModelAlias, defaultModel } from "@/common/utils/ai/models";
import { getErrorMessage } from "@/common/utils/errors";
import { resolveThinkingInput } from "@/common/utils/thinking/policy";
import { Config } from "@/node/config";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { AgentSession } from "@/node/services/agentSession";
import { CodexOauthService } from "@/node/services/codexOauthService";
import { createCoreServices } from "@/node/services/coreServices";
import { log, type LogLevel } from "@/node/services/log";
import { DisposableTempDir } from "@/node/services/tempDir";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { resolveWorkflowScript } from "@/node/services/workflows/workflowScriptResolver";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import { WorkflowService } from "@/node/services/workflows/WorkflowService";
import {
  DEFAULT_WORKFLOW_AGENT_ID,
  WorkflowTaskServiceAdapter,
} from "@/node/services/workflows/WorkflowTaskServiceAdapter";
import { hasAnyConfiguredProvider, buildProvidersFromEnv } from "@/node/utils/providerRequirements";
import { getParseOptions } from "./argv";
import { exitAfterStdoutFlush } from "./processExit";
import { resolveProjectDir, resolveProjectTrusted } from "./trust";

const VALID_EXPERIMENT_IDS = new Set<string>(Object.values(EXPERIMENT_IDS));
const THINKING_LABELS_LIST = [...new Set(Object.values(THINKING_DISPLAY_LABELS))].join(", ");

export interface ParseWorkflowArgsInput {
  arg?: string[];
  argsJson?: string;
  argsFile?: string;
  argsStdin?: boolean;
  stdinText?: string;
}

interface WorkflowCLIOptions {
  dir?: string;
  runtime: string;
  model: string;
  thinking: string;
  verbose?: boolean;
  logLevel?: string;
  json?: boolean;
  quiet?: boolean;
  arg: string[];
  argsJson?: string;
  argsFile?: string;
  argsStdin?: boolean;
  experiment: string[];
}

type WorkflowServices = ReturnType<typeof createCoreServices>;

interface WorkflowContext {
  realConfig: Config;
  config: Config;
  tempDir: DisposableTempDir;
  projectDir: string;
  workspaceId: string;
  workspacePath: string;
  runtimeConfig: RuntimeConfig;
  projectTrusted: boolean;
  services: WorkflowServices;
  session: AgentSession;
  codexOauthService: CodexOauthService;
}

export async function parseWorkflowArgs(input: ParseWorkflowArgsInput): Promise<unknown> {
  const structuredModes = [
    input.arg != null && input.arg.length > 0 ? "--arg" : null,
    input.argsJson != null ? "--args-json" : null,
    input.argsFile != null ? "--args-file" : null,
    input.argsStdin === true ? "--args-stdin" : null,
  ].filter((mode): mode is string => mode != null);

  if (structuredModes.length > 1) {
    throw new Error(`Only one structured args mode is allowed, got: ${structuredModes.join(", ")}`);
  }

  if (input.argsJson != null) {
    return parseJsonArgs(input.argsJson, "--args-json");
  }
  if (input.argsFile != null) {
    return parseJsonArgs(
      await fs.readFile(input.argsFile, "utf-8"),
      `--args-file ${input.argsFile}`
    );
  }
  if (input.argsStdin === true) {
    return parseJsonArgs(input.stdinText ?? (await gatherStdin()), "--args-stdin");
  }
  if (input.arg != null && input.arg.length > 0) {
    return parseKeyValueArgs(input.arg);
  }

  return {};
}

function parseJsonArgs(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON for ${label}: ${getErrorMessage(error)}`);
  }
}

function parseKeyValueArgs(values: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const value of values) {
    const eqIndex = value.indexOf("=");
    if (eqIndex <= 0) {
      throw new Error(`Invalid --arg "${value}". Expected key=value`);
    }
    const key = value.slice(0, eqIndex).trim();
    assert(key.length > 0, "Workflow --arg key must be non-empty");
    result[key] = parseScalar(value.slice(eqIndex + 1).trim());
  }
  return result;
}

function parseScalar(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (value !== "" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    return Number(value);
  }
  return value;
}

async function gatherStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    if (Buffer.isBuffer(chunk)) chunks.push(chunk);
    else if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
    else if (chunk instanceof Uint8Array) chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function collectExperiments(value: string, previous: string[]): string[] {
  const experimentId = value.trim().toLowerCase();
  if (!VALID_EXPERIMENT_IDS.has(experimentId)) {
    throw new Error(
      `Unknown experiment "${value}". Valid experiments: ${[...VALID_EXPERIMENT_IDS].join(", ")}`
    );
  }
  return previous.includes(experimentId) ? previous : [...previous, experimentId];
}

function parseRuntimeConfig(value: string | undefined): RuntimeConfig {
  if (!value) return { type: "local" };
  const parsed = parseRuntimeModeAndHost(value);
  if (!parsed) {
    throw new Error(
      `Invalid runtime: '${value}'. Use 'local'. Other runtimes are not supported by mux workflow yet.`
    );
  }
  if (parsed.mode !== RUNTIME_MODE.LOCAL) {
    throw new Error(
      `mux workflow currently supports only local runtime. Unsupported runtime: ${parsed.mode}`
    );
  }
  return { type: "local" };
}

function parseThinkingLevel(value: string | undefined): ParsedThinkingInput {
  if (!value) return DEFAULT_THINKING_LEVEL;
  const level = parseThinkingInput(value);
  if (level != null) return level;
  throw new Error(`Invalid thinking level "${value}". Expected: ${THINKING_LABELS_LIST}, or 0–N`);
}

function generateWorkspaceId(): string {
  return `workflow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function copyPersistentConfig(realConfig: Config, config: Config): Promise<void> {
  const existingProviders = realConfig.loadProvidersConfig();
  if (existingProviders != null && hasAnyConfiguredProvider(existingProviders)) {
    config.saveProvidersConfig(existingProviders);
  }
  const existingSecrets = realConfig.loadSecretsConfig();
  if (Object.keys(existingSecrets).length > 0) {
    await config.saveSecretsConfig(existingSecrets);
  }

  const existingConfig = realConfig.loadConfigOrDefault();
  const trustOnlyProjects = new Map<string, ProjectConfig>();
  for (const [projectPath, projectConfig] of existingConfig.projects) {
    if (projectConfig.trusted !== undefined) {
      trustOnlyProjects.set(projectPath, { workspaces: [], trusted: projectConfig.trusted });
    }
  }
  if (trustOnlyProjects.size > 0) {
    // Config.saveConfig is private (lost-update safety); route through the queue.
    await config.editConfig((cfg) => ({ ...cfg, projects: trustOnlyProjects }));
  }
}

function buildExperimentsObject(experimentIds: readonly string[]) {
  return {
    programmaticToolCalling: experimentIds.includes(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING),
    programmaticToolCallingExclusive: experimentIds.includes(
      EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING_EXCLUSIVE
    ),
    execSubagentHardRestart: experimentIds.includes(EXPERIMENT_IDS.EXEC_SUBAGENT_HARD_RESTART),
    // Invoking `mux workflow` is an explicit opt-in, so the dynamic-workflows
    // experiment is enabled implicitly for this invocation (never persisted).
    dynamicWorkflows: true,
    workspaceHeartbeats: experimentIds.includes(EXPERIMENT_IDS.WORKSPACE_HEARTBEATS),
  };
}

async function disposeWorkflowResources(input: {
  tempDir: DisposableTempDir;
  services?: WorkflowServices;
  session?: AgentSession;
  codexOauthService?: CodexOauthService;
}): Promise<void> {
  // Suppress monitor:stopped before session.dispose() triggers cleanup() so persisted
  // armed-monitor registry records survive shutdown (post-restart "monitor lost" wakes).
  input.services?.backgroundProcessManager.beginShutdown();
  try {
    input.session?.dispose();
  } catch (error) {
    log.warn("mux workflow: failed to dispose session", { error: getErrorMessage(error) });
  }
  try {
    input.services?.mcpServerManager.dispose();
  } catch (error) {
    log.warn("mux workflow: failed to dispose MCP server manager", {
      error: getErrorMessage(error),
    });
  }
  try {
    await input.codexOauthService?.dispose();
  } catch (error) {
    log.warn("mux workflow: failed to dispose Codex OAuth service", {
      error: getErrorMessage(error),
    });
  }
  try {
    await input.services?.backgroundProcessManager.terminateAll();
  } catch (error) {
    log.warn("mux workflow: failed to terminate background processes", {
      error: getErrorMessage(error),
    });
  }
  input.tempDir[Symbol.dispose]();
}

async function disposeWorkflowContext(ctx: WorkflowContext): Promise<void> {
  await disposeWorkflowResources({
    tempDir: ctx.tempDir,
    services: ctx.services,
    session: ctx.session,
    codexOauthService: ctx.codexOauthService,
  });
}

async function createWorkflowContext(options: {
  opts: WorkflowCLIOptions;
  projectDir: string;
}): Promise<WorkflowContext> {
  const tempDir = new DisposableTempDir("mux-workflow");
  let services: WorkflowServices | undefined;
  let session: AgentSession | undefined;
  let codexOauthService: CodexOauthService | undefined;
  try {
    const realConfig = new Config();
    const config = new Config(tempDir.path);
    await copyPersistentConfig(realConfig, config);

    const existingProviders = realConfig.loadProvidersConfig();
    if (!hasAnyConfiguredProvider(existingProviders)) {
      const providersFromEnv = buildProvidersFromEnv();
      if (hasAnyConfiguredProvider(providersFromEnv)) {
        config.saveProvidersConfig(providersFromEnv);
      }
    }

    const workspaceId = generateWorkspaceId();
    assert(workspaceId.length > 0, "mux workflow generated an empty workspace id");
    const runtimeConfig = parseRuntimeConfig(options.opts.runtime);
    const projectTrusted = await resolveProjectTrusted(realConfig, options.projectDir);

    services = createCoreServices({
      config,
      extensionMetadataPath: path.join(tempDir.path, "extensionMetadata.json"),
      mcpConfig: realConfig,
    });
    codexOauthService = new CodexOauthService(config, services.providerService);
    services.aiService.setCodexOauthService(codexOauthService);

    session = new AgentSession({
      workspaceId,
      config,
      historyService: services.historyService,
      aiService: services.aiService,
      initStateManager: services.initStateManager,
      backgroundProcessManager: services.backgroundProcessManager,
      workspaceGoalService: services.workspaceGoalService,
    });
    services.workspaceService.registerSession(workspaceId, session);

    const workspacePath = options.projectDir;
    await session.ensureMetadata({
      workspacePath,
      projectName: path.basename(options.projectDir),
      runtimeConfig,
    });
    assert(workspacePath.length > 0, "mux workflow workspace path must be non-empty");

    return {
      realConfig,
      config,
      tempDir,
      projectDir: options.projectDir,
      workspaceId,
      workspacePath,
      runtimeConfig,
      projectTrusted,
      services,
      session,
      codexOauthService,
    };
  } catch (error) {
    await disposeWorkflowResources({ tempDir, services, session, codexOauthService });
    throw error;
  }
}

function createWorkflowService(input: {
  ctx: WorkflowContext;
  opts: WorkflowCLIOptions;
  model: string;
  thinkingLevel: ParsedThinkingInput;
}): WorkflowService {
  const experiments = buildExperimentsObject(input.opts.experiment);
  const runtime = createRuntime(input.ctx.runtimeConfig, {
    projectPath: input.ctx.projectDir,
    workspaceName: input.ctx.workspaceId,
    workspacePath: input.ctx.workspacePath,
  });
  const workspaceSessionDir = input.ctx.config.getSessionDir(input.ctx.workspaceId);

  return new WorkflowService({
    runStore: new WorkflowRunStore({ sessionDir: workspaceSessionDir }),
    runtimeFactory: new QuickJSRuntimeFactory(),
    taskAdapterFactory: (runId) =>
      new WorkflowTaskServiceAdapter({
        taskService: input.ctx.services.taskService,
        parentWorkspaceId: input.ctx.workspaceId,
        workflowRunId: runId,
        defaultAgentId: DEFAULT_WORKFLOW_AGENT_ID,
        experiments,
        modelString: input.model,
        thinkingLevel: input.thinkingLevel,
        getProjectTrusted: () => input.ctx.projectTrusted,
        patchToolConfig: {
          workspaceId: input.ctx.workspaceId,
          cwd: input.ctx.workspacePath,
          runtime,
          runtimeTempDir: runtime.normalizePath(".mux/tmp", input.ctx.workspacePath),
          workspaceSessionDir,
          trusted: input.ctx.projectTrusted,
        },
      }),
    resolveWorkflowScript: (scriptPath) =>
      resolveWorkflowScript({
        scriptPath,
        runtime,
        workspacePath: input.ctx.workspacePath,
        projectTrusted: input.ctx.projectTrusted,
      }),
    getCurrentProjectTrusted: () => input.ctx.projectTrusted,
    runnerId: input.ctx.workspaceId,
  });
}

async function runWorkflow(scriptPath: string, options: WorkflowCLIOptions): Promise<number> {
  const projectDir = await resolveProjectDir({
    cwd: process.cwd(),
    explicitDir: options.dir,
  });
  parseRuntimeConfig(options.runtime);

  const args = await parseWorkflowArgs({
    arg: options.arg,
    argsJson: options.argsJson,
    argsFile: options.argsFile,
    argsStdin: options.argsStdin,
  });
  const model = resolveModelAlias(options.model);
  const thinkingLevel = resolveThinkingInput(parseThinkingLevel(options.thinking), model);
  const suppressHuman = options.json === true || options.quiet === true;
  const writeLine = (line = "") => {
    if (!suppressHuman) process.stdout.write(`${line}\n`);
  };

  const ctx = await createWorkflowContext({ opts: options, projectDir });
  try {
    const workflowService = createWorkflowService({ ctx, opts: options, model, thinkingLevel });
    writeLine(`workflow: ${scriptPath}`);
    writeLine(`directory: ${projectDir}`);
    writeLine(`runtime: ${ctx.runtimeConfig.type}`);

    const runtime = createRuntime(ctx.runtimeConfig, {
      projectPath: ctx.projectDir,
      workspaceName: ctx.workspaceId,
      workspacePath: ctx.workspacePath,
    });
    const script = await resolveWorkflowScript({
      scriptPath,
      runtime,
      workspacePath: ctx.workspacePath,
      projectTrusted: ctx.projectTrusted,
    });
    const result = await workflowService.startWorkflow({
      script,
      workspaceId: ctx.workspaceId,
      projectTrusted: ctx.projectTrusted,
      args,
      backgroundOnMessageQueued: false,
    });
    if (result.status === "backgrounded") {
      throw new Error("Headless workflow runs must finish in the foreground");
    }
    const run = await workflowService.getRun({ workspaceId: ctx.workspaceId, runId: result.runId });
    if (options.json === true) {
      process.stdout.write(
        `${JSON.stringify({ type: "result", runId: result.runId, status: run?.status ?? result.status, result: result.result })}\n`
      );
    } else {
      const reportMarkdown = extractReportMarkdown(result.result);
      if (reportMarkdown.length > 0) {
        process.stdout.write(reportMarkdown);
        if (!reportMarkdown.endsWith("\n")) process.stdout.write("\n");
      }
    }

    return run?.status === "failed" || run?.status === "interrupted" ? 1 : 0;
  } finally {
    await disposeWorkflowContext(ctx);
  }
}

function extractReportMarkdown(result: unknown): string {
  if (typeof result === "object" && result != null && "reportMarkdown" in result) {
    const reportMarkdown = (result as { reportMarkdown?: unknown }).reportMarkdown;
    return typeof reportMarkdown === "string" ? reportMarkdown : "";
  }
  return "";
}

function configureLogging(options: Pick<WorkflowCLIOptions, "logLevel" | "verbose">): void {
  if (options.logLevel == null) {
    if (options.verbose === true) log.setLevel("info");
    return;
  }
  const level = options.logLevel.toLowerCase();
  if (level !== "error" && level !== "warn" && level !== "info" && level !== "debug") {
    throw new Error(`Invalid log level "${options.logLevel}". Expected: error, warn, info, debug`);
  }
  log.setLevel(level as LogLevel);
}

export async function main(): Promise<number> {
  const program = new Command();
  program
    .name("mux workflow")
    .description(
      "Run mux workflow scripts by explicit script path.\n\nExperimental: invoking this command implicitly enables the dynamic-workflows\nexperiment for this invocation only."
    )
    .option("-d, --dir <path>", "project directory")
    .option("-r, --runtime <runtime>", "runtime type (currently only local is supported)", "local")
    .option("-m, --model <model>", "model to use for workflow-owned agents", defaultModel)
    .option(
      "-t, --thinking <level>",
      `thinking level: ${THINKING_LABELS_LIST}`,
      THINKING_DISPLAY_LABELS[DEFAULT_THINKING_LEVEL]
    )
    .option("--json", "emit JSON/NDJSON output")
    .option("-q, --quiet", "only output final result")
    .option(
      "--arg <key=value>",
      "workflow arg key=value (can be repeated)",
      (value, previous: string[]) => [...previous, value],
      []
    )
    .option("--args-json <json>", "workflow args as JSON")
    .option("--args-file <path>", "read workflow args JSON from a file")
    .option("--args-stdin", "read workflow args JSON from stdin")
    .option(
      "-e, --experiment <id>",
      "enable an additional experiment for workflow-owned child agents (can be repeated)",
      collectExperiments,
      []
    )
    .option("-v, --verbose", "show info-level logs")
    .option("--log-level <level>", "set log level: error, warn, info, debug");

  program
    .command("run")
    .argument("<script_path>", "explicit workflow script path")
    .allowExcessArguments(false)
    .description("Run a workflow in the foreground")
    .action(async (scriptPath: string) => {
      const options = program.opts<WorkflowCLIOptions>();
      configureLogging(options);
      process.exitCode = await runWorkflow(scriptPath, options);
    });

  await program.parseAsync(process.argv, getParseOptions());
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

if (require.main === module) {
  main()
    .then(exitAfterStdoutFlush)
    .catch((error: unknown) => {
      console.error(`Error: ${getErrorMessage(error)}`);
      process.exit(1);
    });
}

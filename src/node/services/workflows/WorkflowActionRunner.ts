import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { z } from "zod";

import {
  JsonValueSchema,
  type WorkflowActionEffectSchema,
  WorkflowActionMetadataSchema,
} from "@/common/orpc/schemas";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { validateJsonSchemaSubsetSchema } from "@/common/utils/jsonSchemaSubset";
import { forceCloseStdio, killProcessTree } from "@/node/utils/disposableExec";
import { log } from "@/node/services/log";
import {
  assertSupportedWorkflowActionSyntax,
  hasStaticWorkflowActionCallableExport,
  parseStaticWorkflowMetadataLiteral,
  STATIC_METADATA_ERROR,
} from "./staticWorkflowMetadata";
import { WORKFLOW_ACTION_CHILD_SOURCE } from "./workflowRuntimeSources.generated";
import type { ResolvedWorkflowAction } from "./WorkflowActionRegistry";

export type WorkflowActionEffect = z.infer<typeof WorkflowActionEffectSchema>;
export type WorkflowActionMetadata = z.infer<typeof WorkflowActionMetadataSchema>;

export interface WorkflowActionDescription {
  metadata: WorkflowActionMetadata;
  hasReconcile: boolean;
}

export interface WorkflowActionArtifact {
  name: string;
  path: string;
  sizeBytes: number;
}

export interface WorkflowActionExecutionResult {
  output: unknown;
  metadata: WorkflowActionMetadata;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  artifacts: WorkflowActionArtifact[];
}

export interface WorkflowActionRunnerOptions {
  abortSignal?: AbortSignal;
  artifactDir: string;
  cwd: string;
  input: unknown;
  timeoutMs: number;
}

/** Context passed to in-process host actions (see workspaceHostActions.ts). */
export interface HostWorkflowActionContext {
  cwd: string;
  abortSignal?: AbortSignal;
}

/**
 * A built-in action implemented in the mux host process with access to backend
 * services. The registry still serves a generated stub source for metadata
 * parsing and replay hashing; execute/reconcile are dispatched here in-process.
 */
export interface HostWorkflowAction {
  metadata: WorkflowActionMetadata;
  execute: (input: unknown, ctx: HostWorkflowActionContext) => Promise<unknown>;
  reconcile?: (input: unknown, ctx: HostWorkflowActionContext) => Promise<unknown>;
}

interface WorkflowActionRunnerPayload {
  attemptId: string;
  mode: "describe" | "execute" | "reconcile";
  actionName: string;
  sourcePath: string;
  sourceHash: string;
  source: string;
  input: unknown;
  cwd: string;
  artifactDir: string;
  execPidPath: string;
  resultPath: string;
}

const WORKFLOW_ACTION_STDIO_LIMIT_BYTES = 64 * 1024;
const WORKFLOW_ACTION_RESULT_LIMIT_BYTES = 1024 * 1024;
/**
 * How long an aborted/timed-out host action gets to observe ctx.abortSignal
 * and settle cooperatively before its in-flight work is abandoned. Generous on
 * purpose: workspace.ensure's worktree creation can take seconds and should
 * finish (it is tagged atomically, so the next reconcile finds it) rather than
 * race the failed step's bookkeeping.
 */
const HOST_ACTION_ABORT_SETTLE_GRACE_MS = 30_000;

/** True when the promise settles (either way) within the grace window. */
async function awaitSettlementBounded(
  promise: Promise<unknown>,
  graceMs: number
): Promise<boolean> {
  let graceHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true
      ),
      new Promise<boolean>((resolve) => {
        graceHandle = setTimeout(() => resolve(false), graceMs);
      }),
    ]);
  } finally {
    clearTimeout(graceHandle);
  }
}
const WORKFLOW_ACTION_EXEC_PID_LIMIT_BYTES = 16 * 1024;
const WORKFLOW_ACTION_EXEC_PID_FILENAME = ".mux-action-exec-pids.json";
const WORKFLOW_ACTION_RESULT_FILENAME = ".mux-action-result.json";

interface BoundedTextCapture {
  text: string;
  bytes: number;
  truncated: boolean;
}

function createBoundedTextCapture(): BoundedTextCapture {
  return { text: "", bytes: 0, truncated: false };
}

function appendBoundedText(capture: BoundedTextCapture, chunk: Buffer): void {
  if (capture.bytes >= WORKFLOW_ACTION_STDIO_LIMIT_BYTES) {
    capture.truncated = true;
    return;
  }
  const remainingBytes = WORKFLOW_ACTION_STDIO_LIMIT_BYTES - capture.bytes;
  const accepted = chunk.byteLength <= remainingBytes ? chunk : chunk.subarray(0, remainingBytes);
  capture.text += accepted.toString();
  capture.bytes += accepted.byteLength;
  if (accepted.byteLength < chunk.byteLength) {
    capture.truncated = true;
  }
}

function formatBoundedText(capture: BoundedTextCapture): string {
  return capture.truncated
    ? `${capture.text}
[truncated after ${WORKFLOW_ACTION_STDIO_LIMIT_BYTES} bytes]`
    : capture.text;
}

const ACTION_CHILD_RESULT_SCHEMA = z.discriminatedUnion("success", [
  z.object({
    attemptId: z.string().min(1),
    success: z.literal(true),
    metadata: WorkflowActionMetadataSchema,
    hasReconcile: z.boolean().optional(),
    output: JsonValueSchema.optional(),
    artifacts: z
      .array(
        z.object({
          name: z.string().min(1),
          path: z.string().min(1),
          sizeBytes: z.number().int().nonnegative().optional(),
        })
      )
      .optional(),
  }),
  z.object({
    attemptId: z.string().min(1),
    success: z.literal(false),
    error: z.string().min(1),
    metadata: WorkflowActionMetadataSchema.optional(),
    artifacts: z
      .array(
        z.object({
          name: z.string().min(1),
          path: z.string().min(1),
          sizeBytes: z.number().int().nonnegative().optional(),
        })
      )
      .optional(),
  }),
]);

export class WorkflowActionExecutionError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly artifacts: WorkflowActionArtifact[];
  readonly metadata?: WorkflowActionMetadata;

  constructor(
    message: string,
    details: {
      stdout: string;
      stderr: string;
      exitCode: number | null;
      signal: string | null;
      durationMs: number;
      artifacts: WorkflowActionArtifact[];
      metadata?: WorkflowActionMetadata;
    }
  ) {
    super(message);
    this.name = "WorkflowActionExecutionError";
    this.stdout = details.stdout;
    this.stderr = details.stderr;
    this.exitCode = details.exitCode;
    this.signal = details.signal;
    this.durationMs = details.durationMs;
    this.artifacts = details.artifacts;
    this.metadata = details.metadata;
  }
}

export class WorkflowActionRunner {
  /**
   * In-process implementations for built-in host actions (workspace.*).
   * Optional: when absent, these actions fall through to their generated stub
   * source, which throws a descriptive "requires the mux host process" error
   * in the child. CLI commands (`mux run`, `mux workflow`) DO have backend
   * services, but they run on an ephemeral config root that is deleted on
   * exit; wiring host actions there would create real git worktrees whose
   * identifying tags evaporate with the temp config (orphaned branches), so
   * those contexts deliberately leave the map unset.
   */
  private readonly hostActions?: ReadonlyMap<string, HostWorkflowAction>;

  constructor(options?: { hostActions?: ReadonlyMap<string, HostWorkflowAction> }) {
    this.hostActions = options?.hostActions;
  }

  describe(action: ResolvedWorkflowAction): Promise<WorkflowActionDescription> {
    try {
      assert(action.name.length > 0, "WorkflowActionRunner.describe: action name is required");
      assertSupportedWorkflowActionSyntax(action.source);
      assert(
        hasStaticWorkflowActionCallableExport(action.source, "execute"),
        "Workflow action must export an execute function"
      );
      return Promise.resolve({
        metadata: validateWorkflowActionMetadata(parseStaticWorkflowActionMetadata(action.source)),
        hasReconcile: hasStaticWorkflowActionCallableExport(action.source, "reconcile"),
      });
    } catch (error) {
      return Promise.reject(new Error(getErrorMessage(error)));
    }
  }

  async execute(
    action: ResolvedWorkflowAction,
    options: WorkflowActionRunnerOptions
  ): Promise<WorkflowActionExecutionResult> {
    const hostAction = this.resolveHostAction(action);
    if (hostAction != null) {
      return await this.runHostAction("execute", hostAction, options);
    }
    return await this.runExecutableChild("execute", action, options);
  }

  async reconcile(
    action: ResolvedWorkflowAction,
    options: WorkflowActionRunnerOptions
  ): Promise<WorkflowActionExecutionResult> {
    const hostAction = this.resolveHostAction(action);
    if (hostAction != null) {
      return await this.runHostAction("reconcile", hostAction, options);
    }
    return await this.runExecutableChild("reconcile", action, options);
  }

  /**
   * Host actions only apply to built-in scope: a trusted project/global action
   * shadowing the same name keeps standard child execution semantics.
   */
  private resolveHostAction(action: ResolvedWorkflowAction): HostWorkflowAction | undefined {
    if (action.scope !== "built-in") {
      return undefined;
    }
    return this.hostActions?.get(action.name);
  }

  private async runHostAction(
    mode: "execute" | "reconcile",
    hostAction: HostWorkflowAction,
    options: WorkflowActionRunnerOptions
  ): Promise<WorkflowActionExecutionResult> {
    assert(options.timeoutMs > 0, "WorkflowActionRunner.runHostAction: timeoutMs must be positive");
    const fn = mode === "reconcile" ? hostAction.reconcile : hostAction.execute;
    const startedAt = Date.now();
    const failure = (message: string) =>
      new WorkflowActionExecutionError(message, {
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startedAt,
        artifacts: [],
        metadata: hostAction.metadata,
      });

    if (fn == null) {
      throw failure(`Host action does not support ${mode}`);
    }

    // Compose run-abort + step-timeout into ONE signal handed to the action.
    // This mirrors child-action semantics (which SIGKILL the child): an abort
    // or timeout must FAIL the step — never produce a durable success — and
    // the composed signal also terminates in-action poll loops so they can't
    // keep running after the step has been decided.
    if (options.abortSignal?.aborted === true) {
      throw failure("Host action aborted: workflow run was interrupted");
    }
    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => controller.abort(new Error(`Host action timed out after ${options.timeoutMs}ms`)),
      options.timeoutMs
    );
    const onExternalAbort = () =>
      controller.abort(new Error("Host action aborted: workflow run was interrupted"));
    options.abortSignal?.addEventListener("abort", onExternalAbort, { once: true });
    const abortPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason as Error), {
        once: true,
      });
    });
    try {
      const ctx: HostWorkflowActionContext = {
        cwd: options.cwd,
        abortSignal: controller.signal,
      };
      const fnPromise = Promise.resolve().then(() => fn(options.input, ctx));
      let output: unknown;
      try {
        output = await Promise.race([fnPromise, abortPromise]);
      } catch (raceError) {
        // Host actions can't be SIGKILLed like child actions. On abort/timeout
        // the composed ctx.abortSignal is already aborted, so wait (bounded)
        // for the action to observe it and settle cooperatively — otherwise a
        // mutating action (sendMessage/ensure) could land its side effect
        // AFTER the step is recorded failed. A bounded grace keeps a signal-
        // ignoring action from hanging the step forever; abandoning is the
        // logged last resort.
        if (controller.signal.aborted) {
          const settled = await awaitSettlementBounded(
            fnPromise,
            HOST_ACTION_ABORT_SETTLE_GRACE_MS
          );
          if (!settled) {
            log.error("Host action ignored abort signal; abandoning in-flight work", {
              timeoutMs: options.timeoutMs,
            });
          }
        }
        throw raceError;
      }
      // Mirror the child-result bound so host actions can't blow up run storage.
      // Use byte length (not UTF-16 code units) for parity with the child path.
      const serialized = JSON.stringify(output ?? null);
      assert(
        serialized != null &&
          Buffer.byteLength(serialized, "utf8") <= WORKFLOW_ACTION_RESULT_LIMIT_BYTES,
        "Host action output must be JSON-serializable and within the result size limit"
      );
      // Round-trip through JSON so host outputs match child-action semantics
      // (child results cross a JSON file): drops `undefined` properties that
      // would otherwise fail strict JSON-value validation downstream.
      const normalizedOutput: unknown = JSON.parse(serialized);
      return {
        output: normalizedOutput,
        metadata: hostAction.metadata,
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
        durationMs: Date.now() - startedAt,
        artifacts: [],
      };
    } catch (error) {
      if (error instanceof WorkflowActionExecutionError) {
        throw error;
      }
      throw failure(getErrorMessage(error));
    } finally {
      clearTimeout(timeoutHandle);
      options.abortSignal?.removeEventListener("abort", onExternalAbort);
    }
  }

  private async runExecutableChild(
    mode: "execute" | "reconcile",
    action: ResolvedWorkflowAction,
    options: WorkflowActionRunnerOptions
  ): Promise<WorkflowActionExecutionResult> {
    assert(
      action.name.length > 0,
      "WorkflowActionRunner.runExecutableChild: action name is required"
    );
    assert(
      options.timeoutMs > 0,
      "WorkflowActionRunner.runExecutableChild: timeoutMs must be positive"
    );
    using child = await this.runChild(action, { mode, ...options });
    if (!child.result.success) {
      throw new WorkflowActionExecutionError(child.result.error, child);
    }
    return {
      output: child.result.output,
      metadata: validateWorkflowActionMetadata(child.result.metadata),
      stdout: child.stdout,
      stderr: child.stderr,
      exitCode: child.exitCode,
      signal: child.signal,
      durationMs: child.durationMs,
      artifacts: await normalizeArtifacts(child.result.artifacts ?? []),
    };
  }

  private async runChild(
    action: ResolvedWorkflowAction,
    options: WorkflowActionRunnerOptions & { mode: "describe" | "execute" | "reconcile" }
  ): Promise<{
    result: z.infer<typeof ACTION_CHILD_RESULT_SCHEMA>;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal: string | null;
    durationMs: number;
    artifacts: WorkflowActionArtifact[];
    [Symbol.dispose](): void;
  }> {
    await fs.mkdir(options.artifactDir, { recursive: true });
    const resultPath = path.join(options.artifactDir, WORKFLOW_ACTION_RESULT_FILENAME);
    const execPidPath = path.join(options.artifactDir, WORKFLOW_ACTION_EXEC_PID_FILENAME);
    await fs.rm(resultPath, { force: true });
    await fs.rm(execPidPath, { force: true });
    const attemptId = crypto.randomUUID();
    const payload: WorkflowActionRunnerPayload = {
      attemptId,
      mode: options.mode,
      actionName: action.name,
      sourcePath: action.sourcePath,
      sourceHash: action.sourceHash,
      source: action.source,
      input: options.input,
      cwd: options.cwd,
      artifactDir: options.artifactDir,
      execPidPath,
      resultPath,
    };
    const startedAt = Date.now();
    const child = spawn(process.execPath, ["-e", WORKFLOW_ACTION_CHILD_SOURCE], {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
      },
    });

    const stdoutCapture = createBoundedTextCapture();
    const stderrCapture = createBoundedTextCapture();
    let exitCode: number | null = null;
    let signal: string | null = null;
    let timedOut = false;
    let aborted = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    const killChild = () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      killTrackedExecProcesses(execPidPath);
      if (child.pid != null) {
        if (process.platform === "win32") {
          killProcessTree(child.pid);
        } else {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            killProcessTree(child.pid);
          }
          forceKillTimer ??= setTimeout(() => {
            killTrackedExecProcesses(execPidPath);
            if (child.pid != null) {
              killProcessTree(child.pid);
            }
          }, 100);
          forceKillTimer.unref?.();
        }
      } else {
        child.kill("SIGKILL");
      }
      forceCloseStdio(child);
    };
    const abortChild = () => {
      aborted = true;
      killChild();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      killChild();
    }, options.timeoutMs);
    timeout.unref?.();

    if (options.abortSignal?.aborted === true) {
      abortChild();
    } else {
      options.abortSignal?.addEventListener("abort", abortChild, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      appendBoundedText(stdoutCapture, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      appendBoundedText(stderrCapture, chunk);
    });
    child.on("exit", (code, childSignal) => {
      exitCode = code;
      signal = childSignal;
    });

    const closePromise = new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", () => resolve());
    });

    child.stdin?.end(JSON.stringify(payload));

    try {
      await closePromise;
    } finally {
      clearTimeout(timeout);
      options.abortSignal?.removeEventListener("abort", abortChild);
      if (forceKillTimer != null) {
        clearTimeout(forceKillTimer);
      }
      await fs.rm(execPidPath, { force: true });
    }

    const durationMs = Date.now() - startedAt;
    const stdout = formatBoundedText(stdoutCapture);
    const stderr = formatBoundedText(stderrCapture);
    let resultStat: Awaited<ReturnType<typeof statOptional>>;
    try {
      resultStat = await statOptional(resultPath);
      if (resultStat != null && resultStat.size > WORKFLOW_ACTION_RESULT_LIMIT_BYTES) {
        throw new Error(
          `result exceeded ${WORKFLOW_ACTION_RESULT_LIMIT_BYTES} bytes: ${resultStat.size}`
        );
      }
    } catch (error) {
      const errorDetails = { stdout, stderr, exitCode, signal, durationMs, artifacts: [] };
      throw new WorkflowActionExecutionError(
        `Workflow action ${action.name} did not produce a valid result: ${getErrorMessage(error)}`,
        errorDetails
      );
    }
    const artifacts = await normalizeArtifacts(
      resultStat == null ? [] : await readArtifactListing(resultPath)
    );
    const errorDetails = { stdout, stderr, exitCode, signal, durationMs, artifacts };
    if (timedOut) {
      throw new WorkflowActionExecutionError(
        `Workflow action ${action.name} timed out after ${options.timeoutMs}ms`,
        errorDetails
      );
    }
    if (aborted) {
      throw new WorkflowActionExecutionError(
        `Workflow action ${action.name} was aborted`,
        errorDetails
      );
    }

    let rawResult: unknown;
    try {
      if (resultStat == null) {
        throw new Error("result file was not written");
      }
      rawResult = JSON.parse(await fs.readFile(resultPath, "utf-8"));
    } catch (error) {
      throw new WorkflowActionExecutionError(
        `Workflow action ${action.name} did not produce a valid result: ${getErrorMessage(error)}`,
        errorDetails
      );
    }

    const parsed = ACTION_CHILD_RESULT_SCHEMA.safeParse(rawResult);
    if (!parsed.success) {
      throw new WorkflowActionExecutionError(
        `Workflow action ${action.name} produced an invalid result: ${parsed.error.message}`,
        errorDetails
      );
    }
    if (parsed.data.attemptId !== attemptId) {
      throw new WorkflowActionExecutionError(
        `Workflow action ${action.name} produced a stale result for a different attempt`,
        errorDetails
      );
    }
    if (parsed.data.success && (exitCode !== 0 || signal !== null)) {
      const exitReason = signal != null ? String(signal) : String(exitCode ?? "unknown");
      throw new WorkflowActionExecutionError(
        `Workflow action ${action.name} exited after writing a success result: ${exitReason}`,
        errorDetails
      );
    }

    const resultArtifacts = await normalizeArtifacts(parsed.data.artifacts ?? artifacts);
    return {
      result: parsed.data,
      stdout,
      stderr,
      exitCode,
      signal,
      durationMs,
      artifacts: resultArtifacts,
      [Symbol.dispose]() {
        killChild();
      },
    };
  }
}

export function validateWorkflowActionMetadata(metadata: unknown): WorkflowActionMetadata {
  const parsed = WorkflowActionMetadataSchema.parse(metadata);
  for (const [field, schema] of [
    ["inputSchema", parsed.inputSchema],
    ["outputSchema", parsed.outputSchema],
  ] as const) {
    if (schema === undefined) {
      continue;
    }
    const validation = validateJsonSchemaSubsetSchema(schema);
    if (!validation.success) {
      throw new Error(
        `Workflow action ${field} uses unsupported JSON Schema: ${validation.errors
          .map((error) => `${error.path}: ${error.message}`)
          .join("; ")}`
      );
    }
  }
  return parsed;
}

async function normalizeArtifacts(
  artifacts: Array<{ name: string; path: string; sizeBytes?: number }>
): Promise<WorkflowActionArtifact[]> {
  const normalized: WorkflowActionArtifact[] = [];
  for (const artifact of artifacts) {
    let sizeBytes = artifact.sizeBytes;
    if (sizeBytes == null) {
      try {
        sizeBytes = (await fs.stat(artifact.path)).size;
      } catch {
        sizeBytes = 0;
      }
    }
    normalized.push({ name: artifact.name, path: artifact.path, sizeBytes });
  }
  return normalized;
}

async function readArtifactListing(resultPath: string): Promise<WorkflowActionArtifact[]> {
  try {
    const resultStat = await statOptional(resultPath);
    if (resultStat == null || resultStat.size > WORKFLOW_ACTION_RESULT_LIMIT_BYTES) {
      return [];
    }
    const parsed = ACTION_CHILD_RESULT_SCHEMA.safeParse(
      JSON.parse(await fs.readFile(resultPath, "utf-8"))
    );
    if (parsed.success) {
      return await normalizeArtifacts(parsed.data.artifacts ?? []);
    }
  } catch {
    return [];
  }
  return [];
}

function killTrackedExecProcesses(execPidPath: string): void {
  let rawPids: unknown;
  try {
    if (fsSync.statSync(execPidPath).size > WORKFLOW_ACTION_EXEC_PID_LIMIT_BYTES) {
      return;
    }
    rawPids = JSON.parse(fsSync.readFileSync(execPidPath, "utf-8"));
  } catch {
    return;
  }
  if (!Array.isArray(rawPids)) {
    return;
  }
  for (const rawPid of rawPids) {
    if (typeof rawPid === "number" && Number.isFinite(rawPid) && rawPid > 0) {
      killProcessTree(rawPid);
    }
  }
}

async function statOptional(filePath: string): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

function parseStaticWorkflowActionMetadata(source: string): unknown {
  return normalizeStaticWorkflowActionMetadata(parseStaticWorkflowMetadataLiteral(source));
}

function normalizeStaticWorkflowActionMetadata(rawMetadata: unknown): unknown {
  if (rawMetadata == null || typeof rawMetadata !== "object" || Array.isArray(rawMetadata)) {
    throw new Error(STATIC_METADATA_ERROR);
  }
  const metadata = rawMetadata as Record<string, unknown>;
  return {
    version: metadata.version ?? 1,
    description: metadata.description,
    effect: normalizeStaticWorkflowActionEffect(metadata.effect ?? metadata.effectLevel),
    ...(metadata.inputSchema !== undefined ? { inputSchema: metadata.inputSchema } : {}),
    ...(metadata.outputSchema !== undefined ? { outputSchema: metadata.outputSchema } : {}),
    ...(metadata.permissions !== undefined ? { permissions: metadata.permissions } : {}),
    ...(metadata.timeoutMs !== undefined ? { timeoutMs: metadata.timeoutMs } : {}),
  };
}

function normalizeStaticWorkflowActionEffect(rawEffect: unknown): unknown {
  if (rawEffect === "read" || rawEffect === "readonly" || rawEffect === "read-only") {
    return "read";
  }
  if (rawEffect === "workspace" || rawEffect === "workspace-mutating") {
    return "workspace";
  }
  if (rawEffect === "external" || rawEffect === "external-side-effect") {
    return "external";
  }
  return rawEffect;
}

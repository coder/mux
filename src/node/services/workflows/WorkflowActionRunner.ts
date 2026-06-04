import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
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
  resultPath: string;
}

const WORKFLOW_ACTION_STDIO_LIMIT_BYTES = 64 * 1024;
const WORKFLOW_ACTION_RESULT_LIMIT_BYTES = 1024 * 1024;
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
  describe(action: ResolvedWorkflowAction): Promise<WorkflowActionDescription> {
    try {
      assert(action.name.length > 0, "WorkflowActionRunner.describe: action name is required");
      assertSupportedWorkflowActionSyntax(action.source);
      return Promise.resolve({
        metadata: validateWorkflowActionMetadata(parseStaticWorkflowActionMetadata(action.source)),
        hasReconcile: hasStaticWorkflowActionReconcileExport(action.source),
      });
    } catch (error) {
      return Promise.reject(new Error(getErrorMessage(error)));
    }
  }

  async execute(
    action: ResolvedWorkflowAction,
    options: WorkflowActionRunnerOptions
  ): Promise<WorkflowActionExecutionResult> {
    return await this.runExecutableChild("execute", action, options);
  }

  async reconcile(
    action: ResolvedWorkflowAction,
    options: WorkflowActionRunnerOptions
  ): Promise<WorkflowActionExecutionResult> {
    return await this.runExecutableChild("reconcile", action, options);
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
    await fs.rm(resultPath, { force: true });
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
    const killChild = () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      if (child.pid != null) {
        killProcessTree(child.pid);
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

async function statOptional(filePath: string): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

function assertSupportedWorkflowActionSyntax(source: string): void {
  if (/^\s*import\s/m.test(source) || /(^|\n)\s*export\s*\{/m.test(source)) {
    throw new Error(
      "Workflow action files currently support CommonJS require() plus export const/function/default declarations; static import/export lists are not supported"
    );
  }
}

const STATIC_METADATA_ERROR =
  "Workflow action metadata must be a static object literal using JSON-compatible values";

function parseStaticWorkflowActionMetadata(source: string): unknown {
  const literal = extractStaticMetadataLiteral(source);
  return normalizeStaticWorkflowActionMetadata(new StaticActionLiteralParser(literal).parseValue());
}

function extractStaticMetadataLiteral(source: string): string {
  const assignments = [
    /(^|[;\n])\s*export\s+(?:const|let|var)\s+metadata\s*=/mu,
    /(^|[;\n])\s*(?:module\.)?exports\.metadata\s*=/mu,
  ];
  for (const pattern of assignments) {
    const match = pattern.exec(source);
    if (match == null) {
      continue;
    }
    const start = skipStaticWhitespace(source, match.index + match[0].length);
    return readObjectLiteralAt(source, start);
  }
  throw new Error(STATIC_METADATA_ERROR);
}

function hasStaticWorkflowActionReconcileExport(source: string): boolean {
  return [
    /(^|[;\n])\s*export\s+(?:async\s+)?function\s+reconcile\s*\(/mu,
    /(^|[;\n])\s*export\s+(?:const|let|var)\s+reconcile\s*=/mu,
    /(^|[;\n])\s*(?:module\.)?exports\.reconcile\s*=/mu,
  ].some((pattern) => pattern.test(source));
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

function readObjectLiteralAt(source: string, start: number): string {
  if (source[start] !== "{") {
    throw new Error(STATIC_METADATA_ERROR);
  }
  let depth = 0;
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      index = skipQuotedString(source, index, char);
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index + 2);
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index + 2);
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
    index += 1;
  }
  throw new Error(STATIC_METADATA_ERROR);
}

function skipStaticWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index + 2);
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index + 2);
      continue;
    }
    break;
  }
  return index;
}

function skipQuotedString(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) {
      return index + 1;
    }
    index += 1;
  }
  throw new Error(STATIC_METADATA_ERROR);
}

function skipLineComment(source: string, start: number): number {
  const end = source.indexOf("\n", start);
  return end === -1 ? source.length : end + 1;
}

function skipBlockComment(source: string, start: number): number {
  const end = source.indexOf("*/", start);
  if (end === -1) {
    throw new Error(STATIC_METADATA_ERROR);
  }
  return end + 2;
}

class StaticActionLiteralParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parseValue(): unknown {
    this.skipWhitespaceAndComments();
    const value = this.readValue();
    this.skipWhitespaceAndComments();
    if (this.index !== this.source.length) {
      throw new Error(STATIC_METADATA_ERROR);
    }
    return value;
  }

  private readValue(): unknown {
    this.skipWhitespaceAndComments();
    const char = this.source[this.index];
    if (char === "{") {
      return this.readObject();
    }
    if (char === "[") {
      return this.readArray();
    }
    if (char === '"' || char === "'") {
      return this.readString(char);
    }
    if (this.source.startsWith("true", this.index)) {
      this.index += "true".length;
      return true;
    }
    if (this.source.startsWith("false", this.index)) {
      this.index += "false".length;
      return false;
    }
    if (this.source.startsWith("null", this.index)) {
      this.index += "null".length;
      return null;
    }
    return this.readNumber();
  }

  private readObject(): Record<string, unknown> {
    this.expect("{");
    const result: Record<string, unknown> = {};
    this.skipWhitespaceAndComments();
    while (!this.consume("}")) {
      const key = this.readObjectKey();
      this.skipWhitespaceAndComments();
      this.expect(":");
      result[key] = this.readValue();
      this.skipWhitespaceAndComments();
      if (this.consume("}")) {
        break;
      }
      this.expect(",");
      this.skipWhitespaceAndComments();
    }
    return result;
  }

  private readArray(): unknown[] {
    this.expect("[");
    const result: unknown[] = [];
    this.skipWhitespaceAndComments();
    while (!this.consume("]")) {
      result.push(this.readValue());
      this.skipWhitespaceAndComments();
      if (this.consume("]")) {
        break;
      }
      this.expect(",");
      this.skipWhitespaceAndComments();
    }
    return result;
  }

  private readObjectKey(): string {
    this.skipWhitespaceAndComments();
    const char = this.source[this.index];
    if (char === '"' || char === "'") {
      return this.readString(char);
    }
    const match = /^[A-Za-z_$][A-Za-z0-9_$-]*/u.exec(this.source.slice(this.index));
    if (match == null) {
      throw new Error(STATIC_METADATA_ERROR);
    }
    this.index += match[0].length;
    return match[0];
  }

  private readString(quote: string): string {
    this.expect(quote);
    let value = "";
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      this.index += 1;
      if (char === quote) {
        return value;
      }
      if (char === "\\") {
        value += this.readEscapeSequence();
      } else {
        value += char;
      }
    }
    throw new Error(STATIC_METADATA_ERROR);
  }

  private readEscapeSequence(): string {
    const char = this.source[this.index];
    this.index += 1;
    switch (char) {
      case '"':
      case "'":
      case "\\":
        return char;
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "u": {
        const hex = this.source.slice(this.index, this.index + 4);
        if (!/^[0-9A-Fa-f]{4}$/u.test(hex)) {
          throw new Error(STATIC_METADATA_ERROR);
        }
        this.index += 4;
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      default:
        throw new Error(STATIC_METADATA_ERROR);
    }
  }

  private readNumber(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
      this.source.slice(this.index)
    );
    if (match == null) {
      throw new Error(STATIC_METADATA_ERROR);
    }
    this.index += match[0].length;
    return Number(match[0]);
  }

  private skipWhitespaceAndComments(): void {
    this.index = skipStaticWhitespace(this.source, this.index);
  }

  private consume(expected: string): boolean {
    if (this.source[this.index] !== expected) {
      return false;
    }
    this.index += 1;
    return true;
  }

  private expect(expected: string): void {
    if (!this.consume(expected)) {
      throw new Error(STATIC_METADATA_ERROR);
    }
  }
}

const WORKFLOW_ACTION_CHILD_SOURCE = String.raw`
const { createRequire } = require("node:module");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

const STDIO_LIMIT_BYTES = 64 * 1024;
const RESULT_LIMIT_BYTES = 1024 * 1024;
const MAX_ARTIFACT_COUNT = 32;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

function createCapture() {
  return { text: "", bytes: 0, truncated: false };
}

function appendCapture(capture, chunk) {
  if (capture.bytes >= STDIO_LIMIT_BYTES) {
    capture.truncated = true;
    return;
  }
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const remaining = STDIO_LIMIT_BYTES - capture.bytes;
  const accepted = buffer.byteLength <= remaining ? buffer : buffer.subarray(0, remaining);
  capture.text += accepted.toString();
  capture.bytes += accepted.byteLength;
  if (accepted.byteLength < buffer.byteLength) capture.truncated = true;
}

function finishCapture(capture) {
  return capture.truncated ? capture.text + "\n[truncated after " + STDIO_LIMIT_BYTES + " bytes]" : capture.text;
}

function listChildPids(pid) {
  try {
    return execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf-8" })
      .trim()
      .split(/\n+/)
      .map((line) => line.trim().split(/\s+/).map((value) => Number(value)))
      .filter(([childPid, parentPid]) => Number.isFinite(childPid) && parentPid === pid)
      .map(([childPid]) => childPid);
  } catch {
    return [];
  }
}

function collectDescendantPids(pid, seen = new Set()) {
  const descendants = [];
  for (const childPid of listChildPids(pid)) {
    if (seen.has(childPid)) continue;
    seen.add(childPid);
    descendants.push(...collectDescendantPids(childPid, seen), childPid);
  }
  return descendants;
}

function killPid(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

function killProcessTree(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {}
    return;
  }
  for (const descendantPid of collectDescendantPids(pid)) {
    killPid(descendantPid);
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    killPid(pid);
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(input));
  });
}

function normalizeEffect(rawEffect) {
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

function normalizeMetadata(rawMetadata) {
  const metadata = rawMetadata && typeof rawMetadata === "object" ? rawMetadata : {};
  return {
    version: metadata.version ?? 1,
    description: metadata.description,
    effect: normalizeEffect(metadata.effect ?? metadata.effectLevel),
    ...(metadata.inputSchema !== undefined ? { inputSchema: metadata.inputSchema } : {}),
    ...(metadata.outputSchema !== undefined ? { outputSchema: metadata.outputSchema } : {}),
    ...(metadata.permissions !== undefined ? { permissions: metadata.permissions } : {}),
    ...(metadata.timeoutMs !== undefined ? { timeoutMs: metadata.timeoutMs } : {}),
  };
}

function assertSupportedActionSyntax(source) {
  if (/^\s*import\s/m.test(source) || /(^|\n)\s*export\s*\{/m.test(source)) {
    throw new Error(
      "Workflow action files currently support CommonJS require() plus export const/function/default declarations; static import/export lists are not supported"
    );
  }
}

function stripExportSyntax(source) {
  return source
    .replace(/(^|\n)\s*export\s+default\s+/g, "$1const __default = ")
    .replace(/(^|\n)\s*export\s+(async\s+function|function)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g, "$1$2 $3")
    .replace(/(^|\n)\s*export\s+(const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g, "$1$2 $3");
}

async function loadAction(payload) {
  assertSupportedActionSyntax(payload.source);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const transformedSource = stripExportSyntax(payload.source);
  const actionDir = path.dirname(payload.sourcePath);
  const actionModule = { exports: {} };
  const factory = new AsyncFunction(
    "module",
    "exports",
    "require",
    "process",
    "__filename",
    "__dirname",
    transformedSource +
      "\nreturn {" +
      "metadata: typeof metadata !== 'undefined' ? metadata : module.exports.metadata," +
      "execute: typeof execute !== 'undefined' ? execute : module.exports.execute," +
      "reconcile: typeof reconcile !== 'undefined' ? reconcile : module.exports.reconcile," +
      "default: typeof __default !== 'undefined' ? __default : module.exports.default," +
      "moduleExports: module.exports" +
      "};"
  );
  const loaded = await factory(
    actionModule,
    actionModule.exports,
    createRequire(payload.sourcePath),
    process,
    payload.sourcePath,
    actionDir
  );
  const defaultExport = loaded.default;
  const moduleExports = loaded.moduleExports && typeof loaded.moduleExports === "object" ? loaded.moduleExports : {};
  return {
    metadata: loaded.metadata ?? defaultExport?.metadata ?? moduleExports.metadata,
    execute: loaded.execute ?? defaultExport?.execute ?? moduleExports.execute,
    reconcile: loaded.reconcile ?? defaultExport?.reconcile ?? moduleExports.reconcile,
  };
}

function assertSafeArtifactName(name) {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("Artifact name must be a non-empty string");
  }
  if (path.isAbsolute(name) || name.split(/[\\/]+/).includes("..")) {
    throw new Error("Artifact name must stay inside the action artifact directory");
  }
  if (path.normalize(name) === ".mux-action-result.json") {
    throw new Error("Artifact name is reserved for workflow action results");
  }
}

async function execCommand(command, args = [], options = {}) {
  if (typeof command !== "string" || command.length === 0) {
    throw new Error("ctx.exec command must be a non-empty string");
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("ctx.exec args must be an array of strings");
  }
  const child = spawn(command, args, {
    cwd: options.cwd,
    detached: false,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = createCapture();
  const stderr = createCapture();
  let exitCode = null;
  let signal = null;
  let timedOut = false;
  const timeoutMs = options.timeoutMs;
  const killChild = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (child.pid != null) killProcessTree(child.pid);
    else child.kill("SIGKILL");
  };
  const timer = typeof timeoutMs === "number" && timeoutMs > 0 ? setTimeout(() => {
    timedOut = true;
    killChild();
  }, timeoutMs) : null;
  timer?.unref?.();
  child.stdout?.on("data", (chunk) => {
    appendCapture(stdout, chunk);
    process.stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    appendCapture(stderr, chunk);
    process.stderr.write(chunk);
  });
  child.on("exit", (code, childSignal) => {
    exitCode = code;
    signal = childSignal;
  });
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (timer != null) {
    clearTimeout(timer);
  }
  return { exitCode, signal, stdout: finishCapture(stdout), stderr: finishCapture(stderr), timedOut };
}

async function main() {
  const payload = JSON.parse(await readStdin());
  const artifacts = [];
  const writeResult = async (result) => {
    await fs.mkdir(path.dirname(payload.resultPath), { recursive: true });
    const content = JSON.stringify({ attemptId: payload.attemptId, ...result, artifacts });
    if (Buffer.byteLength(content) > RESULT_LIMIT_BYTES) {
      throw new Error("Workflow action result exceeded " + RESULT_LIMIT_BYTES + " bytes");
    }
    await fs.writeFile(payload.resultPath, content, "utf-8");
  };

  try {
    const action = await loadAction(payload);
    const metadata = normalizeMetadata(action.metadata);
    if (payload.mode === "describe") {
      await writeResult({ success: true, metadata, hasReconcile: typeof action.reconcile === "function" });
      return;
    }

    const fn = payload.mode === "reconcile" ? action.reconcile : action.execute;
    if (typeof fn !== "function") {
      throw new Error(
        payload.mode === "reconcile"
          ? "Workflow action does not export a reconcile function"
          : "Workflow action must export an execute function"
      );
    }

    const context = {
      action: {
        name: payload.actionName,
        sourcePath: payload.sourcePath,
        sourceHash: payload.sourceHash,
        effect: metadata.effect,
      },
      cwd: payload.cwd,
      exec: async (command, args, options = {}) => await execCommand(command, args, { cwd: payload.cwd, ...options }),
      writeArtifact: async (name, value) => {
        assertSafeArtifactName(name);
        if (artifacts.length >= MAX_ARTIFACT_COUNT) {
          throw new Error("Workflow action artifact count exceeded " + MAX_ARTIFACT_COUNT);
        }
        const artifactPath = path.join(payload.artifactDir, name);
        await fs.mkdir(path.dirname(artifactPath), { recursive: true });
        const content = typeof value === "string" ? value : JSON.stringify(value, null, 2);
        const sizeBytes = Buffer.byteLength(content);
        if (sizeBytes > MAX_ARTIFACT_BYTES) {
          throw new Error("Workflow action artifact exceeded " + MAX_ARTIFACT_BYTES + " bytes");
        }
        await fs.writeFile(artifactPath, content, "utf-8");
        const artifact = { name, path: artifactPath, sizeBytes };
        artifacts.push(artifact);
        return artifact;
      },
      log: (...args) => console.log(...args),
    };

    const output = await fn(payload.input, context);
    await writeResult({ success: true, metadata, output: output === undefined ? null : output });
  } catch (error) {
    await writeResult({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
`;

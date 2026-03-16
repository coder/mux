import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import type {
  BrowserAction,
  BrowserSession,
  BrowserSessionOwnership,
} from "@/common/types/browserSession";
import { getMuxBrowserSessionId } from "@/common/utils/browserSession";
import {
  AgentBrowserBinaryNotFoundError,
  AgentBrowserUnsupportedPlatformError,
  AgentBrowserVendoredPackageNotFoundError,
  resolveAgentBrowserBinary,
} from "@/node/services/agentBrowserLauncher";
import { DisposableProcess } from "@/node/utils/disposableExec";

const CLI_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;
const VENDORED_BROWSER_RECOVERY_HINT =
  "Reinstall Mux, or run bun install in the repo if you're developing locally.";
const MISSING_BROWSER_BINARY_ERROR =
  "Vendored agent-browser binary disappeared before launch. Reinstall Mux, or run bun install in the repo if you're developing locally.";

function getAgentBrowserLauncherError(error: unknown): string | null {
  if (error instanceof AgentBrowserUnsupportedPlatformError) {
    return `${error.message} ${VENDORED_BROWSER_RECOVERY_HINT}`;
  }

  if (
    error instanceof AgentBrowserBinaryNotFoundError ||
    error instanceof AgentBrowserVendoredPackageNotFoundError
  ) {
    return `${error.message} ${VENDORED_BROWSER_RECOVERY_HINT}`;
  }

  return null;
}

type CliResult = { ok: true; data: unknown } | { ok: false; error: string };

interface SharpTransformer {
  jpeg(options: { quality: number }): { toBuffer(): Promise<Buffer> };
}

type SharpFactory = (input: Buffer) => SharpTransformer;

let sharpFactoryPromise: Promise<SharpFactory | null> | null = null;

function isSharpFactory(value: unknown): value is SharpFactory {
  return typeof value === "function";
}

async function getSharpFactory(): Promise<SharpFactory | null> {
  if (sharpFactoryPromise !== null) {
    return await sharpFactoryPromise;
  }

  sharpFactoryPromise = (async () => {
    try {
      // Keep this native dependency lazy: Bun test environments import this module transitively,
      // but should not crash during evaluation when libstdc++ is unavailable for sharp.
      // eslint-disable-next-line no-restricted-syntax -- sharp is an optional native dependency here.
      const sharpModule: unknown = await import("sharp");
      const sharpCandidate =
        isRecord(sharpModule) && "default" in sharpModule ? sharpModule.default : sharpModule;
      assert(isSharpFactory(sharpCandidate), "sharp default export must be callable");
      return sharpCandidate;
    } catch {
      return null;
    }
  })();

  return await sharpFactoryPromise;
}

export interface BrowserSessionBackendOptions {
  workspaceId: string;
  ownership: BrowserSessionOwnership;
  initialUrl: string;
  onSessionUpdate: (session: BrowserSession) => void;
  onAction: (action: BrowserAction) => void;
  onEnded: (workspaceId: string) => void;
  onError: (workspaceId: string, error: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractCliString(data: unknown, field: string): string | null {
  if (isRecord(data) && typeof data[field] === "string") {
    return data[field];
  }

  if (isRecord(data) && isRecord(data.data) && typeof data.data[field] === "string") {
    return data.data[field];
  }

  return null;
}

type RawCliResult = { ok: true; stdout: string; stderr: string } | { ok: false; error: string };

interface AgentBrowserCliCommandOptions {
  inFlightProcesses?: Set<ChildProcess>;
  spawnFn?: typeof spawn;
  resolveAgentBrowserBinaryFn?: () => string;
}

function isMissingBrowserSessionError(error: string): boolean {
  return /session not found|no session/i.test(error);
}

function formatCliCommandFailure(
  stderr: string,
  code: number | null,
  signal: NodeJS.Signals | null
): string {
  return (
    stderr.trim() ||
    (signal !== null
      ? `CLI command exited via signal ${signal}`
      : `CLI command failed with exit code ${code ?? "unknown"}`)
  );
}

async function runAgentBrowserCliCommand(
  sessionId: string,
  args: string[],
  timeoutMs = CLI_TIMEOUT_MS,
  options?: AgentBrowserCliCommandOptions
): Promise<RawCliResult> {
  assert(sessionId.trim().length > 0, "runAgentBrowserCliCommand requires a non-empty sessionId");
  assert(args.length > 0, "runAgentBrowserCliCommand requires at least one CLI arg");

  // Allow tests to inject the binary resolver so they can avoid Bun's process-wide
  // module mocks, which can leak launcher state into unrelated BrowserSessionBackend tests.
  const resolveAgentBrowserBinaryFn =
    options?.resolveAgentBrowserBinaryFn ?? resolveAgentBrowserBinary;

  let agentBrowserBinary: string;
  try {
    agentBrowserBinary = resolveAgentBrowserBinaryFn();
  } catch (error) {
    const launcherError = getAgentBrowserLauncherError(error);
    if (launcherError !== null) {
      return { ok: false, error: launcherError };
    }
    throw error;
  }

  const spawnFn = options?.spawnFn ?? spawn;
  const childProcess = spawnFn(agentBrowserBinary, ["--json", "--session", sessionId, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const disposableProcess = new DisposableProcess(childProcess);
  options?.inFlightProcesses?.add(childProcess);

  return await new Promise<RawCliResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: RawCliResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);
      options?.inFlightProcesses?.delete(childProcess);
      resolve(result);
    };

    const timeoutId = setTimeout(() => {
      disposableProcess[Symbol.dispose]();
      finish({ ok: false, error: `CLI command timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    childProcess.stdout?.setEncoding("utf8");
    childProcess.stderr?.setEncoding("utf8");
    childProcess.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    childProcess.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    childProcess.on("error", (error) => {
      const spawnError = error as NodeJS.ErrnoException;
      disposableProcess[Symbol.dispose]();
      finish({
        ok: false,
        error: spawnError.code === "ENOENT" ? MISSING_BROWSER_BINARY_ERROR : error.message,
      });
    });

    childProcess.on("close", (code, signal) => {
      if (settled) {
        return;
      }

      if (code !== 0 || signal !== null) {
        finish({ ok: false, error: formatCliCommandFailure(stderr, code, signal) });
        return;
      }

      finish({ ok: true, stdout, stderr });
    });
  });
}

export async function closeAgentBrowserSession(
  sessionId: string,
  timeoutMs = CLI_TIMEOUT_MS,
  options?: AgentBrowserCliCommandOptions
): Promise<{ success: boolean; error?: string }> {
  assert(sessionId.trim().length > 0, "closeAgentBrowserSession requires a non-empty sessionId");

  try {
    const result = await runAgentBrowserCliCommand(sessionId, ["close"], timeoutMs, {
      spawnFn: options?.spawnFn,
      resolveAgentBrowserBinaryFn: options?.resolveAgentBrowserBinaryFn,
    });
    if (!result.ok) {
      if (isMissingBrowserSessionError(result.error)) {
        return { success: true };
      }

      return { success: false, error: result.error };
    }

    const trimmedStdout = result.stdout.trim();
    if (trimmedStdout.length === 0) {
      return { success: true };
    }

    try {
      const parsedOutput: unknown = JSON.parse(trimmedStdout);
      if (isRecord(parsedOutput) && parsedOutput.success === false) {
        return {
          success: false,
          error:
            typeof parsedOutput.error === "string" ? parsedOutput.error : "close reported failure",
        };
      }
    } catch {
      // Treat non-JSON close output as success; close may emit plain text on success.
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export class BrowserSessionBackend {
  private sessionId: string;
  private session: BrowserSession;
  private pollIntervalId: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private pollInFlight = false;
  private consecutivePollFailures = 0;
  private readonly inFlightProcesses = new Set<ChildProcess>();

  constructor(private readonly options: BrowserSessionBackendOptions) {
    assert(
      options.workspaceId.trim().length > 0,
      "BrowserSessionBackend requires a non-empty workspaceId"
    );

    this.sessionId = this.createSessionId();
    this.session = this.createSession("starting");
  }

  getSession(): BrowserSession {
    return { ...this.session };
  }

  async start(): Promise<BrowserSession> {
    assert(!this.disposed, "BrowserSessionBackend.start called after dispose");
    assert(
      this.options.workspaceId.trim().length > 0,
      "BrowserSessionBackend.start requires a non-empty workspaceId"
    );

    this.sessionId = this.createSessionId();
    this.session = this.createSession("starting");
    this.emitSessionUpdate();

    if (!this.hasExistingSession()) {
      const openResult = await this.runCliCommand(["open", this.options.initialUrl]);
      if (!openResult.ok) {
        // If stop/dispose interrupts the CLI command, the session already transitioned
        // to a terminal state elsewhere; keep that state instead of overwriting it.
        if (this.disposed) {
          return this.getSession();
        }
        this.transitionToError(openResult.error);
        return this.getSession();
      }

      if (this.disposed) {
        return this.getSession();
      }
    }

    await this.refreshMetadata();
    if (this.disposed || this.session.status === "error") {
      return this.getSession();
    }

    this.session = {
      ...this.session,
      status: "live",
      updatedAt: new Date().toISOString(),
    };
    this.emitSessionUpdate();
    this.startPolling();

    return this.getSession();
  }

  async stop(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.stopPolling();
    this.disposed = true;
    this.killInFlightProcesses();

    try {
      await this.runCliCommand(["close"]);
    } catch {
      // Best-effort shutdown; the session is ending locally regardless.
    }

    this.session = {
      ...this.session,
      status: "ended",
      updatedAt: new Date().toISOString(),
    };
    this.emitSessionUpdate();
    this.options.onEnded(this.options.workspaceId);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.stopPolling();
    this.disposed = true;
    this.killInFlightProcesses();
  }

  private createSession(status: BrowserSession["status"]): BrowserSession {
    const now = new Date().toISOString();
    const runId = `${this.sessionId}-${randomUUID().slice(0, 8)}`;
    return {
      id: runId,
      workspaceId: this.options.workspaceId,
      status,
      ownership: this.options.ownership,
      currentUrl: null,
      title: null,
      lastScreenshotBase64: null,
      lastError: null,
      startedAt: now,
      updatedAt: now,
    };
  }

  private createSessionId(): string {
    return getMuxBrowserSessionId(this.options.workspaceId);
  }

  private hasExistingSession(): boolean {
    try {
      // Lazy-load to avoid startup crashes when the optional agent-browser package is missing
      // or corrupt. agent-browser also auto-launches blank browsers for metadata commands,
      // so checking the daemon PID is the least destructive way to detect attachable sessions.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { isDaemonRunning: isDaemonRunningFn } = require("agent-browser/dist/daemon.js") as {
        isDaemonRunning: (sessionId: string) => boolean;
      };
      return isDaemonRunningFn(this.sessionId);
    } catch {
      return false;
    }
  }

  private emitSessionUpdate(): void {
    this.options.onSessionUpdate({ ...this.session });
  }

  private emitNavigateAction(nextUrl: string | null, nextTitle: string | null): void {
    const previousUrl = this.session.currentUrl;
    const previousTitle = this.session.title;
    if (previousUrl === nextUrl && previousTitle === nextTitle) {
      return;
    }

    const action: BrowserAction = {
      id: `browser-action-${randomUUID().slice(0, 8)}`,
      type: "navigate",
      description: nextTitle ?? nextUrl ?? "Browser page changed",
      timestamp: new Date().toISOString(),
      metadata: {
        previousUrl,
        currentUrl: nextUrl,
        previousTitle,
        title: nextTitle,
      },
    };
    this.options.onAction(action);
  }

  private startPolling(): void {
    if (this.disposed || this.pollIntervalId !== null) {
      return;
    }

    this.pollIntervalId = setInterval(() => {
      this.refreshMetadata().catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.handlePollFailure(errorMessage);
      });
    }, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollIntervalId !== null) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }
  }

  private async refreshMetadata(): Promise<void> {
    if (this.disposed || this.pollInFlight) {
      return;
    }

    this.pollInFlight = true;
    try {
      const urlResult = await this.runCliCommand(["get", "url"]);
      if (!urlResult.ok) {
        this.handlePollFailure(urlResult.error);
        return;
      }

      const titleResult = await this.runCliCommand(["get", "title"]);
      if (!titleResult.ok) {
        this.handlePollFailure(titleResult.error);
        return;
      }

      const nextUrl = extractCliString(urlResult.data, "url");
      const nextTitle = extractCliString(titleResult.data, "title");
      if (nextUrl === null) {
        this.handlePollFailure("Unexpected CLI output");
        return;
      }

      // Detect external browser closure: the daemon falls back to about:blank after the
      // controlled window disappears, so only treat it as valid when we were already blank.
      const previousUrl = this.session.currentUrl;
      if (previousUrl !== null && previousUrl !== "about:blank" && nextUrl === "about:blank") {
        this.transitionToError("Browser session was closed externally");
        return;
      }

      let nextScreenshotBase64 = this.session.lastScreenshotBase64;
      let lastError: string | null = null;

      const screenshotResult = await this.runCliCommand(["screenshot"]);
      if (!screenshotResult.ok) {
        lastError = screenshotResult.error;
      } else {
        const screenshotPath = extractCliString(screenshotResult.data, "path");
        if (screenshotPath === null) {
          lastError = "Unexpected CLI output";
        } else {
          try {
            nextScreenshotBase64 = await this.convertScreenshot(screenshotPath);
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
          }
        }
      }

      this.consecutivePollFailures = 0;
      this.emitNavigateAction(nextUrl, nextTitle);
      this.session = {
        ...this.session,
        currentUrl: nextUrl,
        title: nextTitle,
        lastScreenshotBase64: nextScreenshotBase64,
        lastError,
        updatedAt: new Date().toISOString(),
      };
      this.emitSessionUpdate();
    } finally {
      this.pollInFlight = false;
    }
  }

  private handlePollFailure(error: string): void {
    this.consecutivePollFailures += 1;
    this.session = {
      ...this.session,
      lastError: error,
      updatedAt: new Date().toISOString(),
    };

    if (this.consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
      this.transitionToError(error);
      return;
    }

    this.emitSessionUpdate();
  }

  private transitionToError(error: string): void {
    this.stopPolling();
    this.session = {
      ...this.session,
      status: "error",
      lastError: error,
      updatedAt: new Date().toISOString(),
    };
    this.emitSessionUpdate();
    this.options.onError(this.options.workspaceId, error);
  }

  private killInFlightProcesses(): void {
    for (const childProcess of this.inFlightProcesses) {
      const disposable = new DisposableProcess(childProcess);
      disposable[Symbol.dispose]();
    }
    this.inFlightProcesses.clear();
  }

  private async runCliCommand(args: string[], timeoutMs = CLI_TIMEOUT_MS): Promise<CliResult> {
    const result = await runAgentBrowserCliCommand(this.sessionId, args, timeoutMs, {
      inFlightProcesses: this.inFlightProcesses,
    });
    if (!result.ok) {
      return result;
    }

    const trimmedStdout = result.stdout.trim();
    if (trimmedStdout.length === 0) {
      return { ok: false, error: "Unexpected CLI output" };
    }

    let parsedOutput: unknown;
    try {
      parsedOutput = JSON.parse(trimmedStdout);
    } catch {
      return { ok: false, error: "Unexpected CLI output" };
    }

    if (isRecord(parsedOutput) && parsedOutput.success === false) {
      const cliError =
        typeof parsedOutput.error === "string" ? parsedOutput.error : "Unexpected CLI output";
      return { ok: false, error: cliError };
    }

    return { ok: true, data: parsedOutput };
  }

  private async convertScreenshot(pngPath: string): Promise<string> {
    assert(pngPath.trim().length > 0, "convertScreenshot requires a non-empty pngPath");

    try {
      const pngBuffer = await fs.readFile(pngPath);
      const sharpFactory = await getSharpFactory();
      if (sharpFactory === null) {
        // Best-effort fallback when the optional native converter is unavailable.
        return pngBuffer.toString("base64");
      }

      const imageBuffer = await sharpFactory(pngBuffer).jpeg({ quality: 70 }).toBuffer();
      return imageBuffer.toString("base64");
    } finally {
      await fs.unlink(pngPath).catch(() => undefined);
    }
  }
}

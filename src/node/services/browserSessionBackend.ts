import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import WebSocket, { type RawData } from "ws";
import type {
  BrowserAction,
  BrowserFrameMetadata,
  BrowserInputEvent,
  BrowserSession,
  BrowserStreamState,
} from "@/common/types/browserSession";
import { getMuxBrowserSessionId } from "@/common/utils/browserSession";
import { normalizeBrowserUrl } from "@/common/utils/browserUrl";
import {
  AgentBrowserBinaryNotFoundError,
  AgentBrowserUnsupportedPlatformError,
  AgentBrowserVendoredPackageNotFoundError,
  resolveAgentBrowserBinary,
} from "@/node/services/agentBrowserLauncher";
import { log } from "@/node/services/log";
import { DisposableProcess } from "@/node/utils/disposableExec";

const CLI_TIMEOUT_MS = 30_000;
const FALLBACK_POLL_INTERVAL_MS = 2_000;
const METADATA_REFRESH_INTERVAL_MS = 5_000;
const MAX_CONSECUTIVE_METADATA_FAILURES = 3;
const MAX_STREAM_RETRY_COUNT = 3;
const STREAM_RETRY_BASE_DELAY_MS = 500;
const VENDORED_BROWSER_RECOVERY_HINT =
  "Reinstall Mux, or run bun install in the repo if you're developing locally.";
const MISSING_BROWSER_BINARY_ERROR =
  "Vendored agent-browser binary disappeared before launch. Reinstall Mux, or run bun install in the repo if you're developing locally.";
const DEFAULT_STREAM_ERROR_MESSAGE = "Browser preview stream was unavailable.";

type StreamStartupMode = "stream" | "fallback" | "restart_required";

type CliResult = { ok: true; data: unknown } | { ok: false; error: string };

type StreamConnectResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
    };

interface SharpTransformer {
  jpeg(options: { quality: number }): { toBuffer(): Promise<Buffer> };
}

type SharpFactory = (input: Buffer) => SharpTransformer;

let sharpFactoryPromise: Promise<SharpFactory | null> | null = null;

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
  initialUrl: string;
  streamPort?: number | null;
  onSessionUpdate: (session: BrowserSession) => void;
  onAction: (action: BrowserAction) => void;
  onEnded: (workspaceId: string) => void;
  onError: (workspaceId: string, error: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getStreamRetryDelayMs(attemptNumber: number): number {
  assert(attemptNumber > 0, "getStreamRetryDelayMs requires a positive attempt number");
  return STREAM_RETRY_BASE_DELAY_MS * 2 ** (attemptNumber - 1);
}

function normalizeWebSocketMessage(data: RawData): string {
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  return Buffer.from(data).toString("utf8");
}

function getStreamCloseReason(
  code: number,
  rawReason: Buffer,
  fallbackReason: string | null
): string {
  const closeReason = rawReason.toString("utf8").trim();
  if (closeReason.length > 0) {
    return closeReason;
  }

  if (fallbackReason !== null && fallbackReason.trim().length > 0) {
    return fallbackReason;
  }

  if (code !== 1005) {
    return `Browser preview socket closed (${code})`;
  }

  return DEFAULT_STREAM_ERROR_MESSAGE;
}

function parseFrameMetadata(metadata: unknown): BrowserFrameMetadata | null {
  if (!isRecord(metadata)) {
    return null;
  }

  const deviceWidth = metadata.deviceWidth;
  const deviceHeight = metadata.deviceHeight;
  const pageScaleFactor = metadata.pageScaleFactor;
  const offsetTop = metadata.offsetTop;
  const scrollOffsetX = metadata.scrollOffsetX;
  const scrollOffsetY = metadata.scrollOffsetY;

  if (
    !isFiniteNumber(deviceWidth) ||
    !isFiniteNumber(deviceHeight) ||
    !isFiniteNumber(pageScaleFactor) ||
    !isFiniteNumber(offsetTop) ||
    !isFiniteNumber(scrollOffsetX) ||
    !isFiniteNumber(scrollOffsetY)
  ) {
    return null;
  }

  if (deviceWidth <= 0 || deviceHeight <= 0) {
    return null;
  }

  if (pageScaleFactor <= 0) {
    return null;
  }

  return {
    deviceWidth,
    deviceHeight,
    pageScaleFactor,
    offsetTop,
    scrollOffsetX,
    scrollOffsetY,
  };
}

function extractStreamStatus(payload: Record<string, unknown>): BrowserStreamState | null {
  if (typeof payload.status === "string") {
    switch (payload.status) {
      case "connected":
        return "connecting";
      case "screencasting":
        return "live";
      default:
        return null;
    }
  }

  if (payload.connected === true && payload.screencasting === true) {
    return "live";
  }

  if (payload.connected === true) {
    return "connecting";
  }

  return null;
}

function extractStreamError(payload: Record<string, unknown>): string | null {
  if (typeof payload.error === "string" && payload.error.trim().length > 0) {
    return payload.error;
  }

  if (typeof payload.message === "string" && payload.message.trim().length > 0) {
    return payload.message;
  }

  return null;
}

type RawCliResult = { ok: true; stdout: string; stderr: string } | { ok: false; error: string };

interface AgentBrowserCliCommandOptions {
  inFlightProcesses?: Set<ChildProcess>;
  spawnFn?: typeof spawn;
  resolveAgentBrowserBinaryFn?: () => string;
  env?: NodeJS.ProcessEnv;
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
    ...(options?.env != null ? { env: options.env } : {}),
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
      env: options?.env,
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
  private readonly streamPort: number | null;
  private sessionId: string;
  private session: BrowserSession;
  private fallbackPollIntervalId: ReturnType<typeof setInterval> | null = null;
  private metadataRefreshIntervalId: ReturnType<typeof setInterval> | null = null;
  private streamRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private streamSocket: WebSocket | null = null;
  private intentionalStreamCloseSocket: WebSocket | null = null;
  private pendingStreamCloseReason: string | null = null;
  private disposed = false;
  private metadataRefreshInFlight = false;
  private fallbackScreenshotInFlight = false;
  private consecutiveMetadataFailures = 0;
  private streamRetryCount = 0;
  private startedFromExistingSession = false;
  private readonly inFlightProcesses = new Set<ChildProcess>();

  constructor(private readonly options: BrowserSessionBackendOptions) {
    assert(
      options.workspaceId.trim().length > 0,
      "BrowserSessionBackend requires a non-empty workspaceId"
    );
    if (options.streamPort != null) {
      assert(
        Number.isFinite(options.streamPort) && options.streamPort > 0,
        "BrowserSessionBackend requires streamPort to be a positive finite number"
      );
    }

    this.streamPort = options.streamPort ?? null;
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

    this.resetRuntimeState();
    this.sessionId = this.createSessionId();
    this.session = this.createSession("starting");
    this.startedFromExistingSession = this.hasExistingSession();
    this.emitSessionUpdate();

    if (!this.startedFromExistingSession) {
      const openResult = await this.runCliCommand(["open", this.options.initialUrl]);
      if (!openResult.ok) {
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

    await this.refreshNavigationMetadata();
    if (this.disposed || this.session.status === "error") {
      return this.getSession();
    }

    const streamStartupMode = await this.startStreamTransport();
    if (this.disposed || this.getSession().status === "error") {
      return this.getSession();
    }

    if (streamStartupMode === "fallback") {
      await this.refreshFallbackScreenshot();
    }

    this.patchSession({ status: "live" });
    this.startMetadataRefreshLoop();
    if (streamStartupMode === "fallback") {
      this.startFallbackPolling();
    }

    return this.getSession();
  }

  async stop(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.stopBackgroundWork();
    this.disposed = true;
    this.killInFlightProcesses();

    try {
      await this.runCliCommand(["close"]);
    } catch {
      // Best-effort shutdown; the session is ending locally regardless.
    }

    this.patchSession({
      status: "ended",
      streamState: null,
      lastFrameMetadata: null,
      streamErrorMessage: null,
    });
    this.options.onEnded(this.options.workspaceId);
  }

  sendInput(input: BrowserInputEvent): { success: boolean; error?: string } {
    if (this.session.status !== "live") {
      return { success: false, error: "Session is not live" };
    }

    if (this.session.streamState !== "live") {
      return {
        success: false,
        error: `Stream is not live (state: ${String(this.session.streamState)})`,
      };
    }

    if (this.streamSocket == null || this.streamSocket.readyState !== WebSocket.OPEN) {
      return { success: false, error: "Stream socket is not connected" };
    }

    if (this.session.lastFrameMetadata == null) {
      return { success: false, error: "No frame metadata available" };
    }

    try {
      this.streamSocket.send(JSON.stringify(this.mapInputToProtocol(input)));
    } catch (error) {
      return { success: false, error: `Failed to send input: ${getErrorMessage(error)}` };
    }
    return { success: true };
  }

  async navigate(rawUrl: string): Promise<{ success: boolean; error?: string }> {
    assert(rawUrl.trim().length > 0, "BrowserSessionBackend.navigate requires a non-empty url");

    // Navigation is a dedicated RPC instead of a BrowserInputEvent because it must
    // work in fallback mode (no live stream socket) and keeps navigation semantics
    // cleanly separate from pointer/keyboard/touch input.
    const result = normalizeBrowserUrl(rawUrl);
    if (!result.ok) {
      return { success: false, error: result.error };
    }

    if (this.session.status !== "live") {
      return { success: false, error: "Session is not live" };
    }

    const cliResult = await this.runCliCommand(["open", result.normalizedUrl]);
    if (!cliResult.ok) {
      return { success: false, error: cliResult.error };
    }

    await this.refreshNavigationMetadata();

    return { success: true };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.stopBackgroundWork();
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
      currentUrl: null,
      title: null,
      lastScreenshotBase64: null,
      lastError: null,
      streamState: null,
      lastFrameMetadata: null,
      streamErrorMessage: null,
      startedAt: now,
      updatedAt: now,
    };
  }

  private createSessionId(): string {
    return getMuxBrowserSessionId(this.options.workspaceId);
  }

  private resetRuntimeState(): void {
    this.stopBackgroundWork();
    this.consecutiveMetadataFailures = 0;
    this.streamRetryCount = 0;
    this.pendingStreamCloseReason = null;
    this.startedFromExistingSession = false;
    this.metadataRefreshInFlight = false;
    this.fallbackScreenshotInFlight = false;
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

  private patchSession(patch: Partial<BrowserSession>): void {
    this.session = {
      ...this.session,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.emitSessionUpdate();
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

  // The browser viewport sends DOM-relative coordinates after mapping against the latest stream
  // metadata. Clamp again here before forwarding to agent-browser so transient layout races or
  // stale frames never push pointer events outside the daemon's current device bounds.
  private mapInputToProtocol(input: BrowserInputEvent): Record<string, unknown> {
    switch (input.kind) {
      case "mouse": {
        const metadata = this.session.lastFrameMetadata;
        assert(
          metadata !== null,
          "BrowserSessionBackend requires frame metadata to map mouse input"
        );
        const x = Math.max(0, Math.min(input.x, metadata.deviceWidth));
        const y = Math.max(0, Math.min(input.y, metadata.deviceHeight));
        return {
          type: "input_mouse",
          eventType: input.eventType,
          x,
          y,
          ...(input.button != null ? { button: input.button } : {}),
          ...(input.clickCount != null ? { clickCount: input.clickCount } : {}),
          ...(input.deltaX != null ? { deltaX: input.deltaX } : {}),
          ...(input.deltaY != null ? { deltaY: input.deltaY } : {}),
          ...(input.modifiers != null ? { modifiers: input.modifiers } : {}),
        };
      }
      case "keyboard":
        return {
          type: "input_keyboard",
          eventType: input.eventType,
          ...(input.key != null ? { key: input.key } : {}),
          ...(input.code != null ? { code: input.code } : {}),
          ...(input.text != null ? { text: input.text } : {}),
          ...(input.modifiers != null ? { modifiers: input.modifiers } : {}),
        };
      case "touch":
        return {
          type: "input_touch",
          eventType: input.eventType,
          touchPoints: input.touchPoints,
          ...(input.modifiers != null ? { modifiers: input.modifiers } : {}),
        };
    }
  }

  private async startStreamTransport(): Promise<StreamStartupMode> {
    if (this.streamPort === null) {
      this.transitionToStreamFallback("Streaming unavailable; falling back to CLI polling.");
      return "fallback";
    }

    this.patchSession({ streamState: "connecting", streamErrorMessage: null });
    let lastError = DEFAULT_STREAM_ERROR_MESSAGE;

    for (let attempt = 1; attempt <= MAX_STREAM_RETRY_COUNT; attempt += 1) {
      const connectResult = await this.connectStreamTransport();
      if (connectResult.ok) {
        this.streamRetryCount = 0;
        return "stream";
      }

      lastError = connectResult.error;
      if (this.disposed) {
        return this.startedFromExistingSession ? "restart_required" : "fallback";
      }

      this.patchSession({ streamState: "connecting", streamErrorMessage: lastError });
      if (attempt < MAX_STREAM_RETRY_COUNT) {
        await this.sleep(getStreamRetryDelayMs(attempt));
      }
    }

    // Stream transport path A: the daemon was launched with AGENT_BROWSER_STREAM_PORT but
    // the WebSocket never connected (port conflict, daemon too old, etc.). New sessions can
    // fall back to screenshot polling, but attached sessions must require a restart because
    // we cannot prove the already-running daemon supports the streaming protocol.
    if (this.startedFromExistingSession) {
      this.transitionToRestartRequired(lastError);
      return "restart_required";
    }

    this.transitionToStreamFallback(lastError);
    return "fallback";
  }

  private async connectStreamTransport(): Promise<StreamConnectResult> {
    assert(this.streamPort !== null, "connectStreamTransport requires a reserved streamPort");
    if (this.disposed) {
      return { ok: false, error: "Browser session backend was disposed before stream connect." };
    }

    const socketUrl = `ws://127.0.0.1:${this.streamPort}`;
    return await new Promise<StreamConnectResult>((resolve) => {
      let opened = false;
      let settled = false;
      const socket = new WebSocket(socketUrl);

      const settle = (result: StreamConnectResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };

      const failBeforeOpen = (error: string): void => {
        const failureMessage = error.trim().length > 0 ? error : DEFAULT_STREAM_ERROR_MESSAGE;
        this.closeSocket(socket, true);
        settle({ ok: false, error: failureMessage });
      };

      socket.on("open", () => {
        if (this.disposed) {
          failBeforeOpen("Browser session backend was disposed before stream connect completed.");
          return;
        }

        opened = true;
        this.streamSocket = socket;
        this.pendingStreamCloseReason = null;
        this.patchSession({ streamState: "connecting", streamErrorMessage: null });
        settle({ ok: true });
      });

      socket.on("message", (data) => {
        if (this.disposed || this.streamSocket !== socket) {
          return;
        }

        this.handleStreamSocketMessage(data);
      });

      socket.on("error", (error) => {
        const message = getErrorMessage(error);
        if (!opened) {
          failBeforeOpen(message);
          return;
        }

        this.pendingStreamCloseReason = message;
        log.debug("BrowserSessionBackend stream socket error", {
          workspaceId: this.options.workspaceId,
          error: message,
        });
      });

      socket.on("close", (code, rawReason) => {
        const closeReason = getStreamCloseReason(code, rawReason, this.pendingStreamCloseReason);
        this.pendingStreamCloseReason = null;

        if (!opened) {
          failBeforeOpen(closeReason);
          return;
        }

        if (this.intentionalStreamCloseSocket === socket) {
          this.intentionalStreamCloseSocket = null;
          return;
        }

        if (this.streamSocket === socket) {
          this.streamSocket = null;
        }

        if (this.disposed) {
          return;
        }

        this.handleUnexpectedStreamClose(closeReason);
      });
    });
  }

  private handleUnexpectedStreamClose(error: string): void {
    if (this.disposed || this.session.status === "error") {
      return;
    }

    if (this.streamRetryTimer !== null) {
      return;
    }

    if (this.streamRetryCount >= MAX_STREAM_RETRY_COUNT) {
      this.degradeAfterStreamFailure(error);
      return;
    }

    const nextRetryCount = this.streamRetryCount + 1;
    assert(
      nextRetryCount <= MAX_STREAM_RETRY_COUNT,
      "BrowserSessionBackend streamRetryCount exceeded the configured maximum"
    );

    this.streamRetryCount = nextRetryCount;
    this.patchSession({ streamState: "connecting", streamErrorMessage: error });
    const retryDelayMs = getStreamRetryDelayMs(nextRetryCount);

    this.streamRetryTimer = setTimeout(() => {
      this.streamRetryTimer = null;
      void this.retryStreamConnection();
    }, retryDelayMs);
    this.streamRetryTimer.unref?.();
  }

  private async retryStreamConnection(): Promise<void> {
    if (this.disposed || this.session.status === "error") {
      return;
    }

    const result = await this.connectStreamTransport();
    if (result.ok) {
      this.streamRetryCount = 0;
      return;
    }

    this.handleUnexpectedStreamClose(result.error);
  }

  // Stream transport path B: streaming worked at least once, then the live socket died later.
  // New sessions degrade to screenshot polling so preview keeps updating, but attached sessions
  // are marked restart_required because we cannot safely relaunch a daemon we did not create.
  private degradeAfterStreamFailure(error: string): void {
    if (this.startedFromExistingSession) {
      this.transitionToRestartRequired(error);
      return;
    }

    this.transitionToStreamFallback(error);
    this.startFallbackPolling();
    void this.refreshFallbackScreenshot();
  }

  private transitionToStreamFallback(error: string): void {
    this.clearStreamRetryTimer();
    this.closeCurrentStreamSocket();
    this.patchSession({
      streamState: "fallback",
      streamErrorMessage: error,
      lastError: error,
    });
  }

  // restart_required is intentionally stricter than fallback: the user still has a browser window,
  // but interactive streaming is blocked until we relaunch a daemon we know was started with stream support.
  private transitionToRestartRequired(error: string): void {
    this.clearStreamRetryTimer();
    this.closeCurrentStreamSocket();
    this.stopFallbackPolling();
    this.patchSession({
      streamState: "restart_required",
      streamErrorMessage: error,
      lastError: error,
    });
  }

  private startMetadataRefreshLoop(): void {
    if (this.disposed || this.metadataRefreshIntervalId !== null) {
      return;
    }

    this.metadataRefreshIntervalId = setInterval(() => {
      void this.refreshNavigationMetadata().catch((error: unknown) => {
        this.handleMetadataFailure(getErrorMessage(error));
      });
    }, METADATA_REFRESH_INTERVAL_MS);
  }

  private stopMetadataRefreshLoop(): void {
    if (this.metadataRefreshIntervalId !== null) {
      clearInterval(this.metadataRefreshIntervalId);
      this.metadataRefreshIntervalId = null;
    }
  }

  private startFallbackPolling(): void {
    if (
      this.disposed ||
      this.fallbackPollIntervalId !== null ||
      this.session.streamState !== "fallback"
    ) {
      return;
    }

    this.fallbackPollIntervalId = setInterval(() => {
      void this.refreshFallbackScreenshot().catch((error: unknown) => {
        const errorMessage = getErrorMessage(error);
        this.patchSession({ lastError: errorMessage });
      });
    }, FALLBACK_POLL_INTERVAL_MS);
  }

  private stopFallbackPolling(): void {
    if (this.fallbackPollIntervalId !== null) {
      clearInterval(this.fallbackPollIntervalId);
      this.fallbackPollIntervalId = null;
    }
  }

  private async refreshNavigationMetadata(): Promise<void> {
    if (this.disposed || this.metadataRefreshInFlight) {
      return;
    }

    this.metadataRefreshInFlight = true;
    try {
      const urlResult = await this.runCliCommand(["get", "url"]);
      if (!urlResult.ok) {
        this.handleMetadataFailure(urlResult.error);
        return;
      }

      const titleResult = await this.runCliCommand(["get", "title"]);
      if (!titleResult.ok) {
        this.handleMetadataFailure(titleResult.error);
        return;
      }

      const nextUrl = extractCliString(urlResult.data, "url");
      const nextTitle = extractCliString(titleResult.data, "title");
      if (nextUrl === null) {
        this.handleMetadataFailure("Unexpected CLI output");
        return;
      }

      // Detect external browser closure: the daemon falls back to about:blank after the
      // controlled window disappears, so only treat it as valid when we were already blank.
      const previousUrl = this.session.currentUrl;
      if (previousUrl !== null && previousUrl !== "about:blank" && nextUrl === "about:blank") {
        this.transitionToError("Browser session was closed externally");
        return;
      }

      this.consecutiveMetadataFailures = 0;
      this.emitNavigateAction(nextUrl, nextTitle);
      this.patchSession({
        currentUrl: nextUrl,
        title: nextTitle,
      });
    } finally {
      this.metadataRefreshInFlight = false;
    }
  }

  private async refreshFallbackScreenshot(): Promise<void> {
    if (
      this.disposed ||
      this.session.streamState !== "fallback" ||
      this.fallbackScreenshotInFlight
    ) {
      return;
    }

    this.fallbackScreenshotInFlight = true;
    try {
      const screenshotResult = await this.runCliCommand(["screenshot"]);
      if (!screenshotResult.ok) {
        this.patchSession({ lastError: screenshotResult.error });
        return;
      }

      const screenshotPath = extractCliString(screenshotResult.data, "path");
      if (screenshotPath === null) {
        this.patchSession({ lastError: "Unexpected CLI output" });
        return;
      }

      try {
        const nextScreenshotBase64 = await this.convertScreenshot(screenshotPath);
        this.patchSession({
          lastScreenshotBase64: nextScreenshotBase64,
          lastError: null,
        });
      } catch (error) {
        this.patchSession({ lastError: getErrorMessage(error) });
      }
    } finally {
      this.fallbackScreenshotInFlight = false;
    }
  }

  private handleMetadataFailure(error: string): void {
    if (this.disposed) {
      return;
    }

    this.consecutiveMetadataFailures += 1;
    this.patchSession({ lastError: error });

    if (this.consecutiveMetadataFailures >= MAX_CONSECUTIVE_METADATA_FAILURES) {
      this.transitionToError(error);
    }
  }

  private handleStreamSocketMessage(data: RawData): void {
    if (this.disposed) {
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(normalizeWebSocketMessage(data));
    } catch (error) {
      log.debug("BrowserSessionBackend ignored malformed stream payload", {
        workspaceId: this.options.workspaceId,
        error: getErrorMessage(error),
      });
      return;
    }

    if (!isRecord(payload) || typeof payload.type !== "string") {
      log.debug("BrowserSessionBackend ignored unsupported stream payload", {
        workspaceId: this.options.workspaceId,
        payload,
      });
      return;
    }

    switch (payload.type) {
      case "frame":
        this.handleFramePayload(payload);
        return;
      case "status":
        this.handleStatusPayload(payload);
        return;
      case "error":
        this.handleErrorPayload(payload);
        return;
      default:
        log.debug("BrowserSessionBackend ignored unknown stream payload type", {
          workspaceId: this.options.workspaceId,
          type: payload.type,
        });
    }
  }

  // The agent-browser stream protocol delivers JPEG frames as base64 in payload.data plus
  // viewport metadata (deviceWidth/deviceHeight/pageScaleFactor/etc.). The frontend reuses that
  // metadata when mapping human input back into browser-space coordinates for interactive control.
  private handleFramePayload(payload: Record<string, unknown>): void {
    const base64Data =
      typeof payload.data === "string" && payload.data.trim().length > 0 ? payload.data : null;
    const metadata = parseFrameMetadata(payload.metadata);
    if (base64Data === null || metadata === null) {
      log.debug("BrowserSessionBackend ignored invalid frame payload", {
        workspaceId: this.options.workspaceId,
        hasData: base64Data !== null,
        metadata: payload.metadata,
      });
      return;
    }

    this.streamRetryCount = 0;
    this.patchSession({
      lastScreenshotBase64: base64Data,
      lastFrameMetadata: metadata,
      lastError: null,
      streamState: "live",
      streamErrorMessage: null,
    });
  }

  private handleStatusPayload(payload: Record<string, unknown>): void {
    const nextState = extractStreamStatus(payload);
    if (nextState === null) {
      log.debug("BrowserSessionBackend ignored unsupported stream status payload", {
        workspaceId: this.options.workspaceId,
        payload,
      });
      return;
    }

    this.patchSession({
      streamState: nextState,
      streamErrorMessage: nextState === "live" ? null : this.session.streamErrorMessage,
      lastError: nextState === "live" ? null : this.session.lastError,
    });
  }

  private handleErrorPayload(payload: Record<string, unknown>): void {
    const errorMessage = extractStreamError(payload);
    if (errorMessage === null) {
      log.debug("BrowserSessionBackend ignored stream error payload without a message", {
        workspaceId: this.options.workspaceId,
        payload,
      });
      return;
    }

    this.patchSession({
      streamErrorMessage: errorMessage,
      lastError: errorMessage,
    });
    this.closeCurrentStreamSocket();
    this.handleUnexpectedStreamClose(errorMessage);
  }

  private transitionToError(error: string): void {
    if (this.session.status === "error" || this.disposed) {
      return;
    }

    this.stopBackgroundWork();
    const nextStreamState: BrowserStreamState | null =
      this.session.streamState !== null ? "error" : this.session.streamState;
    this.session = {
      ...this.session,
      status: "error",
      lastError: error,
      streamState: nextStreamState,
      streamErrorMessage: nextStreamState !== null ? error : this.session.streamErrorMessage,
      updatedAt: new Date().toISOString(),
    };
    this.emitSessionUpdate();
    this.options.onError(this.options.workspaceId, error);
  }

  private stopBackgroundWork(): void {
    this.stopMetadataRefreshLoop();
    this.stopFallbackPolling();
    this.clearStreamRetryTimer();
    this.closeCurrentStreamSocket();
  }

  private clearStreamRetryTimer(): void {
    if (this.streamRetryTimer !== null) {
      clearTimeout(this.streamRetryTimer);
      this.streamRetryTimer = null;
    }
  }

  private closeCurrentStreamSocket(): void {
    if (this.streamSocket === null) {
      return;
    }

    const currentSocket = this.streamSocket;
    this.streamSocket = null;
    this.closeSocket(currentSocket, false);
  }

  private closeSocket(socket: WebSocket, terminate: boolean): void {
    this.intentionalStreamCloseSocket = socket;
    try {
      if (terminate) {
        socket.terminate();
        return;
      }

      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
        return;
      }

      if (socket.readyState !== WebSocket.CLOSED) {
        socket.terminate();
      }
    } catch (error) {
      log.debug("BrowserSessionBackend failed to close stream socket", {
        workspaceId: this.options.workspaceId,
        error: getErrorMessage(error),
      });
    }
  }

  private killInFlightProcesses(): void {
    for (const childProcess of this.inFlightProcesses) {
      const disposable = new DisposableProcess(childProcess);
      disposable[Symbol.dispose]();
    }
    this.inFlightProcesses.clear();
  }

  private async sleep(delayMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      timer.unref?.();
    });
  }

  private async runCliCommand(args: string[], timeoutMs = CLI_TIMEOUT_MS): Promise<CliResult> {
    const env =
      args[0] === "open" && this.streamPort !== null
        ? {
            ...process.env,
            AGENT_BROWSER_STREAM_PORT: String(this.streamPort),
          }
        : undefined;

    const result = await runAgentBrowserCliCommand(this.sessionId, args, timeoutMs, {
      inFlightProcesses: this.inFlightProcesses,
      env,
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

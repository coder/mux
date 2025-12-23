import { Command } from "commander";
import * as path from "path";
import * as fs from "fs/promises";
import * as crypto from "crypto";
import { Readable, Writable } from "stream";
import { WebSocket } from "ws";

import {
  AgentSideConnection,
  ndJsonStream,
  type Agent,
  type AgentCapabilities,
  type AuthenticateRequest,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type StopReason,
  type CancelNotification,
  type SessionNotification,
} from "@agentclientprotocol/sdk";

import { RPCLink as HTTPRPCLink } from "@orpc/client/fetch";
import { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";
import { createORPCClient } from "@orpc/client";
import type { RouterClient } from "@orpc/server";

import type { AppRouter } from "@/node/orpc/router";
import { discoverServer } from "./discoverServer";
import { getMuxSrcDir } from "@/common/constants/paths";
import type { RuntimeConfig } from "@/common/types/runtime";
import assert from "@/common/utils/assert";
import {
  isCaughtUpMessage,
  isStreamAbort,
  isStreamDelta,
  isStreamEnd,
  isStreamError,
  type WorkspaceChatMessage,
} from "@/common/orpc/types";
import { contentBlocksToText, muxChatMessageToSessionUpdate } from "./acpUtils";
import { getErrorMessage } from "@/common/utils/errors";
import { getParseOptions } from "./argv";
import { VERSION } from "@/version";

type RuntimeFlag = "local" | "worktree" | "ssh";
type LogLevel = "error" | "warn" | "info" | "debug";

interface CliOptions {
  serverUrl?: string;
  serverToken?: string;
  project?: string;
  workspace?: string;
  runtime: RuntimeFlag;
  trunkBranch?: string;
  srcBaseDir?: string;
  sshRuntimeHost?: string;
  sshRuntimePort?: string;
  sshIdentityFile?: string;
  logLevel: LogLevel;
}

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function stderrLog(level: LogLevel, current: LogLevel, ...args: unknown[]): void {
  if (LOG_LEVEL_ORDER[level] > LOG_LEVEL_ORDER[current]) {
    return;
  }

  const prefix = `[mux acp] ${level}:`;
  // Always write to stderr to avoid contaminating ACP stdout.
  console.error(prefix, ...args);
}

function joinUrlPath(baseUrl: string, suffix: string): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  const addPath = suffix.startsWith("/") ? suffix : `/${suffix}`;
  url.pathname = `${basePath}${addPath}`;
  return url.toString();
}

function toWebSocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") {
    return "error";
  }

  if (
    normalized === "error" ||
    normalized === "warn" ||
    normalized === "info" ||
    normalized === "debug"
  ) {
    return normalized;
  }

  throw new Error(
    `Invalid --log-level: ${value ?? "undefined"}. Expected: error, warn, info, debug`
  );
}

function parseRuntimeFlag(value: string | undefined): RuntimeFlag {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return "local";
  }

  if (normalized === "local" || normalized === "worktree" || normalized === "ssh") {
    return normalized;
  }

  throw new Error(`Invalid --runtime: ${value ?? "undefined"}. Expected: local, worktree, ssh`);
}

function generateWorkspaceName(): string {
  return `acp-${crypto.randomBytes(4).toString("hex")}`;
}

function toStopReason(value: StopReason): StopReason {
  return value;
}

function normalizeToken(token: string | undefined): string | undefined {
  const trimmed = token?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

function isErrorEvent(
  msg: WorkspaceChatMessage
): msg is Extract<WorkspaceChatMessage, { type: "error" }> {
  return (msg as { type?: string }).type === "error";
}

class MuxOrpcClient {
  readonly http: RouterClient<AppRouter>;
  readonly ws: RouterClient<AppRouter>;
  private readonly websocket: WebSocket;

  private constructor(opts: {
    http: RouterClient<AppRouter>;
    ws: RouterClient<AppRouter>;
    websocket: WebSocket;
  }) {
    this.http = opts.http;
    this.ws = opts.ws;
    this.websocket = opts.websocket;
  }

  static async connect(opts: {
    baseUrl: string;
    authToken: string | undefined;
  }): Promise<MuxOrpcClient> {
    const baseUrl = opts.baseUrl.replace(/\/+$/, "");

    const headers = opts.authToken ? { Authorization: `Bearer ${opts.authToken}` } : undefined;

    const httpLink = new HTTPRPCLink({
      url: joinUrlPath(baseUrl, "/orpc"),
      headers,
    });

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- needed for tsgo typecheck
    const http = createORPCClient(httpLink) as RouterClient<AppRouter>;

    const wsUrl = joinUrlPath(toWebSocketUrl(baseUrl), "/orpc/ws");
    const websocket = new WebSocket(wsUrl, {
      headers,
    });

    await new Promise<void>((resolve, reject) => {
      websocket.on("open", () => resolve());
      websocket.on("error", (err) => reject(err));
    });

    const wsLink = new WebSocketRPCLink({
      websocket: websocket as unknown as globalThis.WebSocket,
    });
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- needed for tsgo typecheck
    const ws = createORPCClient(wsLink) as RouterClient<AppRouter>;

    return new MuxOrpcClient({ http, ws, websocket });
  }

  close(): void {
    try {
      this.websocket.close();
    } catch {
      // best effort
    }
  }
}

interface PendingPrompt {
  cancelled: boolean;
  resolve: (stopReason: StopReason) => void;
  reject: (err: Error) => void;
  promise: Promise<StopReason>;
}

interface SessionState {
  workspaceId: string;
  caughtUp: boolean;
  caughtUpPromise: Promise<void>;
  resolveCaughtUp: () => void;
  pendingPrompt: PendingPrompt | null;
  streamTask: Promise<void>;
}

class MuxAcpAgent implements Agent {
  private readonly sessions = new Map<string, SessionState>();
  private pinnedWorkspaceId: string | null = null;

  constructor(
    private readonly conn: AgentSideConnection,
    private readonly mux: MuxOrpcClient,
    private readonly opts: CliOptions
  ) {
    // Ensure we don't leak any logs onto stdout after the protocol starts.
    console.log = (...args: unknown[]) => console.error(...args);
    console.info = (...args: unknown[]) => console.error(...args);
  }

  initialize(params: InitializeRequest): Promise<InitializeResponse> {
    stderrLog("debug", this.opts.logLevel, "initialize", params);

    const supportedProtocolVersion = 1;

    const agentCapabilities: AgentCapabilities = {
      promptCapabilities: {
        embeddedContext: true,
        image: false,
        audio: false,
      },
      // We don't implement session/load yet.
      loadSession: false,
    };

    const versionRecord = VERSION as Record<string, unknown>;
    const gitDescribe =
      typeof versionRecord.git_describe === "string" ? versionRecord.git_describe : "unknown";

    return Promise.resolve({
      protocolVersion: supportedProtocolVersion,
      agentInfo: {
        name: "mux",
        title: "Mux",
        version: gitDescribe,
      },
      agentCapabilities,
      authMethods: [],
    });
  }

  authenticate(_params: AuthenticateRequest): Promise<void> {
    // mux server auth is handled via bearer token passed to this bridge.
    return Promise.resolve();
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    stderrLog("debug", this.opts.logLevel, "newSession", params);

    const requestedCwd = params.cwd?.trim();
    const cwdFromRequest = requestedCwd && requestedCwd.length > 0 ? requestedCwd : undefined;

    const projectFallback = this.opts.project?.trim();
    const cwdFromFlag = projectFallback && projectFallback.length > 0 ? projectFallback : undefined;

    const cwd = cwdFromRequest ?? cwdFromFlag ?? process.cwd();
    const projectPath = path.resolve(cwd);

    await this.assertDirectoryExists(projectPath);

    const sessionId = await this.ensureWorkspaceForSession(projectPath);
    const state = this.ensureSessionState(sessionId);

    // Wait for catch-up so subsequent prompt calls see only live events.
    await this.waitForCaughtUp(state);

    return {
      sessionId,
    };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const sessionId = params.sessionId;
    stderrLog("debug", this.opts.logLevel, "prompt", {
      sessionId,
      promptBlocks: params.prompt.length,
    });

    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new Error(`Unknown sessionId: ${sessionId}`);
    }

    if (state.pendingPrompt) {
      throw new Error(`A prompt is already running for sessionId: ${sessionId}`);
    }

    const message = contentBlocksToText(params.prompt);
    if (!message) {
      throw new Error("Prompt was empty after converting ACP content blocks");
    }

    const pending = this.createPendingPrompt();
    state.pendingPrompt = pending;

    try {
      const sendResult = await this.mux.http.workspace.sendMessage({
        workspaceId: sessionId,
        message,
      });

      if (!sendResult.success) {
        const rendered = getErrorMessage(sendResult.error);
        throw new Error(`workspace.sendMessage failed: ${rendered}`);
      }

      const stopReason = await pending.promise;
      return { stopReason: toStopReason(stopReason) };
    } finally {
      // If the prompt completed (or failed), clear pending state.
      if (state.pendingPrompt === pending) {
        state.pendingPrompt = null;
      }
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const sessionId = params.sessionId;
    stderrLog("debug", this.opts.logLevel, "cancel", { sessionId });

    const state = this.sessions.get(sessionId);
    if (state?.pendingPrompt) {
      state.pendingPrompt.cancelled = true;
    }

    try {
      const result = await this.mux.http.workspace.interruptStream({ workspaceId: sessionId });
      if (!result.success) {
        stderrLog("warn", this.opts.logLevel, `workspace.interruptStream failed: ${result.error}`);
      }
    } catch (error) {
      stderrLog("warn", this.opts.logLevel, "workspace.interruptStream threw", error);
    }
  }

  private createPendingPrompt(): PendingPrompt {
    let resolve: ((reason: StopReason) => void) | null = null;
    let reject: ((err: Error) => void) | null = null;

    const promise = new Promise<StopReason>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    assert(resolve, "resolve must be set");
    assert(reject, "reject must be set");

    return {
      cancelled: false,
      resolve,
      reject,
      promise,
    };
  }

  private async assertDirectoryExists(dirPath: string): Promise<void> {
    try {
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) {
        throw new Error(`Not a directory: ${dirPath}`);
      }
    } catch (error) {
      const rendered = getErrorMessage(error);
      throw new Error(`Invalid project directory: ${dirPath} (${rendered})`);
    }
  }

  private async ensureWorkspaceForSession(projectPath: string): Promise<string> {
    const pinned = this.opts.workspace?.trim();
    if (pinned) {
      this.pinnedWorkspaceId ??= await this.resolveWorkspaceId(pinned);
      assert(this.pinnedWorkspaceId, "pinnedWorkspaceId must be set");
      return this.pinnedWorkspaceId;
    }

    const runtimeConfig = this.buildRuntimeConfig();
    const trunkBranch = this.opts.trunkBranch?.trim();

    if (runtimeConfig.type !== "local" && !trunkBranch) {
      throw new Error("--trunk-branch is required for --runtime worktree|ssh");
    }

    const createResult = await this.mux.http.workspace.create({
      projectPath,
      branchName: generateWorkspaceName(),
      trunkBranch: runtimeConfig.type === "local" ? undefined : trunkBranch,
      runtimeConfig,
      title: "ACP",
    });

    if (!createResult.success) {
      throw new Error(`workspace.create failed: ${createResult.error}`);
    }

    return createResult.metadata.id;
  }

  private buildRuntimeConfig(): RuntimeConfig {
    const runtime = this.opts.runtime;
    if (runtime === "local") {
      return { type: "local" };
    }

    if (runtime === "worktree") {
      const explicitSrcBaseDir = this.opts.srcBaseDir?.trim();
      const srcBaseDir =
        (explicitSrcBaseDir && explicitSrcBaseDir.length > 0 ? explicitSrcBaseDir : undefined) ??
        getMuxSrcDir();
      return { type: "worktree", srcBaseDir };
    }

    assert(runtime === "ssh", "runtime must be ssh");

    const host = this.opts.sshRuntimeHost?.trim();
    if (!host) {
      throw new Error("--ssh-runtime-host is required for --runtime ssh");
    }

    const srcBaseDir = this.opts.srcBaseDir?.trim();
    if (!srcBaseDir) {
      throw new Error("--src-base-dir is required for --runtime ssh (remote base directory)");
    }

    const portRaw = this.opts.sshRuntimePort?.trim();
    const port = portRaw ? Number.parseInt(portRaw, 10) : undefined;
    if (portRaw && (!Number.isFinite(port) || port! <= 0)) {
      throw new Error(`Invalid --ssh-runtime-port: ${portRaw}`);
    }

    const identityFileTrimmed = this.opts.sshIdentityFile?.trim();
    const identityFile =
      identityFileTrimmed && identityFileTrimmed.length > 0 ? identityFileTrimmed : undefined;

    return {
      type: "ssh",
      host,
      srcBaseDir,
      identityFile,
      port,
    };
  }

  private async resolveWorkspaceId(value: string): Promise<string> {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new Error("--workspace must not be empty");
    }

    const byId = await this.mux.http.workspace.getInfo({ workspaceId: trimmed });
    if (byId) {
      return byId.id;
    }

    const active = await this.mux.http.workspace.list();
    const archived = await this.mux.http.workspace.list({ archived: true });
    const combined = [...active, ...archived];
    const byName = combined.find((w) => w.name === trimmed);
    if (byName) {
      return byName.id;
    }

    throw new Error(`Workspace not found: ${trimmed}`);
  }

  private ensureSessionState(workspaceId: string): SessionState {
    const existing = this.sessions.get(workspaceId);
    if (existing) {
      return existing;
    }

    let resolveCaughtUp: (() => void) | null = null;
    const caughtUpPromise = new Promise<void>((resolve) => {
      resolveCaughtUp = resolve;
    });

    assert(resolveCaughtUp, "resolveCaughtUp must be set");

    const state: SessionState = {
      workspaceId,
      caughtUp: false,
      caughtUpPromise,
      resolveCaughtUp,
      pendingPrompt: null,
      streamTask: Promise.resolve(),
    };

    state.streamTask = this.consumeChatStream(state).catch((error) => {
      stderrLog("warn", this.opts.logLevel, `onChat stream ended for ${workspaceId}:`, error);
    });

    this.sessions.set(workspaceId, state);
    return state;
  }

  private async waitForCaughtUp(state: SessionState): Promise<void> {
    if (state.caughtUp) return;

    const timeoutMs = 30_000;
    await Promise.race([
      state.caughtUpPromise,
      new Promise<void>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`Timed out waiting for caught-up (${timeoutMs}ms)`)),
          timeoutMs
        )
      ),
    ]);
  }

  private async consumeChatStream(state: SessionState): Promise<void> {
    const stream = await this.mux.ws.workspace.onChat({ workspaceId: state.workspaceId });

    for await (const msg of stream) {
      if (this.conn.signal.aborted) {
        break;
      }

      if (!state.caughtUp) {
        if (isCaughtUpMessage(msg)) {
          state.caughtUp = true;
          state.resolveCaughtUp();
        }
        continue;
      }

      await this.handleLiveChatMessage(state, msg);
    }
  }

  private async handleLiveChatMessage(
    state: SessionState,
    msg: WorkspaceChatMessage
  ): Promise<void> {
    if (isStreamDelta(msg) || (msg as { type?: string }).type === "reasoning-delta") {
      const update = muxChatMessageToSessionUpdate(msg);
      if (update) {
        await this.safeSessionUpdate({
          sessionId: state.workspaceId,
          update,
        });
      }
      return;
    }

    if (isStreamEnd(msg)) {
      const pending = state.pendingPrompt;
      if (pending) {
        pending.resolve(pending.cancelled ? "cancelled" : "end_turn");
      }
      return;
    }

    if (isStreamAbort(msg)) {
      const pending = state.pendingPrompt;
      if (pending) {
        pending.resolve("cancelled");
      }
      return;
    }

    if (isStreamError(msg) || isErrorEvent(msg)) {
      const pending = state.pendingPrompt;
      if (pending) {
        const rendered = isStreamError(msg)
          ? msg.error
          : isErrorEvent(msg)
            ? msg.error
            : "Unknown stream error";
        pending.reject(new Error(rendered));
      }
      return;
    }

    // Ignore tool events, history replay, init logs, etc.
  }

  private async safeSessionUpdate(params: SessionNotification): Promise<void> {
    try {
      await this.conn.sessionUpdate(params);
    } catch (error) {
      if (this.conn.signal.aborted) {
        return;
      }
      throw error;
    }
  }
}

const program = new Command();
program
  .name("mux acp")
  .description("Start an Agent Client Protocol (ACP) stdio bridge for mux")
  .option("--server-url <url>", "mux server base URL (overrides lockfile and env)")
  .option("--server-token <token>", "mux server bearer token (overrides lockfile and env)")
  .option("--project <path>", "default project directory (used if ACP request omits cwd)")
  .option("--workspace <idOrName>", "attach to an existing mux workspace (by id or name)")
  .option("--runtime <type>", "runtime type: local, worktree, ssh", "local")
  .option("--trunk-branch <name>", "trunk branch (required for worktree/ssh runtimes)")
  .option(
    "--src-base-dir <path>",
    "worktree/ssh base directory (defaults to ~/.mux/src for worktree)"
  )
  .option("--ssh-runtime-host <host>", "SSH host for ssh runtime (e.g., user@host)")
  .option("--ssh-runtime-port <port>", "SSH port for ssh runtime")
  .option("--ssh-identity-file <path>", "SSH identity file for ssh runtime")
  .option("--log-level <level>", "log level: error, warn, info, debug", "error")
  .parse(process.argv, getParseOptions());

const rawOpts = program.opts();
const opts: CliOptions = {
  serverUrl: rawOpts.serverUrl as string | undefined,
  serverToken: rawOpts.serverToken as string | undefined,
  project: rawOpts.project as string | undefined,
  workspace: rawOpts.workspace as string | undefined,
  runtime: parseRuntimeFlag(rawOpts.runtime as string | undefined),
  trunkBranch: rawOpts.trunkBranch as string | undefined,
  srcBaseDir: rawOpts.srcBaseDir as string | undefined,
  sshRuntimeHost: rawOpts.sshRuntimeHost as string | undefined,
  sshRuntimePort: rawOpts.sshRuntimePort as string | undefined,
  sshIdentityFile: rawOpts.sshIdentityFile as string | undefined,
  logLevel: parseLogLevel(rawOpts.logLevel as string | undefined),
};

(async () => {
  const { baseUrl, authToken } = await discoverServer({
    baseUrl: opts.serverUrl,
    authToken: normalizeToken(opts.serverToken),
  });

  stderrLog("info", opts.logLevel, `Connecting to mux server at ${baseUrl}`);

  const mux = await MuxOrpcClient.connect({
    baseUrl,
    authToken: normalizeToken(authToken),
  });

  const stdoutStream = Writable.toWeb(process.stdout) as unknown as WritableStream<
    Uint8Array<ArrayBufferLike>
  >;
  const stdinStream = Readable.toWeb(process.stdin) as unknown as ReadableStream<
    Uint8Array<ArrayBufferLike>
  >;

  const stream = ndJsonStream(stdoutStream, stdinStream);

  const connection = new AgentSideConnection((conn) => new MuxAcpAgent(conn, mux, opts), stream);

  await connection.closed;
  mux.close();
})().catch((error) => {
  stderrLog("error", opts.logLevel, "mux acp failed:", error);
  process.exit(1);
});

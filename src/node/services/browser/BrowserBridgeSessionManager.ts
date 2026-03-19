import { WebSocket } from "ws";
import { getMuxBrowserSessionId } from "@/common/utils/browserSession";
import { assert } from "@/common/utils/assert";
import type { BrowserSessionStreamPortRegistry } from "@/node/services/browserSessionStreamPortRegistry";
import { log } from "@/node/services/log";
import {
  closeAgentBrowserSession,
  hasAgentBrowserSession,
  openAgentBrowserSession,
  type AgentBrowserCliCommandOptions,
} from "./agentBrowserCli";

const DEFAULT_INITIAL_URL = "about:blank";
const STREAM_READY_ATTEMPTS = 10;
const STREAM_READY_DELAY_MS = 250;
const STREAM_READY_TIMEOUT_MS = 1_000;
const STREAM_HOST = "127.0.0.1";

interface WaitForStreamPortResult {
  ok: true;
}

interface WaitForStreamPortFailure {
  ok: false;
  error: string;
}

export interface BrowserBridgeSessionConnection {
  workspaceId: string;
  sessionId: string;
  streamPort: number;
}

export interface BrowserBridgeSessionManagerOptions {
  streamPortRegistry: Pick<
    BrowserSessionStreamPortRegistry,
    "reservePort" | "releasePort" | "isReservedPort" | "getKnownPort"
  >;
  cliOptions?: AgentBrowserCliCommandOptions;
  hasAgentBrowserSessionFn?: typeof hasAgentBrowserSession;
  openAgentBrowserSessionFn?: typeof openAgentBrowserSession;
  closeAgentBrowserSessionFn?: typeof closeAgentBrowserSession;
  waitForStreamPortFn?: typeof waitForStreamPort;
}

function getStreamSocketUrl(streamPort: number): string {
  assert(Number.isInteger(streamPort), "Browser bridge stream port must be an integer");
  assert(streamPort > 0, "Browser bridge stream port must be positive");
  return `ws://${STREAM_HOST}:${streamPort}`;
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

async function waitForStreamPort(
  streamPort: number
): Promise<WaitForStreamPortResult | WaitForStreamPortFailure> {
  const socketUrl = getStreamSocketUrl(streamPort);
  let lastError = `Browser preview stream did not open on ${socketUrl}`;

  for (let attempt = 1; attempt <= STREAM_READY_ATTEMPTS; attempt += 1) {
    const result = await new Promise<WaitForStreamPortResult | WaitForStreamPortFailure>(
      (resolve) => {
        let settled = false;
        const socket = new WebSocket(socketUrl);
        const timeout = setTimeout(() => {
          settle({
            ok: false,
            error: `Timed out waiting for browser preview stream on ${socketUrl}`,
          });
        }, STREAM_READY_TIMEOUT_MS);
        timeout.unref?.();

        const settle = (value: WaitForStreamPortResult | WaitForStreamPortFailure): void => {
          if (settled) {
            return;
          }

          settled = true;
          clearTimeout(timeout);
          try {
            if (
              socket.readyState === WebSocket.OPEN ||
              socket.readyState === WebSocket.CONNECTING
            ) {
              socket.close();
            } else if (socket.readyState !== WebSocket.CLOSED) {
              socket.terminate();
            }
          } catch {
            // Best-effort cleanup only.
          }
          resolve(value);
        };

        socket.once("open", () => {
          settle({ ok: true });
        });
        socket.once("error", (error) => {
          settle({ ok: false, error: error instanceof Error ? error.message : String(error) });
        });
        socket.once("close", (code, reason) => {
          const closeReason = reason.toString("utf8").trim();
          settle({
            ok: false,
            error:
              closeReason.length > 0
                ? closeReason
                : `Browser preview stream closed before it was ready (${code})`,
          });
        });
      }
    );

    if (result.ok) {
      return result;
    }

    lastError = result.error;
    if (attempt < STREAM_READY_ATTEMPTS) {
      await sleep(STREAM_READY_DELAY_MS);
    }
  }

  return { ok: false, error: lastError };
}

export class BrowserBridgeSessionManager {
  private readonly hasAgentBrowserSessionFn: typeof hasAgentBrowserSession;
  private readonly openAgentBrowserSessionFn: typeof openAgentBrowserSession;
  private readonly closeAgentBrowserSessionFn: typeof closeAgentBrowserSession;
  private readonly waitForStreamPortFn: typeof waitForStreamPort;
  private readonly streamPortRegistry: BrowserBridgeSessionManagerOptions["streamPortRegistry"];
  private readonly cliOptions: AgentBrowserCliCommandOptions | undefined;
  private readonly startupPromises = new Map<string, Promise<BrowserBridgeSessionConnection>>();
  private disposed = false;

  constructor(options: BrowserBridgeSessionManagerOptions) {
    assert(options.streamPortRegistry, "BrowserBridgeSessionManager requires a streamPortRegistry");
    this.hasAgentBrowserSessionFn = options.hasAgentBrowserSessionFn ?? hasAgentBrowserSession;
    this.openAgentBrowserSessionFn = options.openAgentBrowserSessionFn ?? openAgentBrowserSession;
    this.closeAgentBrowserSessionFn =
      options.closeAgentBrowserSessionFn ?? closeAgentBrowserSession;
    this.waitForStreamPortFn = options.waitForStreamPortFn ?? waitForStreamPort;
    this.streamPortRegistry = options.streamPortRegistry;
    this.cliOptions = options.cliOptions;
  }

  async ensureStarted(
    workspaceId: string,
    options?: { initialUrl?: string | null }
  ): Promise<BrowserBridgeSessionConnection> {
    assert(
      workspaceId.trim().length > 0,
      "BrowserBridgeSessionManager.ensureStarted requires workspaceId"
    );
    assert(!this.disposed, "BrowserBridgeSessionManager is disposed");

    const existingPromise = this.startupPromises.get(workspaceId);
    if (existingPromise) {
      return existingPromise;
    }

    const startupPromise = this.ensureStartedInternal(workspaceId, options, true);
    this.startupPromises.set(workspaceId, startupPromise);

    try {
      return await startupPromise;
    } finally {
      if (this.startupPromises.get(workspaceId) === startupPromise) {
        this.startupPromises.delete(workspaceId);
      }
    }
  }

  async stop(workspaceId: string): Promise<void> {
    assert(workspaceId.trim().length > 0, "BrowserBridgeSessionManager.stop requires workspaceId");

    const sessionId = getMuxBrowserSessionId(workspaceId);
    try {
      const result = await this.closeAgentBrowserSessionFn(sessionId, undefined, this.cliOptions);
      if (!result.success) {
        log.warn("BrowserBridgeSessionManager failed to close session", {
          workspaceId,
          sessionId,
          error: result.error,
        });
      }
    } finally {
      this.streamPortRegistry.releasePort(workspaceId);
    }
  }

  async getLiveSessionConnection(
    workspaceId: string
  ): Promise<BrowserBridgeSessionConnection | null> {
    assert(
      workspaceId.trim().length > 0,
      "BrowserBridgeSessionManager.getLiveSessionConnection requires workspaceId"
    );

    const streamPort = this.streamPortRegistry.getKnownPort(workspaceId);
    if (streamPort == null) {
      return null;
    }

    const sessionId = getMuxBrowserSessionId(workspaceId);
    const hasSession = await this.hasAgentBrowserSessionFn(sessionId, undefined, this.cliOptions);
    if (!hasSession) {
      return null;
    }

    return { workspaceId, sessionId, streamPort };
  }

  dispose(): void {
    this.disposed = true;
    this.startupPromises.clear();
  }

  private async ensureStartedInternal(
    workspaceId: string,
    options: { initialUrl?: string | null } | undefined,
    allowRestart: boolean
  ): Promise<BrowserBridgeSessionConnection> {
    const sessionId = getMuxBrowserSessionId(workspaceId);
    const initialUrl = options?.initialUrl ?? DEFAULT_INITIAL_URL;
    const streamPort = await this.streamPortRegistry.reservePort(workspaceId);
    assert(
      this.streamPortRegistry.isReservedPort(workspaceId, streamPort),
      `BrowserBridgeSessionManager expected stream port ${streamPort} to remain reserved for ${workspaceId}`
    );

    const sessionAlreadyExists = await this.hasAgentBrowserSessionFn(
      sessionId,
      undefined,
      this.cliOptions
    );
    if (!sessionAlreadyExists) {
      const openResult = await this.openAgentBrowserSessionFn(sessionId, initialUrl, {
        ...this.cliOptions,
        streamPort,
      });
      if (!openResult.success) {
        this.streamPortRegistry.releasePort(workspaceId);
        throw new Error(openResult.error);
      }
    }

    const streamResult = await this.waitForStreamPortFn(streamPort);
    if (streamResult.ok) {
      return { workspaceId, sessionId, streamPort };
    }

    if (!allowRestart) {
      await this.stop(workspaceId);
      throw new Error(streamResult.error);
    }

    log.warn("BrowserBridgeSessionManager restarting session after stream bootstrap failure", {
      workspaceId,
      sessionId,
      streamPort,
      sessionAlreadyExists,
      error: streamResult.error,
    });

    await this.stop(workspaceId);
    return await this.ensureStartedInternal(workspaceId, options, false);
  }
}

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "events";
import type {
  BrowserAction,
  BrowserInputEvent,
  BrowserSession,
  BrowserSessionEvent,
} from "@/common/types/browserSession";
import { getMuxBrowserSessionId } from "@/common/utils/browserSession";
import {
  BrowserSessionBackend,
  closeAgentBrowserSession,
  type BrowserSessionBackendOptions,
} from "@/node/services/browserSessionBackend";
import type { BrowserSessionStreamPortRegistry } from "@/node/services/browserSessionStreamPortRegistry";
import { log } from "@/node/services/log";

const MAX_RECENT_ACTIONS = 50;

type BrowserSessionServiceStreamPortRegistry = Pick<
  BrowserSessionStreamPortRegistry,
  "reservePort" | "releasePort" | "isReservedPort"
>;

interface BrowserSessionServiceOptions {
  streamPortRegistry?: BrowserSessionServiceStreamPortRegistry;
  createBackend?: (options: BrowserSessionBackendOptions) => BrowserSessionBackend;
}

export class BrowserSessionService extends EventEmitter {
  private readonly activeSessions = new Map<string, BrowserSession>();
  private readonly activeBackends = new Map<string, BrowserSessionBackend>();
  private readonly recentActions = new Map<string, BrowserAction[]>();
  private readonly startPromises = new Map<string, Promise<BrowserSession>>();
  private readonly streamPortRegistry: BrowserSessionServiceStreamPortRegistry | null;
  private readonly createBackend: (options: BrowserSessionBackendOptions) => BrowserSessionBackend;
  private disposed = false;

  constructor(options?: BrowserSessionServiceOptions) {
    super();
    this.streamPortRegistry = options?.streamPortRegistry ?? null;
    this.createBackend =
      options?.createBackend ?? ((backendOptions) => new BrowserSessionBackend(backendOptions));
  }

  getActiveSession(workspaceId: string): BrowserSession | null {
    assert(
      workspaceId.trim().length > 0,
      "BrowserSessionService.getActiveSession requires a workspaceId"
    );
    return this.activeSessions.get(workspaceId) ?? null;
  }

  async startSession(
    workspaceId: string,
    options?: { initialUrl?: string | null }
  ): Promise<BrowserSession> {
    assert(
      workspaceId.trim().length > 0,
      "BrowserSessionService.startSession requires a workspaceId"
    );
    assert(!this.disposed, "BrowserSessionService is disposed");

    const existingPromise = this.startPromises.get(workspaceId);
    if (existingPromise) {
      return existingPromise;
    }

    const startPromise = this.startSessionInternal(workspaceId, options);
    this.startPromises.set(workspaceId, startPromise);
    try {
      return await startPromise;
    } finally {
      if (this.startPromises.get(workspaceId) === startPromise) {
        this.startPromises.delete(workspaceId);
      }
    }
  }

  private async startSessionInternal(
    workspaceId: string,
    options?: { initialUrl?: string | null }
  ): Promise<BrowserSession> {
    const existing = this.activeSessions.get(workspaceId);
    if (existing && (existing.status === "starting" || existing.status === "live")) {
      return existing;
    }

    if (existing && existing.status !== "starting" && existing.status !== "live") {
      await this.cleanupWorkspace(workspaceId);
    }

    this.recentActions.set(workspaceId, []);
    const streamPort = await this.reserveStreamPort(workspaceId);

    let backend: BrowserSessionBackend | null = null;
    const isCurrentBackend = (wsId: string): boolean => {
      assert(backend !== null, "BrowserSessionService callback ran before backend initialization");
      return this.activeBackends.get(wsId) === backend;
    };

    const backendOptions: BrowserSessionBackendOptions = {
      workspaceId,
      initialUrl: options?.initialUrl ?? "about:blank",
      streamPort,
      onSessionUpdate: (session) => {
        if (!isCurrentBackend(workspaceId)) {
          return;
        }

        this.activeSessions.set(workspaceId, session);
        this.emitEvent(workspaceId, { type: "session-updated", session });
      },
      onAction: (action) => {
        if (!isCurrentBackend(workspaceId)) {
          return;
        }

        this.appendAction(workspaceId, action);
        this.emitEvent(workspaceId, { type: "action", action });
      },
      onEnded: (wsId) => {
        if (!isCurrentBackend(wsId)) {
          this.releaseWorkspaceResources(wsId);
          return;
        }

        this.emitEvent(wsId, { type: "session-ended", workspaceId: wsId });
        this.releaseWorkspaceResources(wsId);
      },
      onError: (wsId, error) => {
        if (!isCurrentBackend(wsId)) {
          return;
        }

        this.emitEvent(wsId, { type: "error", workspaceId: wsId, error });
      },
    };

    backend = this.createBackend(backendOptions);
    this.activeBackends.set(workspaceId, backend);
    const session = await backend.start();
    this.activeSessions.set(workspaceId, session);
    return session;
  }

  async stopSession(workspaceId: string): Promise<void> {
    assert(
      workspaceId.trim().length > 0,
      "BrowserSessionService.stopSession requires a workspaceId"
    );

    const backend = this.activeBackends.get(workspaceId);
    if (backend) {
      await backend.stop();
    } else {
      // Only attempt standalone close for untracked CLI-started sessions.
      // When a tracked backend exists, backend.stop() already closes the session
      // via the same CLI command, so a second close would be redundant and would
      // double the timeout window in failure cases.
      const sessionId = getMuxBrowserSessionId(workspaceId);
      const result = await closeAgentBrowserSession(sessionId);
      if (!result.success) {
        log.warn(`Failed to close browser session ${sessionId}: ${result.error ?? "unknown"}`);
      }
    }

    this.releaseWorkspaceResources(workspaceId);
  }

  sendInput(workspaceId: string, input: BrowserInputEvent): { success: boolean; error?: string } {
    assert(workspaceId.trim().length > 0, "BrowserSessionService.sendInput requires a workspaceId");

    const backend = this.activeBackends.get(workspaceId);
    if (backend == null) {
      return { success: false, error: "No active session for workspace" };
    }

    const result = backend.sendInput(input);
    if (result.success) {
      this.logInputAction(workspaceId, input);
    }

    return result;
  }

  getRecentActions(workspaceId: string): BrowserAction[] {
    assert(
      workspaceId.trim().length > 0,
      "BrowserSessionService.getRecentActions requires a workspaceId"
    );
    return this.recentActions.get(workspaceId) ?? [];
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    for (const [workspaceId, backend] of this.activeBackends) {
      // Shutdown is already in progress, so fire-and-forget is acceptable here:
      // no observers remain, and stop() best-effort sends agent-browser close
      // before the backend marks the session as ended.
      void backend.stop();
      this.releaseWorkspaceResources(workspaceId);
    }
    this.activeBackends.clear();
    this.activeSessions.clear();
    this.recentActions.clear();
    this.startPromises.clear();
    this.removeAllListeners();
  }

  private emitEvent(workspaceId: string, event: BrowserSessionEvent): void {
    this.emit(`update:${workspaceId}`, event);
  }

  private appendAction(workspaceId: string, action: BrowserAction): void {
    let actions = this.recentActions.get(workspaceId);
    if (!actions) {
      actions = [];
      this.recentActions.set(workspaceId, actions);
    }

    actions.push(action);
    if (actions.length > MAX_RECENT_ACTIONS) {
      actions.shift();
    }
  }

  private logInputAction(workspaceId: string, input: BrowserInputEvent): void {
    let actionType: BrowserAction["type"];
    let description: string;

    switch (input.kind) {
      case "mouse":
        if (input.eventType === "mousePressed") {
          actionType = "click";
          description = `Clicked at (${Math.round(input.x)}, ${Math.round(input.y)})`;
        } else if (input.eventType === "mouseWheel") {
          actionType = "custom";
          description = `Scrolled (${input.deltaX ?? 0}, ${input.deltaY ?? 0})`;
        } else {
          return;
        }
        break;
      case "keyboard":
        return;
      case "touch": {
        if (input.eventType !== "touchStart") {
          return;
        }

        const point = input.touchPoints[0];
        if (point == null) {
          return;
        }

        actionType = "click";
        description = `Tapped at (${Math.round(point.x)}, ${Math.round(point.y)})`;
        break;
      }
    }

    const action: BrowserAction = {
      id: `browser-action-${randomUUID().slice(0, 8)}`,
      type: actionType,
      description,
      timestamp: new Date().toISOString(),
      metadata: { source: "user-input" },
    };
    this.appendAction(workspaceId, action);
    this.emitEvent(workspaceId, { type: "action", action });
  }

  private async cleanupWorkspace(workspaceId: string): Promise<void> {
    const backend = this.activeBackends.get(workspaceId);
    if (backend) {
      // Await stop() so replacement sessions cannot race with stale backend
      // callbacks while the previous browser process is still shutting down.
      await backend.stop();
    }

    this.releaseWorkspaceResources(workspaceId);
  }

  private async reserveStreamPort(workspaceId: string): Promise<number | undefined> {
    if (this.streamPortRegistry === null) {
      return undefined;
    }

    const streamPort = await this.streamPortRegistry.reservePort(workspaceId);
    assert(
      this.streamPortRegistry.isReservedPort(workspaceId, streamPort),
      `BrowserSessionService expected stream port ${streamPort} to remain reserved for ${workspaceId}`
    );
    return streamPort;
  }

  private releaseWorkspaceResources(workspaceId: string): void {
    this.activeBackends.delete(workspaceId);
    this.activeSessions.delete(workspaceId);
    this.recentActions.delete(workspaceId);
    this.startPromises.delete(workspaceId);
    this.streamPortRegistry?.releasePort(workspaceId);
  }
}

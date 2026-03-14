import assert from "node:assert/strict";
import { EventEmitter } from "events";
import type {
  BrowserAction,
  BrowserSession,
  BrowserSessionEvent,
} from "@/common/types/browserSession";
import {
  BrowserSessionBackend,
  type BrowserSessionBackendOptions,
} from "@/node/services/browserSessionBackend";

const MAX_RECENT_ACTIONS = 50;

export class BrowserSessionService extends EventEmitter {
  private readonly activeSessions = new Map<string, BrowserSession>();
  private readonly activeBackends = new Map<string, BrowserSessionBackend>();
  private readonly recentActions = new Map<string, BrowserAction[]>();
  private disposed = false;

  getActiveSession(workspaceId: string): BrowserSession | null {
    assert(
      workspaceId.trim().length > 0,
      "BrowserSessionService.getActiveSession requires a workspaceId"
    );
    return this.activeSessions.get(workspaceId) ?? null;
  }

  async startSession(
    workspaceId: string,
    options?: { ownership?: "agent" | "user" | "shared" | null; initialUrl?: string | null }
  ): Promise<BrowserSession> {
    assert(
      workspaceId.trim().length > 0,
      "BrowserSessionService.startSession requires a workspaceId"
    );
    assert(!this.disposed, "BrowserSessionService is disposed");

    const existing = this.activeSessions.get(workspaceId);
    if (existing && (existing.status === "starting" || existing.status === "live")) {
      return existing;
    }

    if (existing) {
      this.cleanupWorkspace(workspaceId);
    }

    this.recentActions.set(workspaceId, []);

    const backendOptions: BrowserSessionBackendOptions = {
      workspaceId,
      ownership: options?.ownership ?? "agent",
      initialUrl: options?.initialUrl ?? "about:blank",
      onSessionUpdate: (session) => {
        this.activeSessions.set(workspaceId, session);
        this.emitEvent(workspaceId, { type: "session-updated", session });
      },
      onAction: (action) => {
        this.appendAction(workspaceId, action);
        this.emitEvent(workspaceId, { type: "action", action });
      },
      onEnded: (wsId) => {
        this.emitEvent(wsId, { type: "session-ended", workspaceId: wsId });
        this.activeSessions.delete(wsId);
        this.activeBackends.delete(wsId);
      },
      onError: (wsId, error) => {
        this.emitEvent(wsId, { type: "error", workspaceId: wsId, error });
      },
    };

    const backend = new BrowserSessionBackend(backendOptions);
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
    }
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
    for (const [, backend] of this.activeBackends) {
      // Shutdown is already in progress, so fire-and-forget is acceptable here:
      // no observers remain, and stop() best-effort sends agent-browser close
      // before the backend marks the session as ended.
      void backend.stop();
    }
    this.activeBackends.clear();
    this.activeSessions.clear();
    this.recentActions.clear();
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

  private cleanupWorkspace(workspaceId: string): void {
    const backend = this.activeBackends.get(workspaceId);
    if (backend) {
      backend.dispose();
    }

    this.activeBackends.delete(workspaceId);
    this.activeSessions.delete(workspaceId);
  }
}

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "events";
import type {
  BrowserAction,
  BrowserInputEvent,
  BrowserMouseInput,
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
const MAX_IGNORABLE_SCROLL_DELTA = 1;
const MAX_CONSECUTIVE_NAVIGATE_MERGE_WINDOW_MS = 2_000;
const USER_INPUT_ACTION_SOURCE = "user-input";

type ScrollDirection = "up" | "down" | "left" | "right";

interface UserInputScrollActionMetadata extends Record<string, unknown> {
  source: typeof USER_INPUT_ACTION_SOURCE;
  inputKind: "scroll";
  scrollDirection: ScrollDirection;
  scrollCount: number;
}

interface NavigateActionMetadata {
  previousUrl: string | null;
  currentUrl: string | null;
  previousTitle: string | null;
  title: string | null;
  navigateCount: number;
}

type BrowserSessionServiceStreamPortRegistry = Pick<
  BrowserSessionStreamPortRegistry,
  "reservePort" | "releasePort" | "isReservedPort" | "getKnownPort"
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
    options?: { initialUrl?: string | null },
    allowAttachRecovery = true
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

        const appendedAction = this.appendAction(workspaceId, action);
        this.emitEvent(workspaceId, { type: "action", action: appendedAction });
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

    if (
      // Retry once when attach succeeds but streaming does not.
      allowAttachRecovery &&
      session.status === "live" &&
      session.streamState === "restart_required"
    ) {
      const recoveryUrl =
        session.currentUrl != null && session.currentUrl !== "about:blank"
          ? session.currentUrl
          : (options?.initialUrl ?? "about:blank");
      log.debug("BrowserSessionService restarting workspace browser after stale attach metadata", {
        workspaceId,
        recoveryUrl,
      });
      await this.cleanupWorkspace(workspaceId);
      return await this.startSessionInternal(workspaceId, { initialUrl: recoveryUrl }, false);
    }

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

  navigate(workspaceId: string, url: string): Promise<{ success: boolean; error?: string }> {
    assert(workspaceId.trim().length > 0, "BrowserSessionService.navigate requires a workspaceId");
    assert(url.trim().length > 0, "BrowserSessionService.navigate requires a url");

    const backend = this.activeBackends.get(workspaceId);
    if (backend == null) {
      return Promise.resolve({ success: false, error: "No active session for workspace" });
    }

    return backend.navigate(url);
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

  private appendAction(workspaceId: string, action: BrowserAction): BrowserAction {
    let actions = this.recentActions.get(workspaceId);
    if (!actions) {
      actions = [];
      this.recentActions.set(workspaceId, actions);
    }

    const previousAction = actions.at(-1);
    const mergedAction =
      previousAction == null
        ? null
        : (mergeConsecutiveScrollActions(previousAction, action) ??
          mergeConsecutiveNavigateActions(previousAction, action));
    if (mergedAction != null) {
      actions[actions.length - 1] = mergedAction;
      return mergedAction;
    }

    actions.push(action);
    if (actions.length > MAX_RECENT_ACTIONS) {
      actions.shift();
    }
    return action;
  }

  private logInputAction(workspaceId: string, input: BrowserInputEvent): void {
    const action = createInputAction(input);
    if (action == null) {
      return;
    }

    const appendedAction = this.appendAction(workspaceId, action);
    this.emitEvent(workspaceId, { type: "action", action: appendedAction });
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

function createInputAction(input: BrowserInputEvent): BrowserAction | null {
  switch (input.kind) {
    case "mouse":
      if (input.eventType === "mousePressed") {
        assert(Number.isFinite(input.x), "BrowserSessionService expected mouse x to be finite");
        assert(Number.isFinite(input.y), "BrowserSessionService expected mouse y to be finite");
        return createUserInputAction(
          "click",
          `Clicked at (${Math.round(input.x)}, ${Math.round(input.y)})`
        );
      }

      if (input.eventType !== "mouseWheel") {
        return null;
      }

      return createScrollInputAction(input);
    case "keyboard":
      return null;
    case "touch": {
      if (input.eventType !== "touchStart") {
        return null;
      }

      const point = input.touchPoints[0];
      if (point == null) {
        return null;
      }

      assert(Number.isFinite(point.x), "BrowserSessionService expected touch x to be finite");
      assert(Number.isFinite(point.y), "BrowserSessionService expected touch y to be finite");
      return createUserInputAction(
        "click",
        `Tapped at (${Math.round(point.x)}, ${Math.round(point.y)})`
      );
    }
  }
}

function createScrollInputAction(input: BrowserMouseInput): BrowserAction | null {
  const deltaX = input.deltaX ?? 0;
  const deltaY = input.deltaY ?? 0;
  assert(Number.isFinite(input.x), "BrowserSessionService expected wheel x to be finite");
  assert(Number.isFinite(input.y), "BrowserSessionService expected wheel y to be finite");
  assert(Number.isFinite(deltaX), "BrowserSessionService expected wheel deltaX to be finite");
  assert(Number.isFinite(deltaY), "BrowserSessionService expected wheel deltaY to be finite");

  if (
    Math.abs(deltaX) <= MAX_IGNORABLE_SCROLL_DELTA &&
    Math.abs(deltaY) <= MAX_IGNORABLE_SCROLL_DELTA
  ) {
    return null;
  }

  const scrollDirection = getScrollDirection(deltaX, deltaY);
  return createUserInputAction("custom", formatScrollActionDescription(scrollDirection, 1), {
    inputKind: "scroll",
    scrollDirection,
    scrollCount: 1,
  });
}

function createUserInputAction(
  type: BrowserAction["type"],
  description: string,
  metadata: Record<string, unknown> = {}
): BrowserAction {
  return {
    id: `browser-action-${randomUUID().slice(0, 8)}`,
    type,
    description,
    timestamp: new Date().toISOString(),
    metadata: {
      source: USER_INPUT_ACTION_SOURCE,
      ...metadata,
    },
  };
}

// Recent actions is a user-facing timeline, so collapse repeated wheel ticks into
// a readable scroll summary instead of spending the 50-item budget on raw deltas.
function mergeConsecutiveScrollActions(
  previousAction: BrowserAction,
  nextAction: BrowserAction
): BrowserAction | null {
  const previousScrollMetadata = getUserInputScrollActionMetadata(previousAction);
  const nextScrollMetadata = getUserInputScrollActionMetadata(nextAction);
  if (previousScrollMetadata == null || nextScrollMetadata == null) {
    return null;
  }

  if (previousScrollMetadata.scrollDirection !== nextScrollMetadata.scrollDirection) {
    return null;
  }

  const scrollCount = previousScrollMetadata.scrollCount + nextScrollMetadata.scrollCount;

  return {
    ...previousAction,
    description: formatScrollActionDescription(previousScrollMetadata.scrollDirection, scrollCount),
    timestamp: nextAction.timestamp,
    metadata: {
      ...(previousAction.metadata ?? {}),
      ...(nextAction.metadata ?? {}),
      source: USER_INPUT_ACTION_SOURCE,
      inputKind: "scroll",
      scrollDirection: previousScrollMetadata.scrollDirection,
      scrollCount,
    },
  };
}

// Browser backends can emit several identical route-change notifications in quick succession
// (redirect chains, SPA retries). Merge those bursts so Recent actions keeps the latest state
// without burning through its fixed budget on near-duplicate navigate rows.
function mergeConsecutiveNavigateActions(
  previousAction: BrowserAction,
  nextAction: BrowserAction
): BrowserAction | null {
  const previousNavigateMetadata = getNavigateActionMetadata(previousAction);
  const nextNavigateMetadata = getNavigateActionMetadata(nextAction);
  if (previousNavigateMetadata == null || nextNavigateMetadata == null) {
    return null;
  }

  if (
    previousNavigateMetadata.currentUrl == null ||
    nextNavigateMetadata.currentUrl == null ||
    previousNavigateMetadata.currentUrl !== nextNavigateMetadata.currentUrl
  ) {
    return null;
  }

  const previousTimestampMs = parseActionTimestampMs(previousAction);
  const nextTimestampMs = parseActionTimestampMs(nextAction);
  if (Math.abs(nextTimestampMs - previousTimestampMs) > MAX_CONSECUTIVE_NAVIGATE_MERGE_WINDOW_MS) {
    return null;
  }

  const navigateCount = previousNavigateMetadata.navigateCount + nextNavigateMetadata.navigateCount;

  return {
    ...previousAction,
    description: nextAction.description,
    timestamp: nextAction.timestamp,
    metadata: {
      ...(previousAction.metadata ?? {}),
      ...(nextAction.metadata ?? {}),
      navigateCount,
    },
  };
}

function getNavigateActionMetadata(action: BrowserAction): NavigateActionMetadata | null {
  if (action.type !== "navigate") {
    return null;
  }

  const metadata = action.metadata;
  if (metadata == null) {
    return {
      previousUrl: null,
      currentUrl: null,
      previousTitle: null,
      title: null,
      navigateCount: 1,
    };
  }

  assert(
    isRecord(metadata),
    "BrowserSessionService expected navigate metadata to be a record before merging actions"
  );

  return {
    previousUrl: readOptionalNavigateMetadataString(metadata, "previousUrl"),
    currentUrl: readOptionalNavigateMetadataString(metadata, "currentUrl"),
    previousTitle: readOptionalNavigateMetadataString(metadata, "previousTitle"),
    title: readOptionalNavigateMetadataString(metadata, "title"),
    navigateCount: readNavigateCount(metadata),
  };
}

function readOptionalNavigateMetadataString(
  metadata: Record<string, unknown>,
  key: keyof Omit<NavigateActionMetadata, "navigateCount">
): string | null {
  const value = metadata[key];
  assert(
    value == null || typeof value === "string",
    `BrowserSessionService expected navigate metadata.${key} to be a string or nullish`
  );

  if (typeof value !== "string") {
    return null;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : null;
}

function readNavigateCount(metadata: Record<string, unknown>): number {
  const navigateCount = metadata.navigateCount;
  if (navigateCount == null) {
    return 1;
  }

  assert(
    typeof navigateCount === "number" && Number.isInteger(navigateCount) && navigateCount >= 1,
    "BrowserSessionService expected navigate metadata.navigateCount to be a positive integer"
  );
  return navigateCount;
}

function parseActionTimestampMs(action: BrowserAction): number {
  const timestampMs = Date.parse(action.timestamp);
  assert(
    Number.isFinite(timestampMs),
    `BrowserSessionService expected ${action.type} action timestamps to be valid ISO strings`
  );
  return timestampMs;
}

function getUserInputScrollActionMetadata(
  action: BrowserAction
): UserInputScrollActionMetadata | null {
  if (action.type !== "custom") {
    return null;
  }

  const metadata = action.metadata;
  if (metadata?.source !== USER_INPUT_ACTION_SOURCE || metadata.inputKind !== "scroll") {
    return null;
  }

  const scrollDirection = metadata.scrollDirection;
  if (!isScrollDirection(scrollDirection)) {
    return null;
  }

  const scrollCount = metadata.scrollCount;
  if (typeof scrollCount !== "number" || !Number.isInteger(scrollCount) || scrollCount < 1) {
    return null;
  }

  return {
    source: USER_INPUT_ACTION_SOURCE,
    inputKind: "scroll",
    scrollDirection,
    scrollCount,
  };
}

function getScrollDirection(deltaX: number, deltaY: number): ScrollDirection {
  if (Math.abs(deltaY) >= Math.abs(deltaX)) {
    return deltaY >= 0 ? "down" : "up";
  }

  return deltaX >= 0 ? "right" : "left";
}

function formatScrollActionDescription(direction: ScrollDirection, count: number): string {
  assert(Number.isInteger(count), "BrowserSessionService expected scroll counts to be integers");
  assert(count >= 1, "BrowserSessionService expected scroll counts to stay positive");
  return count === 1 ? `Scrolled ${direction}` : `Scrolled ${direction} ×${count}`;
}

function isScrollDirection(value: unknown): value is ScrollDirection {
  return value === "up" || value === "down" || value === "left" || value === "right";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

import { EventEmitter } from "events";
import { createHash } from "crypto";
import * as path from "path";
import * as fsPromises from "fs/promises";
import type { Config } from "@/node/config";
import type { WorkspaceActivitySnapshot, WorkspaceMetadata } from "@/common/types/workspace";
import type { Runtime } from "@/node/runtime/Runtime";
import type { RuntimeConfig } from "@/common/types/runtime";
import { createRuntimeForWorkspace } from "@/node/runtime/runtimeHelpers";
import { expandTilde } from "@/node/runtime/tildeExpansion";
import { execBuffered, readFileString, writeFileString } from "@/node/utils/runtime/helpers";
import {
  FLOW_PROMPTS_DIR,
  getFlowPromptPathMarkerLine,
  getFlowPromptRelativePath,
  type FlowPromptAutoSendMode,
} from "@/common/constants/flowPrompting";
import { getErrorMessage } from "@/common/utils/errors";
import { shellQuote } from "@/common/utils/shell";
import { extractHeadingSection } from "@/node/utils/main/markdown";
import { log } from "@/node/services/log";
import { generateDiff } from "@/node/services/tools/fileCommon";

const FLOW_PROMPT_ACTIVE_POLL_INTERVAL_MS = 1_000;
const FLOW_PROMPT_RECENT_POLL_INTERVAL_MS = 10_000;
const FLOW_PROMPT_RECENT_WINDOW_MS = 24 * 60 * 60 * 1_000;
const FLOW_PROMPT_STATE_FILE = "flow-prompt-state.json";
const MAX_FLOW_PROMPT_DIFF_CHARS = 12_000;
const DEFAULT_FLOW_PROMPT_AUTO_SEND_MODE: FlowPromptAutoSendMode = "off";

interface PersistedFlowPromptState {
  lastSentContent: string | null;
  lastSentFingerprint: string | null;
  autoSendMode: FlowPromptAutoSendMode;
}

export interface FlowPromptState {
  workspaceId: string;
  path: string;
  exists: boolean;
  hasNonEmptyContent: boolean;
  modifiedAtMs: number | null;
  contentFingerprint: string | null;
  lastEnqueuedFingerprint: string | null;
  isCurrentVersionEnqueued: boolean;
  hasPendingUpdate: boolean;
  autoSendMode: FlowPromptAutoSendMode;
  nextHeadingContent: string | null;
  updatePreviewText: string | null;
}

export interface FlowPromptUpdateRequest {
  workspaceId: string;
  path: string;
  nextContent: string;
  nextFingerprint: string;
  text: string;
  state: FlowPromptState;
}

export interface FlowPromptAttachDraft {
  text: string;
  flowPromptAttachment: {
    path: string;
    fingerprint: string;
  };
}

interface FlowPromptMonitor {
  timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  refreshing: boolean;
  refreshPromise: Promise<FlowPromptState> | null;
  queuedRefresh: boolean;
  queuedRefreshEmitEvents: boolean;
  pendingFingerprint: string | null;
  inFlightFingerprint: string | null;
  lastState: FlowPromptState | null;
  activeChatSubscriptions: number;
  lastOpenedAtMs: number | null;
  lastKnownActivityAtMs: number | null;
}

interface FlowPromptFileSnapshot {
  workspaceId: string;
  path: string;
  exists: boolean;
  content: string;
  hasNonEmptyContent: boolean;
  modifiedAtMs: number | null;
  contentFingerprint: string | null;
}

interface FlowPromptWorkspaceContext {
  metadata: WorkspaceMetadata;
  runtime: Runtime;
  workspacePath: string;
  promptPath: string;
}

function joinForRuntime(runtimeConfig: RuntimeConfig | undefined, ...parts: string[]): string {
  const usePosix = runtimeConfig?.type === "ssh" || runtimeConfig?.type === "docker";
  return usePosix ? path.posix.join(...parts) : path.join(...parts);
}

function computeFingerprint(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isHostWritableRuntime(runtimeConfig: RuntimeConfig | undefined): boolean {
  return runtimeConfig?.type !== "ssh" && runtimeConfig?.type !== "docker";
}

function isErrnoWithCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

const MISSING_FILE_ERROR_PATTERN =
  /ENOENT|ENOTDIR|No such file or directory|Not a directory|cannot statx?|can't open .*No such file or directory/i;

function isMissingFileError(error: unknown): boolean {
  if (isErrnoWithCode(error, "ENOENT") || isErrnoWithCode(error, "ENOTDIR")) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  if (
    isErrnoWithCode((error as Error & { cause?: unknown }).cause, "ENOENT") ||
    isErrnoWithCode((error as Error & { cause?: unknown }).cause, "ENOTDIR")
  ) {
    return true;
  }

  return MISSING_FILE_ERROR_PATTERN.test(error.message);
}

function areFlowPromptStatesEqual(a: FlowPromptState | null, b: FlowPromptState): boolean {
  if (!a) {
    return false;
  }

  return (
    a.workspaceId === b.workspaceId &&
    a.path === b.path &&
    a.exists === b.exists &&
    a.hasNonEmptyContent === b.hasNonEmptyContent &&
    a.modifiedAtMs === b.modifiedAtMs &&
    a.contentFingerprint === b.contentFingerprint &&
    a.lastEnqueuedFingerprint === b.lastEnqueuedFingerprint &&
    a.isCurrentVersionEnqueued === b.isCurrentVersionEnqueued &&
    a.hasPendingUpdate === b.hasPendingUpdate &&
    a.autoSendMode === b.autoSendMode &&
    a.nextHeadingContent === b.nextHeadingContent &&
    a.updatePreviewText === b.updatePreviewText
  );
}

export interface FlowPromptChatSubscriptionEvent {
  workspaceId: string;
  activeCount: number;
  change: "started" | "ended";
  atMs: number;
}

export interface FlowPromptMonitorEventSource {
  on(
    event: "activity",
    listener: (event: { workspaceId: string; activity: WorkspaceActivitySnapshot | null }) => void
  ): this;
  on(event: "chatSubscription", listener: (event: FlowPromptChatSubscriptionEvent) => void): this;
  off(
    event: "activity",
    listener: (event: { workspaceId: string; activity: WorkspaceActivitySnapshot | null }) => void
  ): this;
  off(event: "chatSubscription", listener: (event: FlowPromptChatSubscriptionEvent) => void): this;
}

export function getFlowPromptPollIntervalMs(params: {
  hasActiveChatSubscription: boolean;
  lastRelevantUsageAtMs: number | null;
  nowMs?: number;
}): number | null {
  if (params.hasActiveChatSubscription) {
    return FLOW_PROMPT_ACTIVE_POLL_INTERVAL_MS;
  }

  if (params.lastRelevantUsageAtMs == null) {
    return null;
  }

  const ageMs = (params.nowMs ?? Date.now()) - params.lastRelevantUsageAtMs;
  if (ageMs > FLOW_PROMPT_RECENT_WINDOW_MS) {
    return null;
  }

  return FLOW_PROMPT_RECENT_POLL_INTERVAL_MS;
}

function getFlowPromptNextHeadingContent(content: string): string | null {
  const nextHeadingContent =
    extractHeadingSection(content, "Next")?.trim() ??
    extractHeadingSection(content, "Next:")?.trim() ??
    "";
  return nextHeadingContent.length > 0 ? nextHeadingContent : null;
}

function buildFlowPromptNextHeadingSection(nextHeadingContent: string | null | undefined): string {
  const trimmedNextHeadingContent = nextHeadingContent?.trim() ?? "";
  if (trimmedNextHeadingContent.length === 0) {
    return "";
  }

  return `\n\nCurrent Next heading:\n\`\`\`md\n${trimmedNextHeadingContent}\n\`\`\``;
}

export function buildFlowPromptUpdateMessage(params: {
  path: string;
  previousContent: string;
  nextContent: string;
  nextHeadingContent?: string | null;
}): string {
  const markerLine = getFlowPromptPathMarkerLine(params.path);
  const nextHeadingSection = buildFlowPromptNextHeadingSection(params.nextHeadingContent);
  const previousTrimmed = params.previousContent.trim();
  const nextTrimmed = params.nextContent.trim();

  if (nextTrimmed.length === 0) {
    return `[Flow prompt updated. Follow current agent instructions.]

${markerLine}${nextHeadingSection}

The flow prompt file is now empty. Stop relying on any prior flow prompt instructions from that file unless the user saves new content.`;
  }

  const diff = generateDiff(params.path, params.previousContent, params.nextContent);
  const shouldSendDiff =
    previousTrimmed.length > 0 &&
    diff.length <= MAX_FLOW_PROMPT_DIFF_CHARS &&
    diff.length < params.nextContent.length * 1.5;

  if (shouldSendDiff) {
    return `[Flow prompt updated. Follow current agent instructions.]

${markerLine}${nextHeadingSection}

Latest flow prompt changes:
\`\`\`diff
${diff}
\`\`\``;
  }

  return `[Flow prompt updated. Follow current agent instructions.]

${markerLine}${nextHeadingSection}

Current flow prompt contents:
\`\`\`md
${params.nextContent}
\`\`\``;
}

export function buildFlowPromptAttachMessage(params: {
  path: string;
  previousContent: string;
  nextContent: string;
}): string {
  const prefix = `Re the live prompt in ${params.path}:`;
  const nextHeadingSection = buildFlowPromptNextHeadingSection(
    getFlowPromptNextHeadingContent(params.nextContent)
  );
  const previousTrimmed = params.previousContent.trim();
  const nextTrimmed = params.nextContent.trim();

  if (nextTrimmed.length === 0 && previousTrimmed.length > 0) {
    return `${prefix}${nextHeadingSection}\n\nThe flow prompt file is now empty. Stop relying on any prior flow prompt instructions from that file unless I save new content.`;
  }

  if (nextTrimmed.length === 0) {
    return `${prefix}\n`;
  }

  const diff = generateDiff(params.path, params.previousContent, params.nextContent);
  const shouldSendDiff =
    previousTrimmed.length > 0 &&
    diff.length <= MAX_FLOW_PROMPT_DIFF_CHARS &&
    diff.length < params.nextContent.length * 1.5;

  if (shouldSendDiff) {
    return `${prefix}${nextHeadingSection}\n\nLatest flow prompt changes:\n\`\`\`diff\n${diff}\n\`\`\``;
  }

  return `${prefix}\n`;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface WorkspaceFlowPromptService {
  on(
    event: "state",
    listener: (event: { workspaceId: string; state: FlowPromptState }) => void
  ): this;
  on(event: "update", listener: (event: FlowPromptUpdateRequest) => void): this;
  emit(event: "state", eventData: { workspaceId: string; state: FlowPromptState }): boolean;
  emit(event: "update", eventData: FlowPromptUpdateRequest): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class WorkspaceFlowPromptService extends EventEmitter {
  private readonly workspaceContextCache = new Map<string, FlowPromptWorkspaceContext>();
  private readonly monitors = new Map<string, FlowPromptMonitor>();
  private readonly activityRecencyByWorkspaceId = new Map<string, number | null>();
  private readonly rememberedUpdates = new Map<string, Map<string, string>>();
  private detachEventSource: (() => void) | null = null;

  constructor(private readonly config: Config) {
    super();
  }

  attachEventSource(source: FlowPromptMonitorEventSource): void {
    this.detachEventSource?.();

    const onActivity = (event: {
      workspaceId: string;
      activity: WorkspaceActivitySnapshot | null;
    }) => {
      const recencyAtMs = event.activity?.recency ?? null;
      const previousRecencyAtMs = this.activityRecencyByWorkspaceId.get(event.workspaceId) ?? null;
      const mergedRecencyAtMs = Math.max(previousRecencyAtMs ?? 0, recencyAtMs ?? 0) || null;
      this.activityRecencyByWorkspaceId.set(event.workspaceId, mergedRecencyAtMs);

      const monitor = this.monitors.get(event.workspaceId);
      if (!monitor) {
        return;
      }

      monitor.lastKnownActivityAtMs =
        Math.max(monitor.lastKnownActivityAtMs ?? 0, recencyAtMs ?? 0) || null;
      this.scheduleNextRefresh(event.workspaceId);
    };

    const onChatSubscription = (event: FlowPromptChatSubscriptionEvent) => {
      const monitor = this.monitors.get(event.workspaceId);
      if (!monitor) {
        return;
      }

      monitor.activeChatSubscriptions = event.activeCount;
      if (event.change === "started") {
        monitor.lastOpenedAtMs = event.atMs;
        // Flow Prompting reads through runtime abstractions for SSH/Docker/devcontainer
        // workspaces, so reopening the selected workspace should pick up saved prompt
        // changes immediately instead of waiting for a slower background poll.
        this.refreshMonitorInBackground(event.workspaceId, { reschedule: true });
        return;
      }

      this.scheduleNextRefresh(event.workspaceId);
    };

    source.on("activity", onActivity);
    source.on("chatSubscription", onChatSubscription);
    this.detachEventSource = () => {
      source.off("activity", onActivity);
      source.off("chatSubscription", onChatSubscription);
    };
  }

  async getState(workspaceId: string): Promise<FlowPromptState> {
    return this.refreshMonitor(workspaceId, false);
  }

  async isCurrentFingerprint(workspaceId: string, fingerprint: string): Promise<boolean> {
    const snapshot = await this.readPromptSnapshot(workspaceId);
    const currentFingerprint = snapshot.contentFingerprint ?? computeFingerprint(snapshot.content);
    return currentFingerprint === fingerprint;
  }

  async ensurePromptFile(workspaceId: string): Promise<FlowPromptState> {
    const context = await this.getWorkspaceContext(workspaceId);
    if (!context) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    await context.runtime.ensureDir(
      joinForRuntime(context.metadata.runtimeConfig, context.workspacePath, FLOW_PROMPTS_DIR)
    );

    try {
      const stat = await context.runtime.stat(context.promptPath);
      if (stat.isDirectory) {
        await this.deleteFile(
          context.runtime,
          context.metadata.runtimeConfig,
          context.workspacePath,
          context.promptPath,
          { recursive: true }
        );
        await writeFileString(context.runtime, context.promptPath, "");
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
      await writeFileString(context.runtime, context.promptPath, "");
    }

    return this.refreshMonitor(workspaceId, true);
  }

  async deletePromptFile(workspaceId: string): Promise<void> {
    const context = await this.getWorkspaceContext(workspaceId);
    if (!context) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    await this.deleteFile(
      context.runtime,
      context.metadata.runtimeConfig,
      context.workspacePath,
      context.promptPath
    );
    const monitor = this.monitors.get(workspaceId);
    if (monitor) {
      monitor.pendingFingerprint = null;
    }
    await this.refreshMonitor(workspaceId, true);
  }

  async setAutoSendMode(
    workspaceId: string,
    mode: FlowPromptAutoSendMode,
    options?: { clearPending?: boolean }
  ): Promise<FlowPromptState> {
    const persisted = await this.readPersistedState(workspaceId);
    await this.writePersistedState(workspaceId, {
      ...persisted,
      autoSendMode: mode,
    });

    const monitor = this.monitors.get(workspaceId);
    if (options?.clearPending && monitor) {
      monitor.pendingFingerprint = null;
    }

    // Auto-send mode lives beside the last-sent fingerprint in the session sidecar because
    // file watching happens in the backend; the watcher needs the current preference even
    // when the user changes it from the browser without another manual send.
    return this.refreshMonitor(workspaceId, true);
  }

  async getCurrentUpdate(workspaceId: string): Promise<FlowPromptUpdateRequest | null> {
    const snapshot = await this.readPromptSnapshot(workspaceId);
    const persisted = await this.readPersistedState(workspaceId);
    const pendingFingerprint = this.monitors.get(workspaceId)?.pendingFingerprint ?? null;
    const state = this.buildState(snapshot, persisted, pendingFingerprint);
    return this.buildCurrentUpdate(snapshot, persisted, state);
  }

  async getAttachDraft(workspaceId: string): Promise<FlowPromptAttachDraft | null> {
    const snapshot = await this.readPromptSnapshot(workspaceId);
    const persisted = await this.readPersistedState(workspaceId);
    const hasReferenceablePrompt = snapshot.exists || persisted.lastSentFingerprint != null;
    if (!hasReferenceablePrompt || snapshot.path.trim().length === 0) {
      return null;
    }

    const fingerprint = snapshot.contentFingerprint ?? computeFingerprint(snapshot.content);
    this.rememberUpdate(workspaceId, fingerprint, snapshot.content);

    return {
      text: buildFlowPromptAttachMessage({
        path: snapshot.path,
        previousContent: persisted.lastSentContent ?? "",
        nextContent: snapshot.content,
      }),
      flowPromptAttachment: {
        path: snapshot.path,
        fingerprint,
      },
    };
  }

  async renamePromptFile(
    workspaceId: string,
    oldMetadata: WorkspaceMetadata,
    newMetadata: WorkspaceMetadata
  ): Promise<void> {
    const oldContext = this.getWorkspaceContextFromMetadata(oldMetadata);
    const newContext = this.getWorkspaceContextFromMetadata(newMetadata);
    const renamedWorkspacePromptPath = joinForRuntime(
      newMetadata.runtimeConfig,
      newContext.workspacePath,
      getFlowPromptRelativePath(oldMetadata.name)
    );

    if (renamedWorkspacePromptPath === newContext.promptPath) {
      await this.refreshMonitor(workspaceId, true);
      return;
    }

    try {
      const content = await readFileString(newContext.runtime, renamedWorkspacePromptPath);
      await writeFileString(newContext.runtime, newContext.promptPath, content);
      await this.deleteFile(
        newContext.runtime,
        newContext.metadata.runtimeConfig,
        newContext.workspacePath,
        renamedWorkspacePromptPath
      );
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }

      try {
        const content = await readFileString(oldContext.runtime, oldContext.promptPath);
        await writeFileString(newContext.runtime, newContext.promptPath, content);
        await this.deleteFile(
          oldContext.runtime,
          oldContext.metadata.runtimeConfig,
          oldContext.workspacePath,
          oldContext.promptPath
        );
      } catch (fallbackError) {
        if (!isMissingFileError(fallbackError)) {
          throw fallbackError;
        }
        // No prompt file to rename.
      }
    }

    this.workspaceContextCache.delete(workspaceId);
    await this.refreshMonitor(workspaceId, true);
  }

  async copyPromptFile(
    sourceMetadata: WorkspaceMetadata,
    targetMetadata: WorkspaceMetadata
  ): Promise<void> {
    const sourceContext = this.getWorkspaceContextFromMetadata(sourceMetadata);
    const targetContext = this.getWorkspaceContextFromMetadata(targetMetadata);

    let content: string;
    try {
      content = await readFileString(sourceContext.runtime, sourceContext.promptPath);
    } catch (error) {
      if (isMissingFileError(error)) {
        return;
      }
      throw error;
    }

    await writeFileString(targetContext.runtime, targetContext.promptPath, content);
  }

  startMonitoring(workspaceId: string): void {
    if (this.monitors.has(workspaceId)) {
      return;
    }

    this.monitors.set(workspaceId, {
      timer: null,
      stopped: false,
      refreshing: false,
      refreshPromise: null,
      queuedRefresh: false,
      queuedRefreshEmitEvents: false,
      pendingFingerprint: null,
      inFlightFingerprint: null,
      lastState: null,
      activeChatSubscriptions: 0,
      lastOpenedAtMs: null,
      lastKnownActivityAtMs: this.activityRecencyByWorkspaceId.get(workspaceId) ?? null,
    });

    this.refreshMonitorInBackground(workspaceId, { reschedule: true });
  }

  stopMonitoring(workspaceId: string): void {
    const monitor = this.monitors.get(workspaceId);
    if (!monitor) {
      return;
    }

    monitor.stopped = true;
    if (monitor.timer) {
      clearTimeout(monitor.timer);
    }
    this.monitors.delete(workspaceId);
    this.rememberedUpdates.delete(workspaceId);
    this.workspaceContextCache.delete(workspaceId);
  }

  markPendingUpdate(workspaceId: string, nextContent: string): void {
    const monitor = this.monitors.get(workspaceId);
    if (!monitor) {
      return;
    }

    monitor.pendingFingerprint = computeFingerprint(nextContent);
    this.refreshMonitorInBackground(workspaceId);
  }

  clearPendingUpdate(workspaceId: string, fingerprint?: string): void {
    const monitor = this.monitors.get(workspaceId);
    const pendingFingerprint = monitor?.pendingFingerprint;
    if (pendingFingerprint == null || !monitor) {
      return;
    }

    if (fingerprint != null && pendingFingerprint !== fingerprint) {
      return;
    }

    monitor.pendingFingerprint = null;
    this.refreshMonitorInBackground(workspaceId);
  }

  markInFlightUpdate(workspaceId: string, fingerprint: string): void {
    const monitor = this.monitors.get(workspaceId);
    if (!monitor) {
      return;
    }

    monitor.inFlightFingerprint = fingerprint;
    this.refreshMonitorInBackground(workspaceId);
  }

  clearInFlightUpdate(workspaceId: string, fingerprint?: string): void {
    const monitor = this.monitors.get(workspaceId);
    if (!monitor) {
      return;
    }

    if (fingerprint && monitor.inFlightFingerprint !== fingerprint) {
      return;
    }

    monitor.inFlightFingerprint = null;
    this.refreshMonitorInBackground(workspaceId);
  }

  rememberUpdate(workspaceId: string, fingerprint: string, nextContent: string): void {
    let updatesForWorkspace = this.rememberedUpdates.get(workspaceId);
    if (!updatesForWorkspace) {
      updatesForWorkspace = new Map<string, string>();
      this.rememberedUpdates.set(workspaceId, updatesForWorkspace);
    }

    const supersededPendingFingerprint = this.monitors.get(workspaceId)?.pendingFingerprint ?? null;
    if (supersededPendingFingerprint && supersededPendingFingerprint !== fingerprint) {
      updatesForWorkspace.delete(supersededPendingFingerprint);
    }

    updatesForWorkspace.set(fingerprint, nextContent);

    // Flow Prompting only ever needs to remember the accepted in-flight revision plus the
    // latest queued revision. Older queued saves are overwritten before they can be sent.
    while (updatesForWorkspace.size > 2) {
      const oldestFingerprint = updatesForWorkspace.keys().next().value;
      if (typeof oldestFingerprint !== "string") {
        break;
      }
      updatesForWorkspace.delete(oldestFingerprint);
    }
  }

  forgetUpdate(workspaceId: string, fingerprint: string): void {
    const updatesForWorkspace = this.rememberedUpdates.get(workspaceId);
    if (!updatesForWorkspace) {
      return;
    }

    updatesForWorkspace.delete(fingerprint);
    if (updatesForWorkspace.size === 0) {
      this.rememberedUpdates.delete(workspaceId);
    }
  }

  async markAcceptedUpdateByFingerprint(workspaceId: string, fingerprint: string): Promise<void> {
    const rememberedContent = this.rememberedUpdates.get(workspaceId)?.get(fingerprint) ?? null;
    if (rememberedContent != null) {
      await this.markAcceptedUpdate(workspaceId, rememberedContent);
      this.forgetUpdate(workspaceId, fingerprint);
      return;
    }

    const snapshot = await this.readPromptSnapshot(workspaceId);
    if (snapshot.contentFingerprint === fingerprint) {
      await this.markAcceptedUpdate(workspaceId, snapshot.content);
    }
  }

  async markAcceptedUpdate(workspaceId: string, nextContent: string): Promise<void> {
    const monitor = this.monitors.get(workspaceId);
    const nextFingerprint = computeFingerprint(nextContent);
    const persisted = await this.readPersistedState(workspaceId);

    await this.writePersistedState(workspaceId, {
      ...persisted,
      lastSentContent: nextContent,
      lastSentFingerprint: nextFingerprint,
    });

    if (monitor?.pendingFingerprint === nextFingerprint) {
      monitor.pendingFingerprint = null;
    }
    if (monitor?.inFlightFingerprint === nextFingerprint) {
      monitor.inFlightFingerprint = null;
    }

    await this.refreshMonitor(workspaceId, true);
  }

  private refreshMonitorInBackground(
    workspaceId: string,
    options?: { reschedule?: boolean }
  ): void {
    void this.refreshMonitor(workspaceId, true)
      .catch((error) => {
        log.error("Failed to refresh Flow Prompting state", {
          workspaceId,
          error: getErrorMessage(error),
        });
      })
      .finally(() => {
        if (options?.reschedule) {
          this.scheduleNextRefresh(workspaceId);
        }
      });
  }

  private clearScheduledRefresh(monitor: FlowPromptMonitor): void {
    if (!monitor.timer) {
      return;
    }

    clearTimeout(monitor.timer);
    monitor.timer = null;
  }

  private scheduleNextRefresh(workspaceId: string): void {
    const monitor = this.monitors.get(workspaceId);
    if (!monitor || monitor.stopped) {
      return;
    }

    this.clearScheduledRefresh(monitor);

    const intervalMs = getFlowPromptPollIntervalMs({
      hasActiveChatSubscription: monitor.activeChatSubscriptions > 0,
      lastRelevantUsageAtMs: this.getLastRelevantUsageAtMs(monitor),
    });
    if (intervalMs == null) {
      return;
    }

    monitor.timer = setTimeout(() => {
      monitor.timer = null;
      this.refreshMonitorInBackground(workspaceId, { reschedule: true });
    }, intervalMs);
    monitor.timer.unref?.();
  }

  private async refreshMonitor(workspaceId: string, emitEvents: boolean): Promise<FlowPromptState> {
    const monitor = this.monitors.get(workspaceId);
    if (monitor?.refreshing) {
      const shouldQueueFollowUpRefresh = emitEvents || monitor.lastState == null;
      if (shouldQueueFollowUpRefresh) {
        // A save can land while an earlier prompt read is still in flight. Queue one immediate
        // follow-up refresh so the first save still updates the composer preview instead of
        // waiting for the user to save again.
        monitor.queuedRefresh = true;
        monitor.queuedRefreshEmitEvents ||= emitEvents;
      }
      if (monitor.refreshPromise) {
        return monitor.refreshPromise;
      }
      return monitor.lastState ?? this.computeStateFromScratch(workspaceId);
    }

    if (monitor) {
      monitor.refreshing = true;
      monitor.queuedRefresh = false;
      monitor.queuedRefreshEmitEvents = false;
    }

    const refreshPromise = (async () => {
      let shouldEmitEvents = emitEvents;

      while (true) {
        const snapshot = await this.readPromptSnapshot(workspaceId);
        const persisted = await this.readPersistedState(workspaceId);

        const currentFingerprint =
          snapshot.contentFingerprint ?? computeFingerprint(snapshot.content);
        if (monitor && currentFingerprint !== monitor.pendingFingerprint) {
          const shouldClearPending = currentFingerprint === persisted.lastSentFingerprint;
          if (shouldClearPending) {
            monitor.pendingFingerprint = null;
          }
        }

        const pendingFingerprint = monitor?.pendingFingerprint ?? null;
        const inFlightFingerprint = monitor?.inFlightFingerprint ?? null;
        const state = this.buildState(snapshot, persisted, pendingFingerprint);
        const currentUpdate = this.buildCurrentUpdate(snapshot, persisted, state);

        if (monitor) {
          const shouldEmitState =
            shouldEmitEvents && !areFlowPromptStatesEqual(monitor.lastState, state);
          monitor.lastState = state;
          if (shouldEmitState) {
            this.emit("state", { workspaceId, state });
          }
        }

        if (
          shouldEmitEvents &&
          currentUpdate &&
          this.shouldEmitUpdate(
            persisted,
            pendingFingerprint,
            inFlightFingerprint,
            currentUpdate.nextFingerprint
          )
        ) {
          this.emit("update", currentUpdate);
        }

        const shouldRefreshAgain = monitor?.queuedRefresh === true;
        shouldEmitEvents ||= monitor?.queuedRefreshEmitEvents === true;
        if (monitor) {
          monitor.queuedRefresh = false;
          monitor.queuedRefreshEmitEvents = false;
        }

        if (!shouldRefreshAgain) {
          return state;
        }
      }
    })();

    if (monitor) {
      monitor.refreshPromise = refreshPromise;
    }

    try {
      return await refreshPromise;
    } finally {
      if (monitor) {
        monitor.refreshPromise = null;
        monitor.refreshing = false;
      }
    }
  }

  private async computeStateFromScratch(workspaceId: string): Promise<FlowPromptState> {
    const snapshot = await this.readPromptSnapshot(workspaceId);
    const persisted = await this.readPersistedState(workspaceId);
    return this.buildState(snapshot, persisted, null);
  }

  private shouldEmitUpdate(
    persisted: PersistedFlowPromptState,
    pendingFingerprint: string | null,
    inFlightFingerprint: string | null,
    currentFingerprint: string
  ): boolean {
    return (
      persisted.autoSendMode === "end-of-turn" &&
      pendingFingerprint !== currentFingerprint &&
      inFlightFingerprint !== currentFingerprint
    );
  }

  private buildCurrentUpdatePayload(
    snapshot: FlowPromptFileSnapshot,
    persisted: PersistedFlowPromptState,
    nextHeadingContent: string | null = getFlowPromptNextHeadingContent(snapshot.content)
  ): { nextFingerprint: string; previewText: string; sendText: string } | null {
    const previousTrimmed = (persisted.lastSentContent ?? "").trim();
    const nextFingerprint = snapshot.contentFingerprint ?? computeFingerprint(snapshot.content);

    if (persisted.lastSentFingerprint === nextFingerprint) {
      return null;
    }

    if (!snapshot.hasNonEmptyContent && previousTrimmed.length === 0) {
      return null;
    }

    return {
      nextFingerprint,
      previewText: buildFlowPromptUpdateMessage({
        path: snapshot.path,
        previousContent: persisted.lastSentContent ?? "",
        nextContent: snapshot.content,
      }),
      sendText: buildFlowPromptUpdateMessage({
        path: snapshot.path,
        previousContent: persisted.lastSentContent ?? "",
        nextContent: snapshot.content,
        nextHeadingContent,
      }),
    };
  }

  private buildCurrentUpdate(
    snapshot: FlowPromptFileSnapshot,
    persisted: PersistedFlowPromptState,
    state: FlowPromptState
  ): FlowPromptUpdateRequest | null {
    const payload = this.buildCurrentUpdatePayload(snapshot, persisted);
    if (!payload) {
      return null;
    }

    return {
      workspaceId: snapshot.workspaceId,
      path: snapshot.path,
      nextContent: snapshot.content,
      nextFingerprint: payload.nextFingerprint,
      text: payload.sendText,
      state,
    };
  }

  private buildState(
    snapshot: FlowPromptFileSnapshot,
    persisted: PersistedFlowPromptState,
    pendingFingerprint: string | null
  ): FlowPromptState {
    const lastEnqueuedFingerprint = pendingFingerprint ?? persisted.lastSentFingerprint;
    const currentSnapshotFingerprint =
      snapshot.contentFingerprint ?? computeFingerprint(snapshot.content);
    const hasPendingUpdate =
      pendingFingerprint != null && pendingFingerprint === currentSnapshotFingerprint;
    const nextHeadingContent = getFlowPromptNextHeadingContent(snapshot.content);
    const currentUpdatePayload = this.buildCurrentUpdatePayload(
      snapshot,
      persisted,
      nextHeadingContent
    );

    return {
      workspaceId: snapshot.workspaceId,
      path: snapshot.path,
      exists: snapshot.exists,
      hasNonEmptyContent: snapshot.hasNonEmptyContent,
      modifiedAtMs: snapshot.modifiedAtMs,
      contentFingerprint: snapshot.contentFingerprint,
      lastEnqueuedFingerprint,
      isCurrentVersionEnqueued:
        snapshot.contentFingerprint != null &&
        snapshot.contentFingerprint === lastEnqueuedFingerprint,
      hasPendingUpdate,
      autoSendMode: persisted.autoSendMode,
      nextHeadingContent,
      updatePreviewText: currentUpdatePayload?.previewText ?? null,
    };
  }

  private getLastRelevantUsageAtMs(monitor: FlowPromptMonitor): number | null {
    const latestUsageAtMs = Math.max(
      monitor.lastKnownActivityAtMs ?? 0,
      monitor.lastOpenedAtMs ?? 0
    );
    return latestUsageAtMs > 0 ? latestUsageAtMs : null;
  }

  private async readPromptSnapshot(workspaceId: string): Promise<FlowPromptFileSnapshot> {
    const context = await this.getWorkspaceContext(workspaceId);
    const buildMissingSnapshot = (promptPath: string): FlowPromptFileSnapshot => ({
      workspaceId,
      path: promptPath,
      exists: false,
      content: "",
      hasNonEmptyContent: false,
      modifiedAtMs: null,
      contentFingerprint: null,
    });

    if (!context) {
      return buildMissingSnapshot("");
    }

    let stat;
    try {
      stat = await context.runtime.stat(context.promptPath);
    } catch (error) {
      if (isMissingFileError(error)) {
        return buildMissingSnapshot(context.promptPath);
      }
      throw error;
    }

    if (stat.isDirectory) {
      return buildMissingSnapshot(context.promptPath);
    }

    try {
      const content = await readFileString(context.runtime, context.promptPath);
      return {
        workspaceId,
        path: context.promptPath,
        exists: true,
        content,
        hasNonEmptyContent: content.trim().length > 0,
        modifiedAtMs: stat.modifiedTime.getTime(),
        contentFingerprint: computeFingerprint(content),
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        return buildMissingSnapshot(context.promptPath);
      }
      throw error;
    }
  }

  private async getWorkspaceContext(
    workspaceId: string
  ): Promise<FlowPromptWorkspaceContext | null> {
    const cachedContext = this.workspaceContextCache.get(workspaceId);
    if (cachedContext) {
      return cachedContext;
    }

    const metadata = await this.getWorkspaceMetadata(workspaceId);
    if (!metadata) {
      return null;
    }

    try {
      const context = this.getWorkspaceContextFromMetadata(metadata);
      this.workspaceContextCache.set(workspaceId, context);
      return context;
    } catch (error) {
      if (error instanceof TypeError) {
        return null;
      }
      throw error;
    }
  }

  private getWorkspaceContextFromMetadata(metadata: WorkspaceMetadata): FlowPromptWorkspaceContext {
    const runtime = createRuntimeForWorkspace(metadata);
    const workspacePath =
      metadata.projectPath === metadata.name
        ? metadata.projectPath
        : runtime.getWorkspacePath(metadata.projectPath, metadata.name);
    const promptPath = joinForRuntime(
      metadata.runtimeConfig,
      workspacePath,
      getFlowPromptRelativePath(metadata.name)
    );

    return { metadata, runtime, workspacePath, promptPath };
  }

  private async getWorkspaceMetadata(workspaceId: string): Promise<WorkspaceMetadata | null> {
    if (typeof this.config.getAllWorkspaceMetadata !== "function") {
      return null;
    }

    const allMetadata = await this.config.getAllWorkspaceMetadata();
    return allMetadata.find((entry) => entry.id === workspaceId) ?? null;
  }

  private getPersistedStatePath(workspaceId: string): string {
    return path.join(this.config.getSessionDir(workspaceId), FLOW_PROMPT_STATE_FILE);
  }

  private async readPersistedState(workspaceId: string): Promise<PersistedFlowPromptState> {
    const statePath = this.getPersistedStatePath(workspaceId);
    try {
      const raw = await fsPromises.readFile(statePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<PersistedFlowPromptState>;
      return {
        lastSentContent: typeof parsed.lastSentContent === "string" ? parsed.lastSentContent : null,
        lastSentFingerprint:
          typeof parsed.lastSentFingerprint === "string" ? parsed.lastSentFingerprint : null,
        autoSendMode:
          parsed.autoSendMode === "end-of-turn"
            ? "end-of-turn"
            : DEFAULT_FLOW_PROMPT_AUTO_SEND_MODE,
      };
    } catch {
      return {
        lastSentContent: null,
        lastSentFingerprint: null,
        autoSendMode: DEFAULT_FLOW_PROMPT_AUTO_SEND_MODE,
      };
    }
  }

  private async writePersistedState(
    workspaceId: string,
    state: PersistedFlowPromptState
  ): Promise<void> {
    const statePath = this.getPersistedStatePath(workspaceId);
    await fsPromises.mkdir(path.dirname(statePath), { recursive: true });
    await fsPromises.writeFile(statePath, JSON.stringify(state), "utf-8");
  }

  private async deleteFile(
    runtime: Runtime,
    runtimeConfig: RuntimeConfig | undefined,
    workspacePath: string,
    filePath: string,
    options?: { recursive?: boolean }
  ): Promise<void> {
    const recursive = options?.recursive === true;
    if (isHostWritableRuntime(runtimeConfig)) {
      await fsPromises.rm(expandTilde(filePath), { recursive, force: true });
      return;
    }

    const resolvedFilePath = await runtime.resolvePath(filePath);
    const command = recursive
      ? `rm -rf ${shellQuote(resolvedFilePath)}`
      : `rm -f ${shellQuote(resolvedFilePath)}`;
    const result = await execBuffered(runtime, command, {
      cwd: workspacePath,
      timeout: 10,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.trim() || result.stdout.trim() || `Failed to delete ${filePath}`
      );
    }
  }
}

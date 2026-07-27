import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import * as fs from "fs/promises";
import * as path from "path";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { TIMELINE_FILE_NAME } from "@/common/constants/paths";
import {
  TimelineEventSchema,
  type TimelineAnchor,
  type TimelineEvent,
  type TimelineEventDraft,
  type TimelineListInput,
  type TimelinePage,
  type TimelinePreview,
} from "@/common/orpc/schemas/timeline";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import type { MuxMessage, MuxToolPart } from "@/common/types/message";
import type { Config } from "@/node/config";
import type { ExperimentsService } from "@/node/services/experimentsService";
import type { HistoryService } from "@/node/services/historyService";
import { log } from "@/node/services/log";
import {
  createTimelineMapperState,
  mapChatEventToTimeline,
  type TimelineMapperState,
} from "@/node/services/timelineMapper";
import { isFailedToolCallResult } from "@/node/services/timelineNotability";
import { isErrnoWithCode } from "@/node/utils/fs";
import type { TimelineRecorder } from "@/node/services/timelineRecorder";
import type { WorkspaceService } from "@/node/services/workspaceService";

export const TIMELINE_DEFAULT_PAGE_LIMIT = 50;
const REVERSE_READ_CHUNK_SIZE = 256 * 1024;
const RECENT_SOURCE_KEY_LIMIT = 1_000;

type TimelineAppendedListener = (event: { workspaceId: string; events: TimelineEvent[] }) => void;

export class TimelineService implements TimelineRecorder {
  private readonly events = new EventEmitter();
  private readonly config: Pick<Config, "getSessionDir">;
  private readonly historyService: HistoryService;
  private readonly experimentsService: Pick<ExperimentsService, "isExperimentEnabled">;
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly nextSequences = new Map<string, number>();
  private readonly recentSourceKeys = new Map<string, Map<string, true>>();
  private mapperState: TimelineMapperState = createTimelineMapperState();

  constructor(
    config: Pick<Config, "getSessionDir">,
    historyService: HistoryService,
    experimentsService: Pick<ExperimentsService, "isExperimentEnabled">
  ) {
    this.config = config;
    this.historyService = historyService;
    this.experimentsService = experimentsService;
  }

  record(workspaceId: string, draft: TimelineEventDraft): void {
    if (!this.experimentsService.isExperimentEnabled(EXPERIMENT_IDS.TIMELINE)) {
      return;
    }

    const sourceKey = draft.source.key;
    if (sourceKey != null && this.hasRecentSourceKey(workspaceId, sourceKey)) {
      return;
    }
    if (sourceKey != null) {
      this.rememberSourceKey(workspaceId, sourceKey);
    }

    this.enqueueWrite(workspaceId, async () => {
      const seq = await this.takeNextSequence(workspaceId);
      const event = TimelineEventSchema.parse({
        ...draft,
        v: 1,
        seq,
        id: randomUUID(),
        ts: draft.ts ?? Date.now(),
      });
      const filePath = this.getFilePath(workspaceId);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, "utf-8");
      this.events.emit("appended", { workspaceId, events: [event] });
    });
  }

  async flush(workspaceId?: string): Promise<void> {
    if (workspaceId != null) {
      await (this.writeQueues.get(workspaceId) ?? Promise.resolve());
      return;
    }
    await Promise.all(this.writeQueues.values());
  }

  async list(workspaceId: string, input: TimelineListInput = {}): Promise<TimelinePage> {
    const limit = input.limit ?? TIMELINE_DEFAULT_PAGE_LIMIT;
    const events: TimelineEvent[] = [];
    let hasOlder = false;

    await this.readLinesBackward(this.getFilePath(workspaceId), (line) => {
      let parsed: TimelineEvent;
      try {
        parsed = TimelineEventSchema.parse(JSON.parse(line));
      } catch {
        return true;
      }

      if (input.cursor != null && parsed.seq >= input.cursor) {
        return true;
      }
      if (events.length < limit) {
        events.push(parsed);
        return true;
      }

      hasOlder = true;
      return false;
    });

    return {
      events,
      nextCursor: hasOlder && events.length > 0 ? events[events.length - 1].seq : null,
      hasOlder,
    };
  }

  async getLastSequence(workspaceId: string): Promise<number> {
    await this.flush(workspaceId);
    return this.readLastSequence(workspaceId);
  }

  async previewAnchor(
    workspaceId: string,
    anchor: TimelineAnchor
  ): Promise<TimelinePreview | null> {
    let preview: TimelinePreview | null = null;
    const result = await this.historyService.iterateFullHistory(
      workspaceId,
      "backward",
      (messages) => {
        for (const message of messages) {
          if (!this.matchesMessageAnchor(message, anchor)) {
            continue;
          }
          preview = this.createPreview(message, anchor);
          if (preview != null) {
            return false;
          }
        }
        return true;
      }
    );
    if (!result.success) {
      log.warn("Failed to preview timeline anchor", {
        workspaceId,
        anchor,
        error: result.error,
      });
    }
    return preview;
  }

  on(event: "appended", listener: TimelineAppendedListener): this {
    this.events.on(event, listener);
    return this;
  }

  off(event: "appended", listener: TimelineAppendedListener): this {
    this.events.off(event, listener);
    return this;
  }

  subscribeToWorkspace(workspaceService: WorkspaceService): () => void {
    const chatListener = (event: { workspaceId: string; message: WorkspaceChatMessage }) => {
      const mapped = mapChatEventToTimeline(event.message, this.mapperState, Date.now());
      this.mapperState = mapped.state;
      for (const draft of mapped.drafts) {
        this.record(event.workspaceId, draft);
      }
    };
    const metadataListener = (event: { workspaceId: string; metadata: unknown }) => {
      if (event.metadata !== null) {
        return;
      }
      const cleanup = this.flush(event.workspaceId).then(() =>
        this.clearWorkspaceCaches(event.workspaceId)
      );
      cleanup.catch((error: unknown) => {
        log.warn("Failed to clear timeline workspace caches", {
          workspaceId: event.workspaceId,
          error,
        });
      });
    };
    workspaceService.on("chat", chatListener);
    workspaceService.on("metadata", metadataListener);
    return () => {
      workspaceService.off("chat", chatListener);
      workspaceService.off("metadata", metadataListener);
    };
  }

  private enqueueWrite(workspaceId: string, fn: () => Promise<void>): void {
    const previous = this.writeQueues.get(workspaceId) ?? Promise.resolve();
    const queued = previous.then(fn, fn).catch((error: unknown) => {
      log.error("Failed to append timeline event", { workspaceId, error });
    });
    const tracked = queued.finally(() => {
      if (this.writeQueues.get(workspaceId) === tracked) {
        this.writeQueues.delete(workspaceId);
      }
    });
    this.writeQueues.set(workspaceId, tracked);
  }

  private async takeNextSequence(workspaceId: string): Promise<number> {
    let next = this.nextSequences.get(workspaceId);
    next ??= (await this.readLastSequence(workspaceId)) + 1;
    this.nextSequences.set(workspaceId, next + 1);
    return next;
  }

  private async readLastSequence(workspaceId: string): Promise<number> {
    let sequence = 0;
    await this.readLinesBackward(this.getFilePath(workspaceId), (line) => {
      try {
        const parsed = TimelineEventSchema.parse(JSON.parse(line));
        sequence = parsed.seq;
        return false;
      } catch {
        return true;
      }
    });
    return sequence;
  }

  private async readLinesBackward(
    filePath: string,
    visitor: (line: string) => boolean
  ): Promise<void> {
    let fileSize: number;
    try {
      fileSize = (await fs.stat(filePath)).size;
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }
    if (fileSize === 0) {
      return;
    }

    const file = await fs.open(filePath, "r");
    try {
      let readEnd = fileSize;
      let carryover = Buffer.alloc(0);
      while (readEnd > 0) {
        const readStart = Math.max(0, readEnd - REVERSE_READ_CHUNK_SIZE);
        const chunk = Buffer.alloc(readEnd - readStart);
        await file.read(chunk, 0, chunk.length, readStart);
        const buffer = carryover.length > 0 ? Buffer.concat([chunk, carryover]) : chunk;
        const newlines: number[] = [];
        for (let index = 0; index < buffer.length; index++) {
          if (buffer[index] === 0x0a) {
            newlines.push(index);
          }
        }

        if (newlines.length === 0) {
          carryover = Buffer.from(buffer);
          readEnd = readStart;
          continue;
        }

        carryover = Buffer.from(buffer.subarray(0, newlines[0]));
        for (let index = newlines.length - 1; index >= 0; index--) {
          const lineStart = newlines[index] + 1;
          const lineEnd = index < newlines.length - 1 ? newlines[index + 1] : buffer.length;
          const line = buffer.subarray(lineStart, lineEnd).toString("utf-8").trim();
          if (line.length > 0 && !visitor(line)) {
            return;
          }
        }
        readEnd = readStart;
      }

      const firstLine = carryover.toString("utf-8").trim();
      if (firstLine.length > 0) {
        visitor(firstLine);
      }
    } finally {
      await file.close();
    }
  }

  private matchesMessageAnchor(message: MuxMessage, anchor: TimelineAnchor): boolean {
    if (anchor.messageId != null && message.id !== anchor.messageId) {
      return false;
    }
    if (
      anchor.historySequence != null &&
      message.metadata?.historySequence !== anchor.historySequence
    ) {
      return false;
    }
    if (anchor.toolCallId != null) {
      return message.parts.some(
        (part) => part.type === "dynamic-tool" && part.toolCallId === anchor.toolCallId
      );
    }
    return anchor.messageId != null || anchor.historySequence != null;
  }

  private createPreview(message: MuxMessage, anchor: TimelineAnchor): TimelinePreview | null {
    if (anchor.toolCallId != null) {
      const toolPart = message.parts.find(
        (part): part is MuxToolPart =>
          part.type === "dynamic-tool" && part.toolCallId === anchor.toolCallId
      );
      if (toolPart == null) {
        return null;
      }
      return {
        role: "assistant",
        timestamp: toolPart.timestamp ?? message.metadata?.timestamp,
        textExcerpt: this.truncateExcerpt(this.toolPartText(toolPart)),
        toolName: toolPart.toolName,
        status: this.toolPartStatus(toolPart, message.metadata?.partial === true),
      };
    }

    const text = message.parts
      .filter((part) => part.type === "text" || part.type === "reasoning")
      .map((part) => part.text)
      .join("\n");
    return {
      role: message.role,
      timestamp: message.metadata?.timestamp,
      textExcerpt: this.truncateExcerpt(text),
      ...(message.metadata?.error != null
        ? { status: "failed" as const }
        : message.metadata?.partial === true
          ? { status: "interrupted" as const }
          : {}),
    };
  }

  private toolPartText(part: MuxToolPart): string {
    const value = part.state === "output-available" ? part.output : part.input;
    if (typeof value === "string") {
      return value;
    }
    try {
      return JSON.stringify(value) ?? "";
    } catch {
      return "";
    }
  }

  private toolPartStatus(part: MuxToolPart, isPartial: boolean): TimelinePreview["status"] {
    if (part.state === "output-available") {
      return isFailedToolCallResult(part.output) ? "failed" : "completed";
    }
    if (part.state === "output-redacted") {
      return part.failed === true ? "failed" : "completed";
    }
    return isPartial ? "interrupted" : "started";
  }

  private truncateExcerpt(value: string): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length <= 600 ? normalized : normalized.slice(0, 600);
  }

  private clearWorkspaceCaches(workspaceId: string): void {
    this.nextSequences.delete(workspaceId);
    this.recentSourceKeys.delete(workspaceId);
    this.mapperState = {
      openToolCalls: new Map(
        [...this.mapperState.openToolCalls].filter(([, tool]) => tool.workspaceId !== workspaceId)
      ),
      openStreams: new Map(
        [...this.mapperState.openStreams].filter(([, stream]) => stream.workspaceId !== workspaceId)
      ),
    };
  }

  private getFilePath(workspaceId: string): string {
    return path.join(this.config.getSessionDir(workspaceId), TIMELINE_FILE_NAME);
  }

  private hasRecentSourceKey(workspaceId: string, sourceKey: string): boolean {
    return this.recentSourceKeys.get(workspaceId)?.has(sourceKey) === true;
  }

  private rememberSourceKey(workspaceId: string, sourceKey: string): void {
    const keys = this.recentSourceKeys.get(workspaceId) ?? new Map<string, true>();
    keys.delete(sourceKey);
    keys.set(sourceKey, true);
    if (keys.size > RECENT_SOURCE_KEY_LIMIT) {
      const oldest = keys.keys().next().value;
      if (oldest != null) {
        keys.delete(oldest);
      }
    }
    this.recentSourceKeys.set(workspaceId, keys);
  }
}

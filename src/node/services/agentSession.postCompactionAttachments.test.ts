import { describe, expect, test, mock } from "bun:test";
import { EventEmitter } from "events";

import type { PostCompactionAttachment } from "@/common/types/attachment";
import { TURNS_BETWEEN_ATTACHMENTS } from "@/common/constants/attachments";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import type { Config } from "@/node/config";

import type { AIService } from "./aiService";
import { AgentSession } from "./agentSession";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { HistoryService } from "./historyService";
import type { InitStateManager } from "./initStateManager";
import type { PartialService } from "./partialService";
import { DisposableTempDir } from "./tempDir";

function createSuccessfulFileEditMessage(id: string, filePath: string, diff: string): MuxMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolCallId: `tool-${id}`,
        toolName: "file_edit_replace_string",
        state: "output-available",
        input: { file_path: filePath },
        output: { success: true, diff },
      },
    ],
    metadata: {
      timestamp: Date.now(),
    },
  };
}

function getEditedFilePaths(attachments: PostCompactionAttachment[]): string[] {
  const editedFilesAttachment = attachments.find(
    (
      attachment
    ): attachment is Extract<PostCompactionAttachment, { type: "edited_files_reference" }> =>
      attachment.type === "edited_files_reference"
  );

  return editedFilesAttachment?.files.map((file) => file.path) ?? [];
}

function createSessionForHistory(history: MuxMessage[], sessionDir: string): AgentSession {
  // Simulate getHistoryFromLatestBoundary: return only messages from the last
  // durable compaction boundary onward (matching real HistoryService behavior).
  const fromBoundary = (): MuxMessage[] => {
    let lastBoundaryIdx = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      const meta = history[i].metadata;
      if (meta?.compactionBoundary === true && meta?.compacted && meta?.compactionEpoch) {
        lastBoundaryIdx = i;
        break;
      }
    }
    return lastBoundaryIdx >= 0 ? history.slice(lastBoundaryIdx) : history;
  };

  const historyService: HistoryService = {
    getHistoryFromLatestBoundary: mock(() =>
      Promise.resolve({ success: true as const, data: fromBoundary() })
    ),
    getLastMessages: mock((_: string, n: number) =>
      Promise.resolve({ success: true as const, data: history.slice(-n) })
    ),
  } as unknown as HistoryService;

  const partialService: PartialService = {} as unknown as PartialService;

  const aiEmitter = new EventEmitter();
  const aiService: AIService = {
    on(eventName: string | symbol, listener: (...args: unknown[]) => void) {
      aiEmitter.on(String(eventName), listener);
      return this;
    },
    off(eventName: string | symbol, listener: (...args: unknown[]) => void) {
      aiEmitter.off(String(eventName), listener);
      return this;
    },
    getWorkspaceMetadata: mock(() =>
      Promise.resolve({ success: false as const, error: "metadata unavailable" })
    ),
    stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
  } as unknown as AIService;

  const initStateManager: InitStateManager = {
    on() {
      return this;
    },
    off() {
      return this;
    },
  } as unknown as InitStateManager;

  const backgroundProcessManager: BackgroundProcessManager = {
    setMessageQueued: mock(() => undefined),
    cleanup: mock(() => Promise.resolve()),
  } as unknown as BackgroundProcessManager;

  const config: Config = {
    srcDir: "/tmp",
    getSessionDir: mock(() => sessionDir),
  } as unknown as Config;

  return new AgentSession({
    workspaceId: "workspace-post-compaction-test",
    config,
    historyService,
    partialService,
    aiService,
    initStateManager,
    backgroundProcessManager,
  });
}

async function generatePeriodicPostCompactionAttachments(
  session: AgentSession
): Promise<PostCompactionAttachment[]> {
  const privateSession = session as unknown as {
    compactionOccurred: boolean;
    turnsSinceLastAttachment: number;
    getPostCompactionAttachmentsIfNeeded: () => Promise<PostCompactionAttachment[] | null>;
  };

  privateSession.compactionOccurred = true;
  privateSession.turnsSinceLastAttachment = TURNS_BETWEEN_ATTACHMENTS - 1;

  const attachments = await privateSession.getPostCompactionAttachmentsIfNeeded();
  expect(attachments).not.toBeNull();

  return attachments ?? [];
}

describe("AgentSession periodic post-compaction attachments", () => {
  test("extracts edited file diffs from the latest durable compaction boundary slice", async () => {
    using sessionDir = new DisposableTempDir("agent-session-latest-boundary");

    const history: MuxMessage[] = [
      createSuccessfulFileEditMessage(
        "stale-before-boundary",
        "/tmp/stale-before-boundary.ts",
        "@@ -1 +1 @@\n-old\n+older\n"
      ),
      createMuxMessage("boundary-1", "assistant", "epoch 1 summary", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
      }),
      createSuccessfulFileEditMessage(
        "stale-epoch-1",
        "/tmp/stale-epoch-1.ts",
        "@@ -1 +1 @@\n-old\n+stale\n"
      ),
      createMuxMessage("boundary-2", "assistant", "epoch 2 summary", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 2,
      }),
      createSuccessfulFileEditMessage(
        "recent-epoch-2",
        "/tmp/recent-epoch-2.ts",
        "@@ -1 +1 @@\n-before\n+after\n"
      ),
    ];

    const session = createSessionForHistory(history, sessionDir.path);

    try {
      const attachments = await generatePeriodicPostCompactionAttachments(session);
      expect(getEditedFilePaths(attachments)).toEqual(["/tmp/recent-epoch-2.ts"]);
    } finally {
      session.dispose();
    }
  });

  test("falls back safely when boundary markers are malformed", async () => {
    using sessionDir = new DisposableTempDir("agent-session-malformed-boundary");

    const history: MuxMessage[] = [
      createSuccessfulFileEditMessage("stale-edit", "/tmp/stale.ts", "@@ -1 +1 @@\n-old\n+stale\n"),
      createMuxMessage("malformed-boundary", "assistant", "malformed summary", {
        compacted: "user",
        compactionBoundary: true,
        // Missing compactionEpoch: marker should be ignored without crashing.
      }),
      createSuccessfulFileEditMessage(
        "recent-edit",
        "/tmp/recent.ts",
        "@@ -1 +1 @@\n-before\n+after\n"
      ),
    ];

    const session = createSessionForHistory(history, sessionDir.path);

    try {
      const attachments = await generatePeriodicPostCompactionAttachments(session);
      expect(getEditedFilePaths(attachments)).toEqual(["/tmp/recent.ts", "/tmp/stale.ts"]);
    } finally {
      session.dispose();
    }
  });
});

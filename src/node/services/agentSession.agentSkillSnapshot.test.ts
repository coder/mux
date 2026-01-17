import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { AIService } from "@/node/services/aiService";
import type { HistoryService } from "@/node/services/historyService";
import type { PartialService } from "@/node/services/partialService";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { Config } from "@/node/config";

import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import type { SendMessageError } from "@/common/types/errors";
import type { Result } from "@/common/types/result";
import { Ok } from "@/common/types/result";

import { AgentSession } from "./agentSession";

describe("AgentSession.sendMessage (agent skill snapshots)", () => {
  async function createTestWorkspaceWithSkill(args: { skillName: string; skillBody: string }) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mux-agent-skill-"));
    const skillDir = path.join(tmp, ".mux", "skills", args.skillName);
    await fs.mkdir(skillDir, { recursive: true });

    const skillMarkdown = `---\nname: ${args.skillName}\ndescription: Test skill\n---\n\n${args.skillBody}\n`;
    await fs.writeFile(path.join(skillDir, "SKILL.md"), skillMarkdown, "utf-8");

    return { workspacePath: tmp };
  }

  it("persists a synthetic agent skill snapshot before the user message", async () => {
    const workspaceId = "ws-test";

    const { workspacePath } = await createTestWorkspaceWithSkill({
      skillName: "test-skill",
      skillBody: "Follow this skill.",
    });

    const config = {
      srcDir: "/tmp",
      getSessionDir: (_workspaceId: string) => "/tmp",
    } as unknown as Config;

    const messages: MuxMessage[] = [];
    let nextSeq = 0;

    const appendToHistory = mock((_workspaceId: string, message: MuxMessage) => {
      message.metadata = { ...(message.metadata ?? {}), historySequence: nextSeq++ };
      messages.push(message);
      return Promise.resolve(Ok(undefined));
    });

    const historyService = {
      appendToHistory,
      truncateAfterMessage: mock((_workspaceId: string, _messageId: string) => {
        void _messageId;
        return Promise.resolve(Ok(undefined));
      }),
      getHistory: mock((_workspaceId: string): Promise<Result<MuxMessage[], string>> => {
        return Promise.resolve(Ok([...messages]));
      }),
    } as unknown as HistoryService;

    const partialService = {
      commitToHistory: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
    } as unknown as PartialService;

    const aiEmitter = new EventEmitter();

    const workspaceMeta: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "ws",
      projectName: "proj",
      projectPath: workspacePath,
      namedWorkspacePath: workspacePath,
      runtimeConfig: { type: "local" },
    } as unknown as FrontendWorkspaceMetadata;

    const streamMessage = mock((_messages: MuxMessage[]) => {
      return Promise.resolve(Ok(undefined));
    });

    const aiService = Object.assign(aiEmitter, {
      isStreaming: mock((_workspaceId: string) => false),
      stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
      getWorkspaceMetadata: mock((_workspaceId: string) => Promise.resolve(Ok(workspaceMeta))),
      streamMessage: streamMessage as unknown as (
        ...args: Parameters<AIService["streamMessage"]>
      ) => Promise<Result<void, SendMessageError>>,
    }) as unknown as AIService;

    const initStateManager = new EventEmitter() as unknown as InitStateManager;

    const backgroundProcessManager = {
      cleanup: mock((_workspaceId: string) => Promise.resolve()),
      setMessageQueued: mock((_workspaceId: string, _queued: boolean) => {
        void _queued;
      }),
    } as unknown as BackgroundProcessManager;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      partialService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const result = await session.sendMessage("do X", {
      model: "anthropic:claude-3-5-sonnet-latest",
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/test-skill do X",
        skillName: "test-skill",
        scope: "project",
      },
    });

    expect(result.success).toBe(true);

    expect(appendToHistory.mock.calls).toHaveLength(2);
    const [snapshotMessage, userMessage] = messages;

    expect(snapshotMessage.role).toBe("user");
    expect(snapshotMessage.metadata?.synthetic).toBe(true);
    expect(snapshotMessage.metadata?.agentSkillSnapshot?.skillName).toBe("test-skill");
    expect(snapshotMessage.metadata?.agentSkillSnapshot?.sha256).toBeTruthy();

    const snapshotText = snapshotMessage.parts.find((p) => p.type === "text")?.text;
    expect(snapshotText).toContain("<agent-skill");
    expect(snapshotText).toContain("Follow this skill.");

    expect(userMessage.role).toBe("user");
    const userText = userMessage.parts.find((p) => p.type === "text")?.text;
    expect(userText).toBe("do X");
  });

  it("honors disableWorkspaceAgents when resolving skill snapshots", async () => {
    const workspaceId = "ws-test";

    const { workspacePath: projectPath } = await createTestWorkspaceWithSkill({
      // Built-in: use a project-local override to ensure we don't accidentally fall back.
      skillName: "init",
      skillBody: "Project override for init skill.",
    });

    const srcBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-agent-skill-src-"));

    const config = {
      srcDir: "/tmp",
      getSessionDir: (_workspaceId: string) => "/tmp",
    } as unknown as Config;

    const messages: MuxMessage[] = [];
    let nextSeq = 0;

    const appendToHistory = mock((_workspaceId: string, message: MuxMessage) => {
      message.metadata = { ...(message.metadata ?? {}), historySequence: nextSeq++ };
      messages.push(message);
      return Promise.resolve(Ok(undefined));
    });

    const historyService = {
      appendToHistory,
      truncateAfterMessage: mock((_workspaceId: string, _messageId: string) => {
        void _messageId;
        return Promise.resolve(Ok(undefined));
      }),
      getHistory: mock((_workspaceId: string): Promise<Result<MuxMessage[], string>> => {
        return Promise.resolve(Ok([...messages]));
      }),
    } as unknown as HistoryService;

    const partialService = {
      commitToHistory: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
    } as unknown as PartialService;

    const aiEmitter = new EventEmitter();

    const workspaceMeta: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "ws",
      projectName: "proj",
      projectPath,
      namedWorkspacePath: projectPath,
      runtimeConfig: { type: "worktree", srcBaseDir },
    } as unknown as FrontendWorkspaceMetadata;

    const streamMessage = mock((_messages: MuxMessage[]) => {
      return Promise.resolve(Ok(undefined));
    });

    const aiService = Object.assign(aiEmitter, {
      isStreaming: mock((_workspaceId: string) => false),
      stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
      getWorkspaceMetadata: mock((_workspaceId: string) => Promise.resolve(Ok(workspaceMeta))),
      streamMessage: streamMessage as unknown as (
        ...args: Parameters<AIService["streamMessage"]>
      ) => Promise<Result<void, SendMessageError>>,
    }) as unknown as AIService;

    const initStateManager = new EventEmitter() as unknown as InitStateManager;

    const backgroundProcessManager = {
      cleanup: mock((_workspaceId: string) => Promise.resolve()),
      setMessageQueued: mock((_workspaceId: string, _queued: boolean) => {
        void _queued;
      }),
    } as unknown as BackgroundProcessManager;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      partialService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const result = await session.sendMessage("do X", {
      model: "anthropic:claude-3-5-sonnet-latest",
      disableWorkspaceAgents: true,
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/init",
        skillName: "init",
        scope: "project",
      },
    });

    expect(result.success).toBe(true);

    expect(appendToHistory.mock.calls).toHaveLength(2);
    const [snapshotMessage] = messages;

    const snapshotText = snapshotMessage.parts.find((p) => p.type === "text")?.text;
    expect(snapshotText).toContain("Project override for init skill.");
  });

  it("dedupes identical skill snapshots when recently inserted", async () => {
    const workspaceId = "ws-test";

    const { workspacePath } = await createTestWorkspaceWithSkill({
      skillName: "test-skill",
      skillBody: "Follow this skill.",
    });

    const config = {
      srcDir: "/tmp",
      getSessionDir: (_workspaceId: string) => "/tmp",
    } as unknown as Config;

    const messages: MuxMessage[] = [];
    let nextSeq = 0;

    const appendToHistory = mock((_workspaceId: string, message: MuxMessage) => {
      message.metadata = { ...(message.metadata ?? {}), historySequence: nextSeq++ };
      messages.push(message);
      return Promise.resolve(Ok(undefined));
    });

    const historyService = {
      appendToHistory,
      truncateAfterMessage: mock((_workspaceId: string, _messageId: string) => {
        void _messageId;
        return Promise.resolve(Ok(undefined));
      }),
      getHistory: mock((_workspaceId: string): Promise<Result<MuxMessage[], string>> => {
        return Promise.resolve(Ok([...messages]));
      }),
    } as unknown as HistoryService;

    const partialService = {
      commitToHistory: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
    } as unknown as PartialService;

    const aiEmitter = new EventEmitter();

    const workspaceMeta: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "ws",
      projectName: "proj",
      projectPath: workspacePath,
      namedWorkspacePath: workspacePath,
      runtimeConfig: { type: "local" },
    } as unknown as FrontendWorkspaceMetadata;

    const streamMessage = mock((_messages: MuxMessage[]) => {
      return Promise.resolve(Ok(undefined));
    });

    const aiService = Object.assign(aiEmitter, {
      isStreaming: mock((_workspaceId: string) => false),
      stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
      getWorkspaceMetadata: mock((_workspaceId: string) => Promise.resolve(Ok(workspaceMeta))),
      streamMessage: streamMessage as unknown as (
        ...args: Parameters<AIService["streamMessage"]>
      ) => Promise<Result<void, SendMessageError>>,
    }) as unknown as AIService;

    const initStateManager = new EventEmitter() as unknown as InitStateManager;

    const backgroundProcessManager = {
      cleanup: mock((_workspaceId: string) => Promise.resolve()),
      setMessageQueued: mock((_workspaceId: string, _queued: boolean) => {
        void _queued;
      }),
    } as unknown as BackgroundProcessManager;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      partialService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const baseOptions = {
      model: "anthropic:claude-3-5-sonnet-latest",
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/test-skill do X",
        skillName: "test-skill",
        scope: "project",
      },
    };

    const first = await session.sendMessage("do X", baseOptions);
    expect(first.success).toBe(true);
    expect(appendToHistory.mock.calls).toHaveLength(2);

    const second = await session.sendMessage("do Y", {
      ...baseOptions,
      muxMetadata: {
        ...baseOptions.muxMetadata,
        rawCommand: "/test-skill do Y",
      },
    });

    expect(second.success).toBe(true);
    // First send: snapshot + user. Second send: user only.
    expect(appendToHistory.mock.calls).toHaveLength(3);

    const appendedIds = appendToHistory.mock.calls.map((call) => call[1].id);
    const secondSendAppendedIds = appendedIds.slice(2);
    expect(secondSendAppendedIds).toHaveLength(1);
    expect(secondSendAppendedIds[0]).toStartWith("user-");
  });

  it("truncates edits starting from preceding skill/file snapshots", async () => {
    const workspaceId = "ws-test";

    const config = {
      srcDir: "/tmp",
      getSessionDir: (_workspaceId: string) => "/tmp",
    } as unknown as Config;

    const fileSnapshotId = "file-snapshot-0";
    const skillSnapshotId = "agent-skill-snapshot-0";
    const userMessageId = "user-0";

    const historyMessages: MuxMessage[] = [
      createMuxMessage(fileSnapshotId, "user", "<file>...</file>", {
        historySequence: 0,
        synthetic: true,
        fileAtMentionSnapshot: ["@file:foo.txt"],
      }),
      createMuxMessage(skillSnapshotId, "user", "<agent-skill>...</agent-skill>", {
        historySequence: 1,
        synthetic: true,
        agentSkillSnapshot: {
          skillName: "test-skill",
          scope: "project",
          sha256: "abc",
        },
      }),
      createMuxMessage(userMessageId, "user", "do X", {
        historySequence: 2,
        muxMetadata: {
          type: "agent-skill",
          rawCommand: "/test-skill do X",
          skillName: "test-skill",
          scope: "project",
        },
      }),
    ];

    const truncateAfterMessage = mock((_workspaceId: string, _messageId: string) => {
      void _workspaceId;
      void _messageId;
      return Promise.resolve(Ok(undefined));
    });

    const historyService = {
      truncateAfterMessage,
      appendToHistory: mock((_workspaceId: string, _message: MuxMessage) => {
        return Promise.resolve(Ok(undefined));
      }),
      getHistory: mock((_workspaceId: string): Promise<Result<MuxMessage[], string>> => {
        return Promise.resolve(Ok([...historyMessages]));
      }),
    } as unknown as HistoryService;

    const partialService = {
      commitToHistory: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
    } as unknown as PartialService;

    const aiEmitter = new EventEmitter();
    const aiService = Object.assign(aiEmitter, {
      isStreaming: mock((_workspaceId: string) => false),
      stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
      streamMessage: mock((_messages: MuxMessage[]) =>
        Promise.resolve(Ok(undefined))
      ) as unknown as (
        ...args: Parameters<AIService["streamMessage"]>
      ) => Promise<Result<void, SendMessageError>>,
    }) as unknown as AIService;

    const initStateManager = new EventEmitter() as unknown as InitStateManager;

    const backgroundProcessManager = {
      cleanup: mock((_workspaceId: string) => Promise.resolve()),
      setMessageQueued: mock((_workspaceId: string, _queued: boolean) => {
        void _queued;
      }),
    } as unknown as BackgroundProcessManager;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      partialService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const result = await session.sendMessage("edited", {
      model: "anthropic:claude-3-5-sonnet-latest",
      editMessageId: userMessageId,
    });

    expect(result.success).toBe(true);
    expect(truncateAfterMessage.mock.calls).toHaveLength(1);
    // Should truncate from the earliest contiguous snapshot (file snapshot).
    expect(truncateAfterMessage.mock.calls[0][1]).toBe(fileSnapshotId);
  });
});

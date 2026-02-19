import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import type { OnChatMode, WorkspaceChatMessage } from "../../src/common/orpc/types";
import { MuxAgent } from "../../src/node/acp/agent";
import type { ORPCClient, ServerConnection } from "../../src/node/acp/serverConnection";

type WorkspaceInfo = NonNullable<Awaited<ReturnType<ORPCClient["workspace"]["getInfo"]>>>;

interface Harness {
  agent: MuxAgent;
  sendMessageCalls: Array<{
    workspaceId: string;
    message: string;
    options: Record<string, unknown>;
  }>;
  pushChatEvent: (event: WorkspaceChatMessage) => void;
  closeConnection: () => void;
  connectionClosed: Promise<void>;
}

function createWorkspaceInfo(overrides?: Partial<WorkspaceInfo>): WorkspaceInfo {
  return {
    id: "ws-default",
    name: "ws-default",
    title: "Default workspace",
    projectName: "project",
    projectPath: "/repo/default",
    runtimeConfig: { type: "local" },
    namedWorkspacePath: "/repo/default/.mux/ws-default",
    agentId: "exec",
    aiSettings: {
      model: "anthropic:claude-sonnet-4-5",
      thinkingLevel: "medium",
    },
    aiSettingsByAgent: {
      exec: {
        model: "anthropic:claude-sonnet-4-5",
        thinkingLevel: "medium",
      },
    },
    ...overrides,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function createControllableAcpStream(): {
  stream: ReturnType<typeof ndJsonStream>;
  closeInput: () => void;
} {
  let inputController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      inputController = controller;
    },
  });

  const output = new WritableStream<Uint8Array>({});
  return {
    stream: ndJsonStream(output, input),
    closeInput: () => {
      inputController?.close();
    },
  };
}

function createControlledChatStream(): {
  stream: AsyncIterable<WorkspaceChatMessage>;
  push: (event: WorkspaceChatMessage) => void;
} {
  const pendingEvents: WorkspaceChatMessage[] = [];
  let pendingResolve: ((result: IteratorResult<WorkspaceChatMessage>) => void) | null = null;

  const push = (event: WorkspaceChatMessage) => {
    if (pendingResolve != null) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve({ done: false, value: event });
      return;
    }

    pendingEvents.push(event);
  };

  const stream: AsyncIterable<WorkspaceChatMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next: async (): Promise<IteratorResult<WorkspaceChatMessage>> => {
          if (pendingEvents.length > 0) {
            const next = pendingEvents.shift();
            if (next == null) {
              return { done: true, value: undefined };
            }
            return { done: false, value: next };
          }

          return new Promise<IteratorResult<WorkspaceChatMessage>>((resolve) => {
            pendingResolve = resolve;
          });
        },
      };
    },
  };

  return { stream, push };
}

function createHarness(): Harness {
  const workspacesById = new Map<string, WorkspaceInfo>();
  const sendMessageCalls: Array<{
    workspaceId: string;
    message: string;
    options: Record<string, unknown>;
  }> = [];
  const chatStream = createControlledChatStream();

  const client = {
    config: {
      getConfig: async () => ({}),
    },
    projects: {
      listBranches: async () => ({
        branches: ["main"],
        currentBranch: "main",
        recommendedTrunk: "main",
      }),
    },
    agents: {
      list: async () => [],
    },
    agentSkills: {
      list: async () => [],
      listDiagnostics: async () => {
        throw new Error("createHarness: listDiagnostics not implemented for this test");
      },
      get: async () => {
        throw new Error("createHarness: get not implemented for this test");
      },
    },
    workspace: {
      create: async (input: {
        projectPath: string;
        branchName: string;
        trunkBranch?: string;
        title?: string;
        runtimeConfig?: WorkspaceInfo["runtimeConfig"];
      }) => {
        const workspaceId = "ws-1";
        const metadata = createWorkspaceInfo({
          id: workspaceId,
          name: input.branchName,
          title: input.title ?? input.branchName,
          projectPath: input.projectPath,
          namedWorkspacePath: `${input.projectPath}/.mux/${input.branchName}`,
          runtimeConfig: input.runtimeConfig ?? { type: "local" },
        });
        workspacesById.set(workspaceId, metadata);

        return {
          success: true as const,
          metadata,
        };
      },
      getInfo: async ({ workspaceId }: { workspaceId: string }) =>
        workspacesById.get(workspaceId) ?? null,
      onChat: async (_input: { workspaceId: string; mode?: OnChatMode }) => chatStream.stream,
      sendMessage: async (input: {
        workspaceId: string;
        message: string;
        options: Record<string, unknown>;
      }) => {
        sendMessageCalls.push(input);
        return { success: true as const, data: {} };
      },
      interruptStream: async () => ({ success: true as const, data: undefined }),
      updateModeAISettings: async () => ({ success: true as const, data: undefined }),
      updateAgentAISettings: async () => ({ success: true as const, data: undefined }),
    },
  };

  const server: ServerConnection = {
    client: client as unknown as ORPCClient,
    baseUrl: "ws://127.0.0.1:1234",
    close: async () => undefined,
  };

  const { stream, closeInput } = createControllableAcpStream();

  let agentInstance: MuxAgent | null = null;
  const connection = new AgentSideConnection((connectionToAgent) => {
    const createdAgent = new MuxAgent(connectionToAgent, server);
    agentInstance = createdAgent;
    return createdAgent;
  }, stream);

  if (agentInstance == null) {
    throw new Error("createHarness: failed to construct MuxAgent");
  }

  return {
    agent: agentInstance,
    sendMessageCalls,
    pushChatEvent: chatStream.push,
    closeConnection: closeInput,
    connectionClosed: connection.closed,
  };
}

async function waitForCondition(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("waitForCondition: timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("ACP prompt stream correlation", () => {
  it("ignores unrelated stream-start/end pairs while waiting for this prompt turn", async () => {
    const harness = createHarness();
    await harness.agent.initialize({ protocolVersion: PROTOCOL_VERSION });

    const newSessionResponse = await harness.agent.newSession({
      cwd: "/repo/acp-go-sdk",
      mcpServers: [],
      _meta: {
        trunkBranch: "main",
      },
    });

    const promptPromise = harness.agent.prompt({
      sessionId: newSessionResponse.sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });

    await waitForCondition(() => harness.sendMessageCalls.length === 1);

    const firstSend = harness.sendMessageCalls[0];
    const muxMetadata = firstSend.options["muxMetadata"];
    if (!isRecord(muxMetadata)) {
      throw new Error("Expected prompt send options to include muxMetadata record");
    }

    const promptCorrelationId = muxMetadata["acpPromptId"];
    if (typeof promptCorrelationId !== "string") {
      throw new Error("Expected prompt send options to include acpPromptId");
    }

    let promptSettled = false;
    void promptPromise.finally(() => {
      promptSettled = true;
    });

    harness.pushChatEvent({
      type: "stream-start",
      workspaceId: newSessionResponse.sessionId,
      messageId: "assistant-other",
      model: "anthropic:claude-sonnet-4-5",
      historySequence: 2,
      startTime: Date.now(),
      acpPromptId: "unrelated-prompt-id",
    } as WorkspaceChatMessage);

    harness.pushChatEvent({
      type: "stream-end",
      workspaceId: newSessionResponse.sessionId,
      messageId: "assistant-other",
      metadata: {
        model: "anthropic:claude-sonnet-4-5",
      },
      parts: [],
    } as WorkspaceChatMessage);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(promptSettled).toBe(false);

    harness.pushChatEvent({
      type: "stream-start",
      workspaceId: newSessionResponse.sessionId,
      messageId: "assistant-target",
      model: "anthropic:claude-sonnet-4-5",
      historySequence: 3,
      startTime: Date.now(),
      acpPromptId: promptCorrelationId,
    } as WorkspaceChatMessage);

    harness.pushChatEvent({
      type: "stream-end",
      workspaceId: newSessionResponse.sessionId,
      messageId: "assistant-target",
      metadata: {
        model: "anthropic:claude-sonnet-4-5",
      },
      parts: [],
    } as WorkspaceChatMessage);

    await expect(promptPromise).resolves.toEqual({
      stopReason: "end_turn",
      usage: undefined,
    });

    harness.closeConnection();
    await harness.connectionClosed;
  });

  it("treats runtime error events as terminal failures for the matching prompt", async () => {
    const harness = createHarness();
    await harness.agent.initialize({ protocolVersion: PROTOCOL_VERSION });

    const newSessionResponse = await harness.agent.newSession({
      cwd: "/repo/acp-go-sdk",
      mcpServers: [],
      _meta: {
        trunkBranch: "main",
      },
    });

    const promptPromise = harness.agent.prompt({
      sessionId: newSessionResponse.sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });

    await waitForCondition(() => harness.sendMessageCalls.length === 1);

    const firstSend = harness.sendMessageCalls[0];
    const muxMetadata = firstSend.options["muxMetadata"];
    if (!isRecord(muxMetadata)) {
      throw new Error("Expected prompt send options to include muxMetadata record");
    }

    const promptCorrelationId = muxMetadata["acpPromptId"];
    if (typeof promptCorrelationId !== "string") {
      throw new Error("Expected prompt send options to include acpPromptId");
    }

    let promptSettled = false;
    void promptPromise.finally(() => {
      promptSettled = true;
    });

    harness.pushChatEvent({
      type: "error",
      workspaceId: newSessionResponse.sessionId,
      messageId: "assistant-other",
      error: "runtime unavailable",
      errorType: "runtime_not_ready",
      acpPromptId: "unrelated-prompt-id",
    } as WorkspaceChatMessage);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(promptSettled).toBe(false);

    harness.pushChatEvent({
      type: "error",
      workspaceId: newSessionResponse.sessionId,
      messageId: "assistant-target",
      error: "runtime unavailable",
      errorType: "runtime_not_ready",
      acpPromptId: promptCorrelationId,
    } as WorkspaceChatMessage);

    await expect(promptPromise).rejects.toThrow("runtime unavailable");

    harness.closeConnection();
    await harness.connectionClosed;
  });
});

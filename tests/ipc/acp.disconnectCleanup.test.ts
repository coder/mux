import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import type { OnChatMode, WorkspaceChatMessage } from "../../src/common/orpc/types";
import { MuxAgent } from "../../src/node/acp/agent";
import type { ORPCClient, ServerConnection } from "../../src/node/acp/serverConnection";

type WorkspaceInfo = NonNullable<Awaited<ReturnType<ORPCClient["workspace"]["getInfo"]>>>;

interface HarnessOptions {
  getReplayEvents?: (workspaceId: string) => WorkspaceChatMessage[];
  beforeCreateResolves?: Promise<void>;
  disconnectCleanupMaxWaitMs?: number;
}

interface Harness {
  agent: MuxAgent;
  createdWorkspaceIds: string[];
  removeCalls: string[];
  replayChecks: string[];
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

async function* createChatStream(
  events: WorkspaceChatMessage[]
): AsyncIterable<WorkspaceChatMessage> {
  for (const event of events) {
    yield event;
  }
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

function createHarness(options?: HarnessOptions): Harness {
  const workspacesById = new Map<string, WorkspaceInfo>();
  const createdWorkspaceIds: string[] = [];
  const removeCalls: string[] = [];
  const replayChecks: string[] = [];

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
      setTrust: async () => {},
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
        const workspaceId = `ws-${workspacesById.size + 1}`;
        if (options?.beforeCreateResolves != null) {
          await options.beforeCreateResolves;
        }

        const metadata = createWorkspaceInfo({
          id: workspaceId,
          name: input.branchName,
          title: input.title ?? input.branchName,
          projectPath: input.projectPath,
          namedWorkspacePath: `${input.projectPath}/.mux/${input.branchName}`,
          runtimeConfig: input.runtimeConfig ?? { type: "local" },
        });

        workspacesById.set(workspaceId, metadata);
        createdWorkspaceIds.push(workspaceId);

        return {
          success: true as const,
          metadata,
        };
      },
      getInfo: async ({ workspaceId }: { workspaceId: string }) =>
        workspacesById.get(workspaceId) ?? null,
      onChat: async (_input: { workspaceId: string; mode?: OnChatMode }) =>
        createChatStream([{ type: "caught-up" } as WorkspaceChatMessage]),
      updateModeAISettings: async () => ({ success: true as const, data: undefined }),
      updateAgentAISettings: async () => ({ success: true as const, data: undefined }),
      getFullReplay: async ({ workspaceId }: { workspaceId: string }) => {
        replayChecks.push(workspaceId);
        return options?.getReplayEvents?.(workspaceId) ?? [];
      },
      remove: async ({ workspaceId }: { workspaceId: string }) => {
        removeCalls.push(workspaceId);
        workspacesById.delete(workspaceId);
        return { success: true as const };
      },
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
    const createdAgent = new MuxAgent(connectionToAgent, server, {
      disconnectCleanupMaxWaitMs: options?.disconnectCleanupMaxWaitMs,
    });
    agentInstance = createdAgent;
    return createdAgent;
  }, stream);

  if (agentInstance == null) {
    throw new Error("createHarness: failed to construct MuxAgent");
  }

  return {
    agent: agentInstance,
    createdWorkspaceIds,
    removeCalls,
    replayChecks,
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

describe("ACP disconnect cleanup for untouched session/new workspaces", () => {
  it("removes empty session/new workspace when connection closes", async () => {
    const harness = createHarness();
    await harness.agent.initialize({ protocolVersion: PROTOCOL_VERSION });

    const newSessionResponse = await harness.agent.newSession({
      cwd: "/repo/acp-go-sdk",
      mcpServers: [],
      _meta: {
        trunkBranch: "main",
      },
    });

    expect(harness.createdWorkspaceIds).toEqual([newSessionResponse.sessionId]);

    harness.closeConnection();
    await harness.connectionClosed;

    await waitForCondition(() => harness.removeCalls.length === 1);
    expect(harness.removeCalls).toEqual([newSessionResponse.sessionId]);
  });

  it("keeps workspace when replay shows existing conversation messages", async () => {
    const harness = createHarness({
      getReplayEvents: () => [
        {
          type: "message",
          id: "user-1",
          role: "user",
          parts: [
            {
              type: "text",
              text: "hello",
            },
          ],
        } as WorkspaceChatMessage,
      ],
    });

    await harness.agent.initialize({ protocolVersion: PROTOCOL_VERSION });
    const newSessionResponse = await harness.agent.newSession({
      cwd: "/repo/acp-go-sdk",
      mcpServers: [],
      _meta: {
        trunkBranch: "main",
      },
    });

    harness.closeConnection();
    await harness.connectionClosed;

    await waitForCondition(() => harness.replayChecks.length === 1);
    expect(harness.replayChecks).toEqual([newSessionResponse.sessionId]);
    expect(harness.removeCalls).toEqual([]);
  });

  it("drains late-registered newSession workspaces during disconnect cleanup", async () => {
    const createDeferredResult = createDeferred<void>();
    const harness = createHarness({
      beforeCreateResolves: createDeferredResult.promise,
    });

    await harness.agent.initialize({ protocolVersion: PROTOCOL_VERSION });

    const newSessionPromise = harness.agent.newSession({
      cwd: "/repo/acp-go-sdk",
      mcpServers: [],
      _meta: {
        trunkBranch: "main",
      },
    });

    // Don't fail the test if the in-flight request rejects after disconnect;
    // this scenario is about cleanup side effects, not RPC completion semantics.
    void newSessionPromise.catch(() => undefined);

    harness.closeConnection();
    await harness.connectionClosed;

    createDeferredResult.resolve();

    await waitForCondition(() => harness.createdWorkspaceIds.length === 1);
    const createdWorkspaceId = harness.createdWorkspaceIds[0];
    expect(createdWorkspaceId).toBeDefined();
    if (createdWorkspaceId == null) {
      throw new Error("Expected delayed workspace creation to complete");
    }

    await waitForCondition(() => harness.removeCalls.includes(createdWorkspaceId));
  });

  it("bounds disconnect cleanup wait when session/new creation never settles", async () => {
    const neverResolves = new Promise<void>(() => undefined);
    const harness = createHarness({
      beforeCreateResolves: neverResolves,
      disconnectCleanupMaxWaitMs: 20,
    });

    await harness.agent.initialize({ protocolVersion: PROTOCOL_VERSION });

    const newSessionPromise = harness.agent.newSession({
      cwd: "/repo/acp-go-sdk",
      mcpServers: [],
      _meta: {
        trunkBranch: "main",
      },
    });
    void newSessionPromise.catch(() => undefined);

    harness.closeConnection();
    await harness.connectionClosed;

    let cleanupSettled = false;
    const cleanupPromise = harness.agent.waitForDisconnectCleanup().then(() => {
      cleanupSettled = true;
    });

    await waitForCondition(() => cleanupSettled, 500);
    await cleanupPromise;

    expect(harness.createdWorkspaceIds).toEqual([]);
    expect(harness.removeCalls).toEqual([]);
  });
});

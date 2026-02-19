import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { ToolRouter } from "../../src/node/acp/toolRouter";

function createRouter(overrides?: {
  readTextFile?: (input: { sessionId: string; path: string }) => Promise<{ content: string }>;
  writeTextFile?: (input: { sessionId: string; path: string; content: string }) => Promise<unknown>;
  createTerminal?: (input: Record<string, unknown>) => Promise<{
    id: string;
    currentOutput: () => Promise<{ output: string; truncated: boolean }>;
    waitForExit: () => Promise<{ exitCode?: number | null; signal?: string | null }>;
    release: () => Promise<void>;
    [Symbol.asyncDispose]: () => Promise<void>;
  }>;
  extMethod?: (toolName: string, params: Record<string, unknown>) => Promise<unknown>;
}): {
  router: ToolRouter;
  writeCalls: Array<{ sessionId: string; path: string; content: string }>;
} {
  const writeCalls: Array<{ sessionId: string; path: string; content: string }> = [];

  const connection = {
    readTextFile:
      overrides?.readTextFile ??
      (async () => {
        throw new Error("readTextFile not implemented for this test");
      }),
    writeTextFile:
      overrides?.writeTextFile ??
      (async (input: { sessionId: string; path: string; content: string }) => {
        writeCalls.push(input);
        return {};
      }),
    createTerminal:
      overrides?.createTerminal ??
      (async () => {
        return {
          id: "term-1",
          currentOutput: async () => ({ output: "", truncated: false }),
          waitForExit: async () => ({ exitCode: 0 }),
          release: async () => undefined,
          [Symbol.asyncDispose]: async () => undefined,
        };
      }),
    requestPermission: async () => ({
      outcome: { outcome: "selected", optionId: "allow_once" },
    }),
    extMethod:
      overrides?.extMethod ??
      (async () => {
        throw new Error("extMethod not implemented for this test");
      }),
  } as unknown as AgentSideConnection;

  const router = new ToolRouter(connection);
  router.setEditorCapabilities({
    editorSupportsFsRead: true,
    editorSupportsFsWrite: true,
    editorSupportsTerminal: true,
  });
  router.registerSession("session-1", "local");

  return { router, writeCalls };
}

describe("ACP ToolRouter", () => {
  it("does not delegate unknown filesystem tools via generic fs capabilities", () => {
    const { router } = createRouter();

    expect(router.shouldDelegateToEditor("session-1", "file_custom_unknown")).toBe(false);
    expect(router.shouldDelegateToEditor("session-1", "fs/custom_tool")).toBe(false);
  });

  it("returns bash command output when delegating terminal calls", async () => {
    const { router } = createRouter({
      createTerminal: async () => ({
        id: "term-1",
        currentOutput: async () => ({ output: "hello\n", truncated: false }),
        waitForExit: async () => ({ exitCode: 0 }),
        release: async () => undefined,
        [Symbol.asyncDispose]: async () => undefined,
      }),
    });

    const result = await router.delegateToEditor("session-1", "bash", {
      script: "echo hello",
    });

    expect(result).toMatchObject({
      success: true,
      output: "hello\n",
      exitCode: 0,
    });
    expect(result).toEqual(
      expect.objectContaining({
        wall_duration_ms: expect.any(Number),
      })
    );
  });

  it("reads terminal output after delegated command exit", async () => {
    let waitForExitResolved = false;
    const callOrder: string[] = [];

    const { router } = createRouter({
      createTerminal: async () => ({
        id: "term-1",
        currentOutput: async () => {
          callOrder.push("currentOutput");
          return {
            output: waitForExitResolved ? "final output\n" : "stale output\n",
            truncated: false,
          };
        },
        waitForExit: async () => {
          callOrder.push("waitForExit");
          waitForExitResolved = true;
          return { exitCode: 0 };
        },
        release: async () => undefined,
        [Symbol.asyncDispose]: async () => undefined,
      }),
    });

    const result = await router.delegateToEditor("session-1", "bash", {
      script: "echo hello",
    });

    expect(result).toMatchObject({
      success: true,
      output: "final output\n",
      exitCode: 0,
    });
    expect(callOrder).toEqual(["waitForExit", "currentOutput"]);
  });

  it("honors run_in_background for delegated bash calls", async () => {
    let waitForExitCalls = 0;
    let currentOutputCalls = 0;

    const { router } = createRouter({
      createTerminal: async () => ({
        id: "bg-123",
        currentOutput: async () => {
          currentOutputCalls += 1;
          return { output: "", truncated: false };
        },
        waitForExit: async () => {
          waitForExitCalls += 1;
          return { exitCode: 0 };
        },
        release: async () => undefined,
        [Symbol.asyncDispose]: async () => undefined,
      }),
    });

    const result = await router.delegateToEditor("session-1", "bash", {
      script: "bun run dev",
      run_in_background: true,
    });

    expect(result).toMatchObject({
      success: true,
      output: "Background process started with ID: bg-123",
      exitCode: 0,
      taskId: "bash:bg-123",
      backgroundProcessId: "bg-123",
    });
    expect(waitForExitCalls).toBe(0);
    expect(currentOutputCalls).toBe(0);
  });

  it("delegates file_edit_replace_string through editor fs read/write", async () => {
    const { router, writeCalls } = createRouter({
      readTextFile: async () => ({ content: "hello world" }),
    });

    const result = await router.delegateToEditor("session-1", "file_edit_replace_string", {
      path: "/repo/file.txt",
      old_string: "world",
      new_string: "mux",
    });

    expect(result).toEqual({ success: true, edits_applied: 1 });
    expect(writeCalls).toEqual([
      {
        sessionId: "session-1",
        path: "/repo/file.txt",
        content: "hello mux",
      },
    ]);
  });

  it("delegates file_edit_insert through editor fs read/write", async () => {
    const { router, writeCalls } = createRouter({
      readTextFile: async () => ({ content: "abc" }),
    });

    const result = await router.delegateToEditor("session-1", "file_edit_insert", {
      path: "/repo/file.txt",
      content: "X",
      insert_after: "a",
    });

    expect(result).toEqual({ success: true });
    expect(writeCalls).toEqual([
      {
        sessionId: "session-1",
        path: "/repo/file.txt",
        content: "aXbc",
      },
    ]);
  });
});

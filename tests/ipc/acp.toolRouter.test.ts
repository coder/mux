import { describe, expect, it } from "bun:test";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { ToolRouter } from "../../src/node/acp/toolRouter";

function createRouter(overrides?: {
  readTextFile?: (input: { sessionId: string; path: string }) => Promise<{ content: string }>;
  writeTextFile?: (input: { sessionId: string; path: string; content: string }) => Promise<unknown>;
  createTerminal?: (input: Record<string, unknown>) => Promise<{ id: string }>;
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
        return { id: "term-1" };
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

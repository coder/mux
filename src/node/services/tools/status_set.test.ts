import { describe, it, expect } from "bun:test";
import type { ToolCallOptions } from "ai";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import { createStatusSetTool } from "./status_set";

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("status_set tool", () => {
  const emitted: Array<{ event: string; payload: unknown }> = [];

  const mockConfig: ToolConfiguration = {
    cwd: "/tmp",
    runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
    runtimeTempDir: "/tmp",
    workspaceId: "test-workspace",
    emitAIEvent: (event, payload) => emitted.push({ event, payload }),
  };

  const mockToolCallOptions: ToolCallOptions = {
    toolCallId: "test-call-id",
    messages: [],
  };

  it("registers a script status and emits agent-status-update", async () => {
    emitted.length = 0;
    const tool = createStatusSetTool(mockConfig);

    expect(
      await tool.execute!(
        {
          script: "echo '🚀 PR #123 waiting https://github.com/example/repo/pull/123'",
          poll_interval_ms: 0,
        },
        mockToolCallOptions
      )
    ).toEqual({ success: true });

    await waitFor(() => emitted.some((e) => e.event === "agent-status-update"));

    const found = emitted.find((e) => e.event === "agent-status-update");
    expect(found).toBeDefined();
    if (!found) {
      throw new Error("Missing agent-status-update event");
    }

    const payload = found.payload as {
      type: string;
      workspaceId: string;
      status: { emoji?: string; message: string; url?: string };
    };

    expect(payload.type).toBe("agent-status-update");
    expect(payload.workspaceId).toBe("test-workspace");
    expect(payload.status).toEqual({
      emoji: "🚀",
      message: "PR #123 waiting",
      url: "https://github.com/example/repo/pull/123",
    });
  });
});

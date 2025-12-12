import { describe, it, expect } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import type { ToolCallOptions } from "ai";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import { createStatusSetTool } from "./status_set";
import { StatusSetService } from "@/node/services/statusSetService";
import { Config } from "@/node/config";
import { TestTempDir } from "./testHelpers";

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
  const mockToolCallOptions: ToolCallOptions = {
    toolCallId: "test-call-id",
    messages: [],
  };

  it("registers a script status, persists it, and rehydrates snapshot", async () => {
    using tempRoot = new TestTempDir("status-set-root");
    using tempProject = new TestTempDir("status-set-project");

    const emitted: Array<{ event: string; payload: unknown }> = [];

    const config = new Config(tempRoot.path);
    // Ensure sessions dir exists for SessionFileManager
    await fs.mkdir(config.sessionsDir, { recursive: true });

    const statusSetService = new StatusSetService(config, (event, payload) => {
      emitted.push({ event, payload });
    });

    const workspaceId = "test-workspace";

    // Tool calls run in a real runtime context. Use LocalRuntime for deterministic cwd.
    const mockConfig: ToolConfiguration = {
      cwd: tempProject.path,
      runtime: createRuntime({ type: "local" }, { projectPath: tempProject.path }),
      runtimeTempDir: tempProject.path,
      workspaceId,
      statusSetService,
    };

    const tool = createStatusSetTool(mockConfig);

    expect(
      await tool.execute!(
        {
          script: "echo '🚀 PR #123 waiting https://github.com/example/repo/pull/123'",
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
    expect(payload.workspaceId).toBe(workspaceId);
    expect(payload.status).toEqual({
      emoji: "🚀",
      message: "PR #123 waiting",
      url: "https://github.com/example/repo/pull/123",
    });

    // Persisted state should include the script, and lastStatus for restart robustness.
    const persistedPath = path.join(config.getSessionDir(workspaceId), "status_set.json");
    const persistedRaw = await fs.readFile(persistedPath, "utf-8");
    const persisted = JSON.parse(persistedRaw) as {
      script: string;
      lastStatus?: { message: string; url?: string; emoji?: string };
    };

    expect(persisted.script).toContain("PR #123");
    expect(persisted.lastStatus).toEqual(payload.status);

    // Simulate restart: new service instance should load snapshot from disk.
    const statusSetService2 = new StatusSetService(config, () => undefined);
    await statusSetService2.ensureRunning(workspaceId);

    expect(statusSetService2.getSnapshot(workspaceId)).toEqual({
      type: "agent-status-update",
      workspaceId,
      status: payload.status,
    });
  });
});

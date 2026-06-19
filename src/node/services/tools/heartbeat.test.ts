import { describe, expect, mock, test } from "bun:test";

import { Ok } from "@/common/types/result";
import type { HeartbeatToolArgs, HeartbeatToolResult } from "@/common/types/tools";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type {
  WorkspaceHeartbeatSettingsUpdate,
  WorkspaceHeartbeatToolService,
} from "@/common/utils/tools/tools";
import { HEARTBEAT_DEFAULT_CONTEXT_MODE } from "@/constants/heartbeat";
import { createHeartbeatTool } from "./heartbeat";
import { createTestToolConfig, mockToolCallOptions, TestTempDir } from "./testHelpers";

type WorkspaceHeartbeatSettings = NonNullable<WorkspaceMetadata["heartbeat"]>;

function createService(initial: WorkspaceHeartbeatSettings | null = null): {
  service: WorkspaceHeartbeatToolService;
  getStored: () => WorkspaceHeartbeatSettings | null;
} {
  let stored = initial;
  const service: WorkspaceHeartbeatToolService = {
    getHeartbeatSettings: mock((workspaceId: string) => {
      expect(workspaceId).toBe("ws-heartbeat");
      return stored;
    }),
    setHeartbeatSettings: mock(
      (workspaceId: string, settings: WorkspaceHeartbeatSettingsUpdate) => {
        expect(workspaceId).toBe("ws-heartbeat");
        const hasMessageUpdate = Object.prototype.hasOwnProperty.call(settings, "message");
        const nextMessage = hasMessageUpdate ? settings.message?.trim() : stored?.message;
        stored = {
          enabled: settings.enabled ?? stored?.enabled ?? true,
          intervalMs: settings.intervalMs ?? stored?.intervalMs ?? 15 * 60 * 1000,
          contextMode:
            settings.contextMode ?? stored?.contextMode ?? HEARTBEAT_DEFAULT_CONTEXT_MODE,
          ...(nextMessage ? { message: nextMessage } : {}),
        };
        return Promise.resolve(Ok(stored));
      }
    ),
    unsetHeartbeatSettings: mock((workspaceId: string) => {
      expect(workspaceId).toBe("ws-heartbeat");
      stored = null;
      return Promise.resolve(Ok(undefined));
    }),
  };
  return { service, getStored: () => stored };
}

async function execute(
  service: WorkspaceHeartbeatToolService | undefined,
  args: HeartbeatToolArgs
): Promise<HeartbeatToolResult> {
  using tempDir = new TestTempDir("heartbeat-tool-test");
  const tool = createHeartbeatTool({
    ...createTestToolConfig(tempDir.path, { workspaceId: "ws-heartbeat" }),
    ...(service ? { workspaceHeartbeatService: service } : {}),
  });
  const result: unknown = await Promise.resolve(tool.execute!(args, mockToolCallOptions));
  return result as HeartbeatToolResult;
}

describe("heartbeat tool", () => {
  test("gets current heartbeat settings for the owning workspace", async () => {
    const current = {
      enabled: true,
      intervalMs: 30 * 60 * 1000,
      contextMode: "compact" as const,
      message: "Review idle work.",
    };
    const { service } = createService(current);

    const result = await execute(service, { action: "get" });

    expect(result).toEqual({
      success: true,
      action: "get",
      configured: true,
      settings: current,
      summary: "Heartbeat is enabled for this workspace at 30 minutes.",
    });
  });

  test("set creates an enabled heartbeat from global defaults", async () => {
    const { service, getStored } = createService(null);

    const result = await execute(service, { action: "set" });

    expect(result.success).toBe(true);
    expect(getStored()).toEqual({
      enabled: true,
      intervalMs: 15 * 60 * 1000,
      contextMode: HEARTBEAT_DEFAULT_CONTEXT_MODE,
    });
  });

  test("set updates only provided fields and can clear the custom message", async () => {
    const { service, getStored } = createService({
      enabled: true,
      intervalMs: 30 * 60 * 1000,
      contextMode: "reset",
      message: "Old custom prompt",
    });

    const result = await execute(service, {
      action: "set",
      intervalMs: 45 * 60 * 1000,
      message: "",
    });

    expect(result.success).toBe(true);
    expect(getStored()).toEqual({
      enabled: true,
      intervalMs: 45 * 60 * 1000,
      contextMode: "reset",
    });
  });

  test("unset removes heartbeat settings", async () => {
    const { service, getStored } = createService({
      enabled: true,
      intervalMs: 30 * 60 * 1000,
      contextMode: "normal",
    });

    const result = await execute(service, { action: "unset" });

    expect(result).toEqual({
      success: true,
      action: "unset",
      configured: false,
      settings: null,
      summary: "Heartbeat settings removed for this workspace.",
    });
    expect(getStored()).toBeNull();
  });

  test("returns a typed error when the service is unavailable", async () => {
    const result = await execute(undefined, { action: "get" });

    expect(result).toEqual({ success: false, error: "Heartbeat service is unavailable" });
  });
});

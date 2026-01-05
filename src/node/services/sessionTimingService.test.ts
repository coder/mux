import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { Config } from "@/node/config";
import { SessionTimingService } from "./sessionTimingService";
import type { TelemetryService } from "./telemetryService";
import { normalizeGatewayModel } from "@/common/utils/ai/models";

function createMockTelemetryService(): Pick<TelemetryService, "capture" | "getFeatureFlag"> {
  return {
    capture: mock(() => undefined),
    getFeatureFlag: mock(() => Promise.resolve(undefined)),
  };
}

describe("SessionTimingService", () => {
  let tempDir: string;
  let config: Config;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `mux-session-timing-test-${Date.now()}-${Math.random()}`);
    await fs.mkdir(tempDir, { recursive: true });
    config = new Config(tempDir);
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("persists completed stream stats to session-timing.json", async () => {
    const telemetry = createMockTelemetryService();
    const service = new SessionTimingService(config, telemetry as unknown as TelemetryService);
    service.setStatsTabState({ enabled: true, variant: "stats", override: "default" });

    const workspaceId = "test-workspace";
    const messageId = "m1";
    const model = "openai:gpt-4o";
    const startTime = 1_000_000;

    service.handleStreamStart({
      type: "stream-start",
      workspaceId,
      messageId,
      model,
      historySequence: 1,
      startTime,
      mode: "exec",
    });

    service.handleStreamDelta({
      type: "stream-delta",
      workspaceId,
      messageId,
      delta: "hi",
      tokens: 5,
      timestamp: startTime + 1000,
    });

    service.handleToolCallStart({
      type: "tool-call-start",
      workspaceId,
      messageId,
      toolCallId: "t1",
      toolName: "bash",
      args: { cmd: "echo hi" },
      tokens: 3,
      timestamp: startTime + 2000,
    });

    service.handleToolCallEnd({
      type: "tool-call-end",
      workspaceId,
      messageId,
      toolCallId: "t1",
      toolName: "bash",
      result: { ok: true },
      timestamp: startTime + 3000,
    });

    service.handleStreamEnd({
      type: "stream-end",
      workspaceId,
      messageId,
      metadata: {
        model,
        duration: 5000,
        usage: {
          inputTokens: 1,
          outputTokens: 10,
          totalTokens: 11,
          reasoningTokens: 2,
        },
      },
      parts: [],
    });

    await service.waitForIdle(workspaceId);

    const filePath = path.join(config.getSessionDir(workspaceId), "session-timing.json");
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    expect(typeof parsed).toBe("object");
    expect(parsed).not.toBeNull();

    const file = await service.getSnapshot(workspaceId);
    expect(file.lastRequest?.messageId).toBe(messageId);
    expect(file.lastRequest?.totalDurationMs).toBe(5000);
    expect(file.lastRequest?.toolExecutionMs).toBe(1000);
    expect(file.lastRequest?.ttftMs).toBe(1000);
    expect(file.lastRequest?.streamingMs).toBe(3000);
    expect(file.lastRequest?.invalid).toBe(false);

    expect(file.session?.responseCount).toBe(1);
    expect(file.session?.totalDurationMs).toBe(5000);
    expect(file.session?.totalToolExecutionMs).toBe(1000);
    expect(file.session?.totalStreamingMs).toBe(3000);
    expect(file.session?.totalOutputTokens).toBe(10);
    expect(file.session?.totalReasoningTokens).toBe(2);

    const normalizedModel = normalizeGatewayModel(model);
    const key = `${normalizedModel}:exec`;
    expect(file.session?.byModel[key]).toBeDefined();
    expect(file.session?.byModel[key]?.responseCount).toBe(1);
  });

  it("emits invalid timing telemetry when tool percent would exceed 100%", async () => {
    const telemetry = createMockTelemetryService();
    const service = new SessionTimingService(config, telemetry as unknown as TelemetryService);
    service.setStatsTabState({ enabled: true, variant: "stats", override: "default" });

    const workspaceId = "test-workspace";
    const messageId = "m1";
    const model = "openai:gpt-4o";
    const startTime = 2_000_000;

    service.handleStreamStart({
      type: "stream-start",
      workspaceId,
      messageId,
      model,
      historySequence: 1,
      startTime,
    });

    // Tool runs 10s, but we lie in metadata.duration=1s.
    service.handleToolCallStart({
      type: "tool-call-start",
      workspaceId,
      messageId,
      toolCallId: "t1",
      toolName: "bash",
      args: { cmd: "sleep" },
      tokens: 1,
      timestamp: startTime + 100,
    });

    service.handleToolCallEnd({
      type: "tool-call-end",
      workspaceId,
      messageId,
      toolCallId: "t1",
      toolName: "bash",
      result: { ok: true },
      timestamp: startTime + 10_100,
    });

    service.handleStreamEnd({
      type: "stream-end",
      workspaceId,
      messageId,
      metadata: {
        model,
        duration: 1000,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        },
      },
      parts: [],
    });

    await service.waitForIdle(workspaceId);

    expect(telemetry.capture).toHaveBeenCalled();

    // Bun's mock() returns a callable with `.mock.calls`, but our TelemetryService typing
    // does not expose that. Introspect via unknown.
    const calls = (telemetry.capture as unknown as { mock: { calls: Array<[unknown]> } }).mock
      .calls;

    const invalidCalls = calls.filter((c) => {
      const payload = c[0];
      if (!payload || typeof payload !== "object") {
        return false;
      }

      return (
        "event" in payload && (payload as { event?: unknown }).event === "stream_timing_invalid"
      );
    });

    expect(invalidCalls.length).toBeGreaterThan(0);
  });
});

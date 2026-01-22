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

  it("persists aborted stream stats to session-timing.json", async () => {
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

    service.handleStreamAbort({
      type: "stream-abort",
      workspaceId,
      messageId,
      metadata: {
        duration: 5000,
        usage: {
          inputTokens: 1,
          outputTokens: 10,
          totalTokens: 11,
          reasoningTokens: 2,
        },
      },
      abortReason: "system",
      abandonPartial: true,
    });

    await service.waitForIdle(workspaceId);

    const snapshot = await service.getSnapshot(workspaceId);
    expect(snapshot.lastRequest?.messageId).toBe(messageId);
    expect(snapshot.lastRequest?.totalDurationMs).toBe(5000);
    expect(snapshot.lastRequest?.toolExecutionMs).toBe(1000);
    expect(snapshot.lastRequest?.ttftMs).toBe(1000);
    expect(snapshot.lastRequest?.streamingMs).toBe(3000);
    expect(snapshot.lastRequest?.invalid).toBe(false);

    expect(snapshot.session?.responseCount).toBe(1);
  });

  it("ignores empty aborted streams", async () => {
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

    service.handleStreamAbort({
      type: "stream-abort",
      workspaceId,
      messageId,
      metadata: { duration: 1000 },
      abortReason: "user",
      abandonPartial: true,
    });

    await service.waitForIdle(workspaceId);

    const snapshot = await service.getSnapshot(workspaceId);
    expect(snapshot.lastRequest).toBeUndefined();
    expect(snapshot.session?.responseCount).toBe(0);
  });

  describe("rollUpTimingIntoParent", () => {
    it("should roll up child timing into parent without changing parent's lastRequest", async () => {
      const telemetry = createMockTelemetryService();
      const service = new SessionTimingService(config, telemetry as unknown as TelemetryService);
      service.setStatsTabState({ enabled: true, variant: "stats", override: "default" });

      const projectPath = "/tmp/mux-session-timing-rollup-test-project";
      const model = "openai:gpt-4o";

      const parentWorkspaceId = "parent-workspace";
      const childWorkspaceId = "child-workspace";

      await config.addWorkspace(projectPath, {
        id: parentWorkspaceId,
        name: "parent-branch",
        projectName: "test-project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      await config.addWorkspace(projectPath, {
        id: childWorkspaceId,
        name: "child-branch",
        projectName: "test-project",
        projectPath,
        runtimeConfig: { type: "local" },
        parentWorkspaceId: parentWorkspaceId,
      });

      // Parent stream.
      const parentMessageId = "p1";
      const startTimeParent = 1_000_000;

      service.handleStreamStart({
        type: "stream-start",
        workspaceId: parentWorkspaceId,
        messageId: parentMessageId,
        model,
        historySequence: 1,
        startTime: startTimeParent,
        mode: "exec",
      });

      service.handleStreamDelta({
        type: "stream-delta",
        workspaceId: parentWorkspaceId,
        messageId: parentMessageId,
        delta: "hi",
        tokens: 5,
        timestamp: startTimeParent + 1000,
      });

      service.handleToolCallStart({
        type: "tool-call-start",
        workspaceId: parentWorkspaceId,
        messageId: parentMessageId,
        toolCallId: "t1",
        toolName: "bash",
        args: { cmd: "echo hi" },
        tokens: 3,
        timestamp: startTimeParent + 2000,
      });

      service.handleToolCallEnd({
        type: "tool-call-end",
        workspaceId: parentWorkspaceId,
        messageId: parentMessageId,
        toolCallId: "t1",
        toolName: "bash",
        result: { ok: true },
        timestamp: startTimeParent + 3000,
      });

      service.handleStreamEnd({
        type: "stream-end",
        workspaceId: parentWorkspaceId,
        messageId: parentMessageId,
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

      // Child stream.
      const childMessageId = "c1";
      const startTimeChild = 2_000_000;

      service.handleStreamStart({
        type: "stream-start",
        workspaceId: childWorkspaceId,
        messageId: childMessageId,
        model,
        historySequence: 1,
        startTime: startTimeChild,
        mode: "exec",
      });

      service.handleStreamDelta({
        type: "stream-delta",
        workspaceId: childWorkspaceId,
        messageId: childMessageId,
        delta: "hi",
        tokens: 5,
        timestamp: startTimeChild + 200,
      });

      service.handleStreamEnd({
        type: "stream-end",
        workspaceId: childWorkspaceId,
        messageId: childMessageId,
        metadata: {
          model,
          duration: 1500,
          usage: {
            inputTokens: 1,
            outputTokens: 5,
            totalTokens: 6,
          },
        },
        parts: [],
      });

      await service.waitForIdle(parentWorkspaceId);
      await service.waitForIdle(childWorkspaceId);

      const before = await service.getSnapshot(parentWorkspaceId);
      expect(before.lastRequest?.messageId).toBe(parentMessageId);

      const beforeLastRequest = before.lastRequest!;

      const rollupResult = await service.rollUpTimingIntoParent(
        parentWorkspaceId,
        childWorkspaceId
      );
      expect(rollupResult.didRollUp).toBe(true);

      const after = await service.getSnapshot(parentWorkspaceId);

      // lastRequest is preserved
      expect(after.lastRequest).toEqual(beforeLastRequest);

      expect(after.session?.responseCount).toBe(2);
      expect(after.session?.totalDurationMs).toBe(6500);
      expect(after.session?.totalToolExecutionMs).toBe(1000);
      expect(after.session?.totalStreamingMs).toBe(4300);
      expect(after.session?.totalTtftMs).toBe(1200);
      expect(after.session?.ttftCount).toBe(2);
      expect(after.session?.totalOutputTokens).toBe(15);
      expect(after.session?.totalReasoningTokens).toBe(2);

      const normalizedModel = normalizeGatewayModel(model);
      const key = `${normalizedModel}:exec`;
      expect(after.session?.byModel[key]?.responseCount).toBe(2);
    });

    it("should be idempotent for the same child workspace", async () => {
      const telemetry = createMockTelemetryService();
      const service = new SessionTimingService(config, telemetry as unknown as TelemetryService);
      service.setStatsTabState({ enabled: true, variant: "stats", override: "default" });

      const projectPath = "/tmp/mux-session-timing-rollup-test-project";
      const model = "openai:gpt-4o";

      const parentWorkspaceId = "parent-workspace";
      const childWorkspaceId = "child-workspace";

      await config.addWorkspace(projectPath, {
        id: parentWorkspaceId,
        name: "parent-branch",
        projectName: "test-project",
        projectPath,
        runtimeConfig: { type: "local" },
      });

      // Child stream.
      const childMessageId = "c1";
      const startTimeChild = 2_000_000;

      service.handleStreamStart({
        type: "stream-start",
        workspaceId: childWorkspaceId,
        messageId: childMessageId,
        model,
        historySequence: 1,
        startTime: startTimeChild,
        mode: "exec",
      });

      service.handleStreamDelta({
        type: "stream-delta",
        workspaceId: childWorkspaceId,
        messageId: childMessageId,
        delta: "hi",
        tokens: 5,
        timestamp: startTimeChild + 200,
      });

      service.handleStreamEnd({
        type: "stream-end",
        workspaceId: childWorkspaceId,
        messageId: childMessageId,
        metadata: {
          model,
          duration: 1500,
          usage: {
            inputTokens: 1,
            outputTokens: 5,
            totalTokens: 6,
          },
        },
        parts: [],
      });

      await service.waitForIdle(childWorkspaceId);

      const first = await service.rollUpTimingIntoParent(parentWorkspaceId, childWorkspaceId);
      expect(first.didRollUp).toBe(true);

      const second = await service.rollUpTimingIntoParent(parentWorkspaceId, childWorkspaceId);
      expect(second.didRollUp).toBe(false);

      const result = await service.getSnapshot(parentWorkspaceId);
      expect(result.session?.responseCount).toBe(1);

      const timingFilePath = path.join(
        config.getSessionDir(parentWorkspaceId),
        "session-timing.json"
      );
      const raw = await fs.readFile(timingFilePath, "utf-8");
      const parsed = JSON.parse(raw) as { rolledUpFrom?: Record<string, true> };
      expect(parsed.rolledUpFrom?.[childWorkspaceId]).toBe(true);
    });
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

  it("does not double-count overlapping tool calls", async () => {
    const telemetry = createMockTelemetryService();
    const service = new SessionTimingService(config, telemetry as unknown as TelemetryService);
    service.setStatsTabState({ enabled: true, variant: "stats", override: "default" });

    const workspaceId = "test-workspace";
    const messageId = "m1";
    const model = "openai:gpt-4o";
    const startTime = 3_000_000;

    service.handleStreamStart({
      type: "stream-start",
      workspaceId,
      messageId,
      model,
      historySequence: 1,
      startTime,
      mode: "exec",
    });

    // First token arrives quickly.
    service.handleStreamDelta({
      type: "stream-delta",
      workspaceId,
      messageId,
      delta: "hi",
      tokens: 2,
      timestamp: startTime + 500,
    });

    // Two tools overlap: [1000, 3000] and [1500, 4000]
    service.handleToolCallStart({
      type: "tool-call-start",
      workspaceId,
      messageId,
      toolCallId: "t1",
      toolName: "bash",
      args: { cmd: "sleep 2" },
      tokens: 1,
      timestamp: startTime + 1000,
    });

    service.handleToolCallStart({
      type: "tool-call-start",
      workspaceId,
      messageId,
      toolCallId: "t2",
      toolName: "bash",
      args: { cmd: "sleep 3" },
      tokens: 1,
      timestamp: startTime + 1500,
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

    service.handleToolCallEnd({
      type: "tool-call-end",
      workspaceId,
      messageId,
      toolCallId: "t2",
      toolName: "bash",
      result: { ok: true },
      timestamp: startTime + 4000,
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
          outputTokens: 1,
          totalTokens: 2,
        },
      },
      parts: [],
    });

    await service.waitForIdle(workspaceId);

    const snapshot = await service.getSnapshot(workspaceId);
    expect(snapshot.lastRequest?.totalDurationMs).toBe(5000);

    // Tool wall-time should be the union: [1000, 4000] = 3000ms.
    expect(snapshot.lastRequest?.toolExecutionMs).toBe(3000);
    expect(snapshot.lastRequest?.toolExecutionMs).toBeLessThanOrEqual(
      snapshot.lastRequest?.totalDurationMs ?? 0
    );

    expect(snapshot.lastRequest?.ttftMs).toBe(500);
    expect(snapshot.lastRequest?.streamingMs).toBe(1500);
    expect(snapshot.lastRequest?.invalid).toBe(false);
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

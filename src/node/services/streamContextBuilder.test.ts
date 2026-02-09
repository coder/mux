import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { sliceMessagesFromLatestCompactionBoundary } from "@/common/utils/messages/compactionBoundary";
import { createMuxMessage } from "@/common/types/message";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
import { getPlanFilePath } from "@/common/utils/planStorage";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";

import { buildPlanInstructions } from "./streamContextBuilder";

class TestRuntime extends LocalRuntime {
  constructor(
    projectPath: string,
    private readonly muxHomePath: string
  ) {
    super(projectPath);
  }

  override getMuxHome(): string {
    return this.muxHomePath;
  }
}

describe("buildPlanInstructions", () => {
  test("uses request payload history for Start Here detection", async () => {
    using tempRoot = new DisposableTempDir("stream-context-builder");

    const projectPath = path.join(tempRoot.path, "project");
    const muxHome = path.join(tempRoot.path, "mux-home");
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(muxHome, { recursive: true });

    const metadata: WorkspaceMetadata = {
      id: "ws-1",
      name: "workspace-1",
      projectName: "project-1",
      projectPath,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };

    const runtime = new TestRuntime(projectPath, muxHome);

    const planFilePath = getPlanFilePath(metadata.name, metadata.projectName, muxHome);
    await fs.mkdir(path.dirname(planFilePath), { recursive: true });
    await fs.writeFile(planFilePath, "# Plan\n\n- Keep implementing", "utf-8");

    const startHereSummary = createMuxMessage(
      "start-here",
      "assistant",
      "# Start Here\n\n- Existing plan context\n\n*Plan file preserved at:* /tmp/plan.md",
      {
        compacted: "user",
        agentId: "plan",
      }
    );

    const compactionBoundary = createMuxMessage("boundary", "assistant", "Compacted summary", {
      compacted: "user",
      compactionBoundary: true,
      compactionEpoch: 1,
    });

    const latestUserMessage = createMuxMessage("u1", "user", "continue implementation");

    const fullHistory = [startHereSummary, compactionBoundary, latestUserMessage];
    const requestPayloadMessages = sliceMessagesFromLatestCompactionBoundary(fullHistory);

    expect(requestPayloadMessages.map((message) => message.id)).toEqual(["boundary", "u1"]);

    const fromSlicedPayload = await buildPlanInstructions({
      runtime,
      metadata,
      workspaceId: metadata.id,
      workspacePath: projectPath,
      effectiveMode: "exec",
      effectiveAgentId: "exec",
      agentIsPlanLike: false,
      agentDiscoveryPath: projectPath,
      additionalSystemInstructions: undefined,
      shouldDisableTaskToolsForDepth: false,
      taskDepth: 0,
      taskSettings: DEFAULT_TASK_SETTINGS,
      requestPayloadMessages,
    });

    const fromFullHistory = await buildPlanInstructions({
      runtime,
      metadata,
      workspaceId: metadata.id,
      workspacePath: projectPath,
      effectiveMode: "exec",
      effectiveAgentId: "exec",
      agentIsPlanLike: false,
      agentDiscoveryPath: projectPath,
      additionalSystemInstructions: undefined,
      shouldDisableTaskToolsForDepth: false,
      taskDepth: 0,
      taskSettings: DEFAULT_TASK_SETTINGS,
      requestPayloadMessages: fullHistory,
    });

    expect(fromSlicedPayload.effectiveAdditionalInstructions).toContain(
      `A plan file exists at: ${fromSlicedPayload.planFilePath}`
    );
    expect(fromFullHistory.effectiveAdditionalInstructions).toBeUndefined();
  });
});

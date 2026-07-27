import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import { getAvailableTools } from "@/common/utils/tools/toolDefinitions";
import { getToolsForModel } from "@/common/utils/tools/tools";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import { TimelineService } from "@/node/services/timelineService";
import { createTestToolConfig, getTestDeps } from "./testHelpers";
import { createTimelineMarkTool } from "./timeline_mark";

const WORKSPACE_ID = "timeline-mark-workspace";

function options(toolCallId: string): ToolExecutionOptions<unknown> {
  return { toolCallId, messages: [], context: undefined };
}

describe("timeline_mark tool", () => {
  let timelineService: TimelineService;
  let tempDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testHistory = await createTestHistoryService();
    tempDir = testHistory.tempDir;
    cleanup = testHistory.cleanup;
    timelineService = new TimelineService(testHistory.config, testHistory.historyService, {
      isExperimentEnabled: () => true,
    });
  });

  afterEach(async () => {
    await timelineService.flush();
    await cleanup();
  });

  test("appends an agent mark", async () => {
    const tool = createTimelineMarkTool({
      ...createTestToolConfig(tempDir, { workspaceId: WORKSPACE_ID }),
      timelineService,
    });

    const result: unknown = await tool.execute!(
      { label: "Backend complete", detail: "All service tests pass", category: "milestone" },
      options("mark-1")
    );
    await timelineService.flush();

    expect(result).toEqual({ success: true, recorded: true });
    const page = await timelineService.list(WORKSPACE_ID, {});
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({
      kind: "agent.mark",
      source: { system: "agent", key: "timeline-mark:mark-1" },
      anchor: { toolCallId: "mark-1" },
      data: {
        label: "Backend complete",
        detail: "All service tests pass",
        category: "milestone",
      },
    });
  });

  test("drops duplicate labels and marks over the per-turn cap", async () => {
    const tool = createTimelineMarkTool({
      ...createTestToolConfig(tempDir, { workspaceId: WORKSPACE_ID }),
      timelineService,
    });

    const first: unknown = await tool.execute!({ label: "One" }, options("mark-1"));
    const duplicate: unknown = await tool.execute!({ label: "One" }, options("mark-2"));
    for (let index = 2; index <= 5; index++) {
      await tool.execute!({ label: `Mark ${index}` }, options(`mark-${index + 1}`));
    }
    const overLimit: unknown = await tool.execute!({ label: "Mark 6" }, options("mark-7"));
    await timelineService.flush();

    expect(first).toEqual({ success: true, recorded: true });
    expect(duplicate).toEqual({ success: true, recorded: false });
    expect(overLimit).toEqual({ success: true, recorded: false });
    expect((await timelineService.list(WORKSPACE_ID, {})).events).toHaveLength(5);
  });

  test("is absent from getToolsForModel when the experiment is off", async () => {
    const config = {
      ...createTestToolConfig(tempDir, { workspaceId: WORKSPACE_ID }),
      timelineService,
      experiments: { timeline: false },
    };
    const { initStateManager } = getTestDeps();

    const tools = await getToolsForModel(
      "anthropic:claude-sonnet-4-20250514",
      config,
      WORKSPACE_ID,
      initStateManager
    );
    expect(tools.timeline_mark).toBeUndefined();
  });

  test("is absent from the allowlist when disabled", () => {
    expect(
      getAvailableTools("anthropic:claude-sonnet-4-20250514", {
        enableTimelineMark: false,
      })
    ).not.toContain("timeline_mark");
  });
});

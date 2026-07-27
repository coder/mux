import { tool } from "ai";
import assert from "@/common/utils/assert";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolFactory } from "@/common/utils/tools/tools";

const MAX_EVENTS_PER_TURN = 5;
const DUPLICATE_DESCRIPTION_WINDOW_MS = 30_000;

export const createTimelineEventTool: ToolFactory = (config) => {
  let recordedCount = 0;
  const recentDescriptions = new Map<string, number>();

  return tool({
    description: TOOL_DEFINITIONS.timeline_event.description,
    inputSchema: TOOL_DEFINITIONS.timeline_event.schema,
    execute: ({ description, category }, options) => {
      assert(config.workspaceId, "timeline_event requires workspaceId");
      assert(config.timelineService, "timeline_event requires timelineService");

      const normalizedDescription = description.trim();
      assert(normalizedDescription.length > 0, "timeline_event requires a non-empty description");
      const now = Date.now();
      const previous = recentDescriptions.get(normalizedDescription);
      if (
        recordedCount >= MAX_EVENTS_PER_TURN ||
        (previous != null && now - previous < DUPLICATE_DESCRIPTION_WINDOW_MS)
      ) {
        return { success: true as const, recorded: false as const };
      }

      recentDescriptions.set(normalizedDescription, now);
      recordedCount += 1;
      config.timelineService.record(config.workspaceId, {
        ts: now,
        kind: "agent.event",
        source: { system: "agent", key: `timeline-event:${options.toolCallId}` },
        anchor: { toolCallId: options.toolCallId },
        status: "completed",
        data: {
          description: normalizedDescription,
          ...(category != null ? { category } : {}),
        },
      });

      return { success: true as const, recorded: true as const };
    },
  });
};

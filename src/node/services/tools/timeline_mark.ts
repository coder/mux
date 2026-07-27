import { tool } from "ai";
import assert from "@/common/utils/assert";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolFactory } from "@/common/utils/tools/tools";

const MAX_MARKS_PER_TURN = 5;
const DUPLICATE_LABEL_WINDOW_MS = 30_000;

export const createTimelineMarkTool: ToolFactory = (config) => {
  let recordedCount = 0;
  const recentLabels = new Map<string, number>();

  return tool({
    description: TOOL_DEFINITIONS.timeline_mark.description,
    inputSchema: TOOL_DEFINITIONS.timeline_mark.schema,
    execute: async ({ label, detail, category }, options) => {
      assert(config.workspaceId, "timeline_mark requires workspaceId");
      assert(config.timelineService, "timeline_mark requires timelineService");

      const normalizedLabel = label.trim();
      assert(normalizedLabel.length > 0, "timeline_mark requires a non-empty label");
      const now = Date.now();
      const previous = recentLabels.get(normalizedLabel);
      if (
        recordedCount >= MAX_MARKS_PER_TURN ||
        (previous != null && now - previous < DUPLICATE_LABEL_WINDOW_MS)
      ) {
        return { success: true as const, recorded: false as const };
      }

      recentLabels.set(normalizedLabel, now);
      recordedCount += 1;
      const normalizedDetail = detail?.trim();
      config.timelineService.record(config.workspaceId, {
        ts: now,
        kind: "agent.mark",
        source: { system: "agent", key: `timeline-mark:${options.toolCallId}` },
        anchor: { toolCallId: options.toolCallId },
        status: "completed",
        data: {
          label: normalizedLabel,
          ...(normalizedDetail ? { detail: normalizedDetail } : {}),
          ...(category != null ? { category } : {}),
        },
      });

      return { success: true as const, recorded: true as const };
    },
  });
};

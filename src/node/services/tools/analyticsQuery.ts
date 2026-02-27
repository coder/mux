import assert from "node:assert/strict";
import { tool } from "ai";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolFactory } from "@/common/utils/tools/tools";

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert(
    typeof value === "object" && value != null && !Array.isArray(value),
    "Expected object result"
  );
}

/**
 * Executes read-only SQL against DuckDB analytics tables.
 */
export const createAnalyticsQueryTool: ToolFactory = (config) => {
  return tool({
    description: TOOL_DEFINITIONS.analytics_query.description,
    inputSchema: TOOL_DEFINITIONS.analytics_query.schema,
    execute: async ({ sql, visualization, title, x_axis, y_axis }) => {
      assert(
        config.analyticsService != null,
        "analytics_query tool requires ToolConfiguration.analyticsService"
      );

      try {
        const queryResult = await config.analyticsService.executeRawQuery(sql);
        assertRecord(queryResult);

        return {
          success: true,
          ...queryResult,
          ...(visualization != null ? { visualization } : {}),
          ...(title != null ? { title } : {}),
          ...(x_axis != null ? { x_axis } : {}),
          ...(y_axis != null ? { y_axis } : {}),
        };
      } catch (error) {
        return {
          success: false,
          error: getErrorMessage(error),
        };
      }
    },
  });
};

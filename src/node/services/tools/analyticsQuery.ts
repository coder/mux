import assert from "node:assert/strict";
import { tool } from "ai";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolFactory } from "@/common/utils/tools/tools";

/**
 * Maximum rows included in the tool result payload. The backend query engine
 * may return up to 10,000 rows (RAW_QUERY_ROW_LIMIT), but the full result
 * is serialized into the model's tool-message context. Capping here keeps
 * the payload small enough to avoid context exhaustion / latency spikes
 * while still providing enough data for meaningful chart visualization.
 */
export const TOOL_RESULT_ROW_LIMIT = 500;

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

        // Cap rows to avoid blowing up the LLM tool-message context.
        // rowCount reflects the actual query result size; truncated is
        // set when the returned rows are fewer than the full result.
        const allRows = queryResult.rows as Array<Record<string, unknown>>;
        assert(Array.isArray(allRows), "Expected rows array in query result");
        const cappedRows = allRows.slice(0, TOOL_RESULT_ROW_LIMIT);
        const truncated =
          (queryResult.truncated as boolean) === true || allRows.length > TOOL_RESULT_ROW_LIMIT;

        return {
          success: true,
          ...queryResult,
          rows: cappedRows,
          rowCount: allRows.length,
          truncated,
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

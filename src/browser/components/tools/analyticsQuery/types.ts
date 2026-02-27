import type { z } from "zod";
import type { ToolErrorResult } from "@/common/types/tools";
import type { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

export type AnalyticsQueryArgs = z.infer<typeof TOOL_DEFINITIONS.analytics_query.schema>;

/** Visualization type options exposed by analytics_query schema. */
export type ChartType = NonNullable<AnalyticsQueryArgs["visualization"]>;

/** Column metadata returned by the backend query result. */
export interface ColumnMeta {
  name: string;
  type: string;
}

/** Successful analytics query output shape expected by the renderer. */
export interface AnalyticsQueryResult {
  success: true;
  columns: ColumnMeta[];
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
  rowCount: number;
  durationMs: number;
  visualization?: ChartType | null;
  title?: string | null;
  x_axis?: string | null;
  y_axis?: string[] | null;
}

export type AnalyticsQueryToolResult = AnalyticsQueryResult | ToolErrorResult;

/** Context emitted when users click table cells or chart points for drill-down. */
export interface DrillDownContext {
  clickedValue: string;
  columnName: string;
  chartType: ChartType;
}

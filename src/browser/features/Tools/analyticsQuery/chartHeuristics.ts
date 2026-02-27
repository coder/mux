import assert from "@/common/utils/assert";
import type { ChartType, ColumnMeta } from "./types";

export function isNumericType(type: string): boolean {
  return /int|double|float|decimal|numeric|bigint|real/i.test(type);
}

export function isDateType(type: string): boolean {
  return /date|timestamp/i.test(type);
}

/**
 * Infer chart type from result metadata when the LLM does not provide an explicit visualization.
 *
 * Heuristic priority:
 * 1) time series -> line
 * 2) single category + single measure -> pie (small) or bar (large)
 * 3) single category + many measures -> stacked bar
 * 4) fallback -> table
 */
export function inferChartType(columns: ColumnMeta[], rows: unknown[]): ChartType {
  assert(Array.isArray(columns), "inferChartType requires a columns array");
  assert(Array.isArray(rows), "inferChartType requires a rows array");

  if (rows.length <= 1 || columns.length < 2) {
    return "table";
  }

  const dateColumn = columns.find((column) => isDateType(column.type));
  const numericColumns = columns.filter((column) => isNumericType(column.type));
  const categoricalColumns = columns.filter(
    (column) => !isNumericType(column.type) && !isDateType(column.type)
  );

  if (dateColumn && numericColumns.length >= 1) {
    return "line";
  }

  if (categoricalColumns.length === 1 && numericColumns.length > 1) {
    return "stacked_bar";
  }

  if (categoricalColumns.length === 1 && numericColumns.length === 1) {
    return rows.length <= 10 ? "pie" : "bar";
  }

  return "table";
}

/**
 * Infer x/y axes from result metadata. Explicit args win when valid.
 */
export function inferAxes(
  columns: ColumnMeta[],
  explicitX?: string | null,
  explicitY?: string[] | null
): { xAxis: string; yAxes: string[] } {
  assert(Array.isArray(columns), "inferAxes requires a columns array");

  const allColumnNames = new Set(columns.map((column) => column.name));
  const numericColumns = columns
    .filter((column) => isNumericType(column.type))
    .map((column) => column.name);

  const xAxis =
    (explicitX && allColumnNames.has(explicitX) ? explicitX : undefined) ??
    columns.find((column) => !isNumericType(column.type))?.name ??
    columns[0]?.name ??
    "";

  const explicitNumericYAxes =
    explicitY
      ?.filter((columnName) => allColumnNames.has(columnName))
      .filter((columnName) => columnName !== xAxis) ?? [];

  const inferredNumericYAxes = numericColumns.filter((columnName) => columnName !== xAxis);

  const yAxes =
    explicitNumericYAxes.length > 0
      ? explicitNumericYAxes
      : inferredNumericYAxes.length > 0
        ? inferredNumericYAxes
        : numericColumns.length > 0
          ? [numericColumns[0]]
          : [];

  return { xAxis, yAxes };
}

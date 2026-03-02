import { describe, expect, test } from "bun:test";
import { inferAxes, inferChartType, isDateType, isNumericType } from "./chartHeuristics";
import type { ColumnMeta } from "./types";

describe("isNumericType", () => {
  test("matches common numeric SQL types", () => {
    expect(isNumericType("INTEGER")).toBe(true);
    expect(isNumericType("DOUBLE")).toBe(true);
    expect(isNumericType("DECIMAL(10,2)")).toBe(true);
  });

  test("rejects non-numeric SQL types", () => {
    expect(isNumericType("VARCHAR")).toBe(false);
    expect(isNumericType("DATE")).toBe(false);
    expect(isNumericType("INTERVAL")).toBe(false);
  });
});

describe("isDateType", () => {
  test("matches date-ish SQL types", () => {
    expect(isDateType("DATE")).toBe(true);
    expect(isDateType("TIMESTAMP")).toBe(true);
  });

  test("rejects non-date SQL types", () => {
    expect(isDateType("DOUBLE")).toBe(false);
    expect(isDateType("VARCHAR")).toBe(false);
  });
});

describe("inferChartType", () => {
  test("returns table for empty rows", () => {
    const columns: ColumnMeta[] = [
      { name: "model", type: "VARCHAR" },
      { name: "total_cost_usd", type: "DOUBLE" },
    ];

    expect(inferChartType(columns, [])).toBe("table");
  });

  test("returns table for a single row", () => {
    const columns: ColumnMeta[] = [
      { name: "model", type: "VARCHAR" },
      { name: "total_cost_usd", type: "DOUBLE" },
    ];

    expect(inferChartType(columns, [{ model: "gpt-5", total_cost_usd: 1.23 }])).toBe("table");
  });

  test("returns line for date + numeric columns", () => {
    const columns: ColumnMeta[] = [
      { name: "date", type: "DATE" },
      { name: "total_cost_usd", type: "DOUBLE" },
    ];

    expect(
      inferChartType(columns, [
        { date: "2026-02-01", total_cost_usd: 1.2 },
        { date: "2026-02-02", total_cost_usd: 1.5 },
      ])
    ).toBe("line");
  });

  test("returns pie for categorical + numeric with small row count", () => {
    const columns: ColumnMeta[] = [
      { name: "model", type: "VARCHAR" },
      { name: "total_cost_usd", type: "DOUBLE" },
    ];

    expect(
      inferChartType(columns, [
        { model: "a", total_cost_usd: 1 },
        { model: "b", total_cost_usd: 2 },
      ])
    ).toBe("pie");
  });

  test("returns bar for categorical + numeric with large row count", () => {
    const columns: ColumnMeta[] = [
      { name: "model", type: "VARCHAR" },
      { name: "total_cost_usd", type: "DOUBLE" },
    ];

    const rows = Array.from({ length: 11 }, (_, index) => ({
      model: `model-${index + 1}`,
      total_cost_usd: index + 1,
    }));

    expect(inferChartType(columns, rows)).toBe("bar");
  });

  test("returns stacked_bar for categorical + multiple numeric columns", () => {
    const columns: ColumnMeta[] = [
      { name: "model", type: "VARCHAR" },
      { name: "input_tokens", type: "INTEGER" },
      { name: "output_tokens", type: "INTEGER" },
    ];

    expect(
      inferChartType(columns, [
        { model: "a", input_tokens: 100, output_tokens: 30 },
        { model: "b", input_tokens: 120, output_tokens: 40 },
      ])
    ).toBe("stacked_bar");
  });

  test("returns table for single-column result sets", () => {
    expect(
      inferChartType(
        [{ name: "total_tokens", type: "INTEGER" }],
        [{ total_tokens: 100 }, { total_tokens: 120 }]
      )
    ).toBe("table");
  });
});

describe("inferAxes", () => {
  test("uses explicit axes when provided and valid", () => {
    const columns: ColumnMeta[] = [
      { name: "bucket", type: "DATE" },
      { name: "input_tokens", type: "INTEGER" },
      { name: "output_tokens", type: "INTEGER" },
    ];

    expect(inferAxes(columns, "bucket", ["output_tokens"])).toEqual({
      xAxis: "bucket",
      yAxes: ["output_tokens"],
    });
  });

  test("falls back to inferred numeric y-axes when explicit y-axis hints are non-numeric", () => {
    const columns: ColumnMeta[] = [
      { name: "bucket", type: "DATE" },
      { name: "model", type: "VARCHAR" },
      { name: "total_cost_usd", type: "DOUBLE" },
    ];

    expect(inferAxes(columns, "bucket", ["model"])).toEqual({
      xAxis: "bucket",
      yAxes: ["total_cost_usd"],
    });
  });

  test("infers non-numeric x-axis and numeric y-axes", () => {
    const columns: ColumnMeta[] = [
      { name: "model", type: "VARCHAR" },
      { name: "input_tokens", type: "INTEGER" },
      { name: "output_tokens", type: "INTEGER" },
    ];

    expect(inferAxes(columns)).toEqual({
      xAxis: "model",
      yAxes: ["input_tokens", "output_tokens"],
    });
  });

  test("falls back to first column for x-axis when all columns are numeric", () => {
    const columns: ColumnMeta[] = [
      { name: "total_tokens", type: "INTEGER" },
      { name: "cached_tokens", type: "INTEGER" },
    ];

    expect(inferAxes(columns)).toEqual({
      xAxis: "total_tokens",
      yAxes: ["cached_tokens"],
    });
  });
});

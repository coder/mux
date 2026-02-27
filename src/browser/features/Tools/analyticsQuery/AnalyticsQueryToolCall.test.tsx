import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, render } from "@testing-library/react";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { AnalyticsQueryToolCall } from "./AnalyticsQueryToolCall";
import type { AnalyticsQueryResult } from "./types";

function renderWithTooltip(ui: JSX.Element) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe("AnalyticsQueryToolCall", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("renders title from args", () => {
    const result: AnalyticsQueryResult = {
      success: true,
      columns: [
        { name: "model", type: "VARCHAR" },
        { name: "total_cost_usd", type: "DOUBLE" },
      ],
      rows: [
        { model: "gpt-5", total_cost_usd: 1.25 },
        { model: "claude", total_cost_usd: 0.83 },
      ],
      truncated: false,
      rowCount: 2,
      durationMs: 18,
      visualization: "table",
      title: "Backend title",
      x_axis: "model",
      y_axis: ["total_cost_usd"],
    };

    const view = renderWithTooltip(
      <AnalyticsQueryToolCall
        args={{
          sql: "SELECT model, sum(total_cost_usd) AS total_cost_usd FROM events GROUP BY model",
          title: "Spend by model",
        }}
        result={result}
        status="completed"
      />
    );

    expect(view.getByText("Spend by model")).toBeTruthy();
  });

  test("displays row count and query duration", () => {
    const result: AnalyticsQueryResult = {
      success: true,
      columns: [
        { name: "model", type: "VARCHAR" },
        { name: "total_tokens", type: "INTEGER" },
      ],
      rows: [
        { model: "gpt-5", total_tokens: 1000 },
        { model: "claude", total_tokens: 1200 },
      ],
      truncated: false,
      rowCount: 2,
      durationMs: 37,
      visualization: "table",
      x_axis: "model",
      y_axis: ["total_tokens"],
    };

    const view = renderWithTooltip(
      <AnalyticsQueryToolCall
        args={{
          sql: "SELECT model, sum(input_tokens + output_tokens) AS total_tokens FROM events GROUP BY model",
        }}
        result={result}
        status="completed"
      />
    );

    expect(view.getByText(/2 rows/i)).toBeTruthy();
    expect(view.getByText(/37ms/i)).toBeTruthy();
  });

  test("shows tool error result", () => {
    const view = renderWithTooltip(
      <AnalyticsQueryToolCall
        args={{ sql: "SELECT * FROM events" }}
        result={{ success: false, error: "DuckDB parse error" }}
        status="failed"
      />
    );

    expect(view.getByText("DuckDB parse error")).toBeTruthy();
    expect(view.getByText("SELECT * FROM events")).toBeTruthy();
  });

  test("shows truncation warning when backend truncated rows", () => {
    const result: AnalyticsQueryResult = {
      success: true,
      columns: [
        { name: "model", type: "VARCHAR" },
        { name: "total_cost_usd", type: "DOUBLE" },
      ],
      rows: [{ model: "gpt-5", total_cost_usd: 1.2 }],
      truncated: true,
      rowCount: 500,
      durationMs: 11,
      visualization: "table",
      x_axis: "model",
      y_axis: ["total_cost_usd"],
    };

    const view = renderWithTooltip(
      <AnalyticsQueryToolCall
        args={{ sql: "SELECT model, total_cost_usd FROM events LIMIT 500" }}
        result={result}
        status="completed"
      />
    );

    expect(view.getByText(/Results truncated to 500 rows/i)).toBeTruthy();
  });

  test("renders chart selector controls", () => {
    const result: AnalyticsQueryResult = {
      success: true,
      columns: [
        { name: "model", type: "VARCHAR" },
        { name: "total_cost_usd", type: "DOUBLE" },
      ],
      rows: [
        { model: "gpt-5", total_cost_usd: 1.2 },
        { model: "claude", total_cost_usd: 0.8 },
      ],
      truncated: false,
      rowCount: 2,
      durationMs: 14,
      visualization: "table",
      x_axis: "model",
      y_axis: ["total_cost_usd"],
    };

    const view = renderWithTooltip(
      <AnalyticsQueryToolCall
        args={{ sql: "SELECT model, total_cost_usd FROM events" }}
        result={result}
      />
    );

    expect(view.getByRole("button", { name: /Table/i })).toBeTruthy();
    expect(view.getByRole("button", { name: /Bar/i })).toBeTruthy();
    expect(view.getByRole("button", { name: /Line/i })).toBeTruthy();
    expect(view.getByRole("button", { name: /Area/i })).toBeTruthy();
    expect(view.getByRole("button", { name: /Pie/i })).toBeTruthy();
    expect(view.getByRole("button", { name: /Stacked/i })).toBeTruthy();
  });
});
